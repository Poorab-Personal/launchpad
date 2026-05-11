import { NextRequest } from 'next/server';
import { put } from '@vercel/blob';
import { requireSession } from '@/lib/auth/dal';
import {
  createEvent,
  getCustomerById,
  getTaskById,
  updateCustomerFields,
  updateTaskFields,
} from '@/lib/db';
import { sendEmail } from '@/lib/email/send';

const MAX_FILE_SIZE = 3_500_000; // 3.5MB

/** Send-to-customer task names. Internal tasks (Create Designs / Revise Design (Internal Round N)) are everything else that hits this route. */
const SEND_TO_CUSTOMER_PATTERN = /^Upload (Revised )?Proof/i;

type AttachmentJson = {
  id?: string;
  url: string;
  filename?: string;
  size?: number;
  contentType?: string;
};

/**
 * Workspace design-upload endpoint. Branches by task name:
 *
 * 1. INTERNAL upload tasks (Create Designs, Revise Design (Internal Round N)):
 *    - All files append to Customer.Design Drafts (work-in-progress, customer never sees)
 *    - Mark task Complete
 *
 * 2. SEND TO CUSTOMER tasks (Upload Proof to Customer, Upload Revised Proof (Round N)):
 *    - Body may include both new files AND `selectedDraftId` form fields with
 *      Airtable attachment ids of existing Drafts to include in the curated set
 *    - New files upload to Blob and append to Drafts
 *    - Customer.Design Proof is REPLACED with: selected-existing-drafts + just-uploaded-new
 *    - Stamp Design Proofs Updated At (drives the "Updated N days ago" customer-portal label)
 *    - Mark task Complete; if it's a revision round, also fire the design-ready email
 */
export async function POST(request: NextRequest) {
  const session = await requireSession();

  const formData = await request.formData();
  const newFiles = formData.getAll('file').filter((v): v is File => v instanceof File);
  const selectedDraftIds = formData
    .getAll('selectedDraftId')
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  const customerId = formData.get('customerId') as string | null;
  const taskId = formData.get('taskId') as string | null;

  if (!customerId || !taskId) {
    return Response.json(
      { error: 'Missing required fields: customerId, taskId' },
      { status: 400 },
    );
  }

  // Per-file size guard. Reject the whole batch on the first oversize file —
  // we don't want to half-upload and leave the designer guessing what made it.
  for (const f of newFiles) {
    if (f.size > MAX_FILE_SIZE) {
      return Response.json(
        { error: `${f.name} is ${(f.size / 1_000_000).toFixed(1)}MB. Max is 3.5MB per file.` },
        { status: 413 },
      );
    }
  }

  // Auth: must be assigned to this task (or admin)
  const task = await getTaskById(taskId);
  if (!task) {
    return Response.json({ error: 'Task not found.' }, { status: 404 });
  }
  if (session.role !== 'Admin' && !task.assignedTo.includes(session.memberId)) {
    return Response.json({ error: 'Not assigned to you.' }, { status: 403 });
  }
  if (task.customer[0] !== customerId) {
    return Response.json({ error: 'Task does not belong to this customer.' }, { status: 400 });
  }

  const taskName = task.taskName;
  const isSendToCustomer = SEND_TO_CUSTOMER_PATTERN.test(taskName);

  // Path validation. Internal: must have at least one file. Send: must have at
  // least one item in the final set (selected existing drafts OR new uploads).
  if (!isSendToCustomer && newFiles.length === 0) {
    return Response.json({ error: 'At least one file is required.' }, { status: 400 });
  }
  if (isSendToCustomer && newFiles.length === 0 && selectedDraftIds.length === 0) {
    return Response.json(
      { error: 'Pick at least one draft or upload at least one new file before sending to the customer.' },
      { status: 400 },
    );
  }

  // Upload any new files to Blob in parallel. Random suffix prevents
  // collisions when the same filename is uploaded again.
  const uploaded: AttachmentJson[] = await Promise.all(
    newFiles.map(async (f) => {
      const blob = await put(f.name, f, { access: 'public', addRandomSuffix: true });
      return { url: blob.url, filename: f.name, size: f.size, contentType: f.type };
    }),
  );

  // Always append uploads to Drafts (canonical store of work-in-progress).
  const customer = await getCustomerById(customerId);
  if (!customer) {
    return Response.json({ error: 'Customer not found.' }, { status: 404 });
  }
  const existingDrafts = (customer.designDrafts ?? []) as unknown as AttachmentJson[];
  const draftsAfterUpload = [...existingDrafts, ...uploaded];

  if (!isSendToCustomer) {
    // INTERNAL path — Drafts only, no Design Proof touch, no Updated At stamp.
    await updateCustomerFields(customerId, { designDrafts: draftsAfterUpload });
  } else {
    // SEND path — also build the curated set and replace Design Proof.
    // Selected drafts come from the EXISTING drafts (pre-upload). Match by id.
    const selectedSet = new Set(selectedDraftIds);
    const selectedDrafts = existingDrafts.filter((d) => d.id && selectedSet.has(d.id));
    const customerFacingSet: AttachmentJson[] = [
      ...selectedDrafts.map((d) => ({ url: d.url, filename: d.filename, size: d.size, contentType: d.contentType })),
      ...uploaded,
    ];

    if (customerFacingSet.length === 0) {
      return Response.json(
        { error: 'Refusing to send empty proof set to customer.' },
        { status: 400 },
      );
    }

    await updateCustomerFields(customerId, {
      designDrafts: draftsAfterUpload,
      designProof: customerFacingSet,
      designProofsUpdatedAt: new Date(),
    });
  }

  // Mark task complete — Auto 2 (Phase 3) activates downstream tasks
  await updateTaskFields(taskId, {
    status: 'Completed',
    completedAt: new Date(),
  });

  // Audit event — non-fatal.
  try {
    const detail = isSendToCustomer
      ? `Sent ${newFiles.length} new + ${selectedDraftIds.length} existing draft(s) to customer.`
      : `Uploaded ${uploaded.length} draft file(s).`;
    await createEvent(
      customerId,
      'Task Completed',
      'Team Member',
      `${taskName}: ${detail}`,
      taskId,
      session.memberId,
    );
  } catch (err) {
    console.warn('Event log failed (non-fatal):', err);
  }

  // Customer-facing revision rounds: send the design-ready email directly.
  // Round 0 (initial Upload Proof to Customer) is handled by the Airtable
  // automation that fires when "Review & Approve Your Brand Kit" activates.
  // For rounds 1+, that customer task is already Active so no activation event
  // fires — trigger the email here instead.
  const isRevisionUpload = /^Upload Revised Proof \(Round/i.test(taskName);
  if (isRevisionUpload) {
    try {
      if (customer.contactEmail) {
        const portalBase = customer.portalBaseUrl || 'https://launchpad-indol-ten.vercel.app';
        const portalUrl = `${portalBase}/r/${customer.accessToken}`;
        const fname = customer.name.trim().split(/\s+/)[0] || 'there';
        await sendEmail({
          template: 'design-ready',
          to: customer.contactEmail,
          data: { firstName: fname, portalUrl },
        });
      }
    } catch (err) {
      console.warn('Revision email send failed (non-fatal):', err);
    }
  }

  return Response.json({
    ok: true,
    isSendToCustomer,
    newCount: uploaded.length,
    selectedCount: selectedDraftIds.length,
  });
}
