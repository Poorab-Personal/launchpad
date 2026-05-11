import { NextRequest } from 'next/server';
import { put } from '@vercel/blob';
import { requireSession } from '@/lib/auth/dal';
import { getRecord, updateRecord } from '@/lib/airtable-client';
import { createEvent, getCustomerById } from '@/lib/db';
import { sendEmail } from '@/lib/email/send';

const MAX_FILE_SIZE = 3_500_000; // 3.5MB

/** Send-to-customer task names. Internal tasks (Create Designs / Revise Design (Internal Round N)) are everything else that hits this route. */
const SEND_TO_CUSTOMER_PATTERN = /^Upload (Revised )?Proof/i;

type AirtableAttachment = { id?: string; url: string; filename?: string; type?: string; size?: number };

function linkedId(field: unknown): string | null {
  if (!Array.isArray(field) || field.length === 0) return null;
  const first = field[0];
  return typeof first === 'string' ? first : (first as { id: string })?.id ?? null;
}

function isAttachmentArray(v: unknown): v is AirtableAttachment[] {
  return Array.isArray(v);
}

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
  const task = await getRecord('Tasks', taskId);
  const assignedTo = task.fields['Assigned To'];
  const assignedIds = Array.isArray(assignedTo)
    ? assignedTo.map((a) => (typeof a === 'string' ? a : (a as { id: string }).id))
    : [];
  if (session.role !== 'Admin' && !assignedIds.includes(session.memberId)) {
    return Response.json({ error: 'Not assigned to you.' }, { status: 403 });
  }
  if (linkedId(task.fields['Customer']) !== customerId) {
    return Response.json({ error: 'Task does not belong to this customer.' }, { status: 400 });
  }

  const taskName = (task.fields['Task Name'] as string) ?? '';
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
  const uploaded = await Promise.all(
    newFiles.map(async (f) => {
      const blob = await put(f.name, f, { access: 'public', addRandomSuffix: true });
      return { url: blob.url, filename: f.name } as AirtableAttachment;
    }),
  );

  // Always append uploads to Drafts (canonical store of work-in-progress).
  const customerRecord = await getRecord('Customers', customerId);
  const existingDrafts = isAttachmentArray(customerRecord.fields['Design Drafts'])
    ? (customerRecord.fields['Design Drafts'] as AirtableAttachment[])
    : [];
  const draftsAfterUpload = [...existingDrafts, ...uploaded];

  if (!isSendToCustomer) {
    // INTERNAL path — Drafts only, no Design Proof touch, no Updated At stamp.
    await updateRecord('Customers', customerId, {
      'Design Drafts': draftsAfterUpload,
    });
  } else {
    // SEND path — also build the curated set and replace Design Proof.
    // Selected drafts come from the EXISTING drafts (pre-upload). Match by id.
    // Preserve original upload order (don't sort by tick order).
    const selectedSet = new Set(selectedDraftIds);
    const selectedDrafts = existingDrafts.filter(
      (d) => d.id && selectedSet.has(d.id),
    );
    // Strip the Airtable id when re-asserting attachments — Airtable expects
    // {url, filename} for new attachments. Keeping ids is fine for re-attaching
    // existing files but stripping is safer and works either way.
    const customerFacingSet: AirtableAttachment[] = [
      ...selectedDrafts.map((d) => ({ url: d.url, filename: d.filename })),
      ...uploaded,
    ];

    if (customerFacingSet.length === 0) {
      // Defensive — checked above, but belt + suspenders so we never overwrite Design Proof with [].
      return Response.json(
        { error: 'Refusing to send empty proof set to customer.' },
        { status: 400 },
      );
    }

    await updateRecord('Customers', customerId, {
      'Design Drafts': draftsAfterUpload,
      'Design Proof': customerFacingSet,
      'Design Proofs Updated At': new Date().toISOString(),
    });
  }

  // Mark task complete — triggers Auto 2 to activate downstream tasks
  await updateRecord('Tasks', taskId, {
    Status: 'Completed',
    'Completed At': new Date().toISOString(),
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
      const customer = await getCustomerById(customerId);
      if (customer && customer.contactEmail) {
        const portalBase = customer.portalBaseUrl || 'https://launchpad-indol-ten.vercel.app';
        const portalUrl = `${portalBase}/r/${customer.id}`;
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
