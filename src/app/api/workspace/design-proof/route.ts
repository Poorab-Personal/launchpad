import { NextRequest } from 'next/server';
import { requireSession } from '@/lib/auth/dal';
import {
  createEvent,
  getCustomerById,
  getTaskById,
  updateCustomerFields,
  updateTaskFields,
} from '@/lib/db';
import { sendEmail } from '@/lib/email/send';

/**
 * POST /api/workspace/design-proof  —  FINALIZE step for design uploads.
 *
 * Files are uploaded directly from the browser to Vercel Blob via
 * @vercel/blob/client `upload()` keyed off the sign route
 * (`/api/workspace/design-proof/sign`). This endpoint receives the list of
 * Blob URLs the client just got back + (for send-to-customer tasks) any
 * existing drafts the user ticked, and:
 *
 *   1. Re-validates session, task ownership, and that the task belongs to
 *      the named customer (defense-in-depth — the sign route already
 *      checked, but the finalize call is independent).
 *   2. Branches by task name:
 *      - INTERNAL upload (Create Designs / Revise Design (Internal Round N)):
 *        appends the new files to Customer.designDrafts only.
 *      - SEND TO CUSTOMER (Upload Proof to Customer / Upload Revised Proof (Round N)):
 *        appends to drafts AND replaces Design Proof with the curated set
 *        (selected existing drafts + new uploads), stamps designProofsUpdatedAt.
 *   3. Marks the task Complete (Auto 2 fires downstream activations).
 *   4. Logs an audit event.
 *   5. For revision rounds, sends the design-ready email to the customer.
 *
 * Why split sign + finalize? Browsers can upload arbitrary-size files to
 * Blob directly, bypassing Vercel's 4.5MB serverless function body cap.
 * Kaushal's 33-file batch fails on the old multipart-to-function path
 * because the combined body exceeds the cap.
 */

const SEND_TO_CUSTOMER_PATTERN = /^Upload (Revised )?Proof/i;
const REVISION_UPLOAD_PATTERN = /^Upload Revised Proof \(Round/i;

type AttachmentJson = {
  id?: string;
  url: string;
  filename?: string;
  size?: number;
  contentType?: string;
};

type FinalizeBody = {
  customerId: string;
  taskId: string;
  /** New files just uploaded to Blob via the sign route. Required for internal tasks; optional for send tasks. */
  uploaded: AttachmentJson[];
  /** For send tasks only: ids of existing Drafts to include in the curated customer-facing set. */
  selectedDraftIds?: string[];
};

export async function POST(request: NextRequest) {
  const session = await requireSession();

  let body: FinalizeBody;
  try {
    body = (await request.json()) as FinalizeBody;
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const { customerId, taskId, uploaded, selectedDraftIds = [] } = body;

  if (!customerId || !taskId) {
    return Response.json(
      { error: 'Missing required fields: customerId, taskId.' },
      { status: 400 },
    );
  }
  if (!Array.isArray(uploaded)) {
    return Response.json({ error: '`uploaded` must be an array.' }, { status: 400 });
  }
  // Shape check on each entry — fail closed.
  for (const u of uploaded) {
    if (!u || typeof u.url !== 'string' || !u.url.startsWith('https://')) {
      return Response.json({ error: 'Each uploaded entry needs a valid https url.' }, { status: 400 });
    }
  }

  // Auth: same gate as the sign route. Belt + braces.
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

  // Path validation
  if (!isSendToCustomer && uploaded.length === 0) {
    return Response.json(
      { error: 'At least one file is required.' },
      { status: 400 },
    );
  }
  if (isSendToCustomer && uploaded.length === 0 && selectedDraftIds.length === 0) {
    return Response.json(
      { error: 'Pick at least one draft or upload at least one new file before sending to the customer.' },
      { status: 400 },
    );
  }

  // Build new drafts list (always append) + curated proof set (send tasks)
  const customer = await getCustomerById(customerId);
  if (!customer) {
    return Response.json({ error: 'Customer not found.' }, { status: 404 });
  }
  const existingDrafts = (customer.designDrafts ?? []) as unknown as AttachmentJson[];
  const draftsAfterUpload = [...existingDrafts, ...uploaded];

  if (!isSendToCustomer) {
    await updateCustomerFields(customerId, { designDrafts: draftsAfterUpload });
  } else {
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

  await updateTaskFields(taskId, {
    status: 'Completed',
    completedAt: new Date(),
  });

  try {
    const detail = isSendToCustomer
      ? `Sent ${uploaded.length} new + ${selectedDraftIds.length} existing draft(s) to customer.`
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

  // Revision-round upload → trigger design-ready email (initial round 0 is
  // fired by the activation event for "Review & Approve Your Brand Kit"; for
  // round 1+ that task is already Active, so we fire here).
  if (REVISION_UPLOAD_PATTERN.test(taskName)) {
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
