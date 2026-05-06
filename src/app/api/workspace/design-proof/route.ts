import { NextRequest } from 'next/server';
import { put } from '@vercel/blob';
import { requireSession } from '@/lib/auth/dal';
import { getRecord, updateRecord } from '@/lib/airtable-client';
import { createEvent } from '@/lib/airtable';

const MAX_FILE_SIZE = 3_500_000; // 3.5MB

function linkedId(field: unknown): string | null {
  if (!Array.isArray(field) || field.length === 0) return null;
  const first = field[0];
  return typeof first === 'string' ? first : (first as { id: string })?.id ?? null;
}

/**
 * Upload a design proof from the workspace.
 * - Verifies session
 * - Uploads file to Vercel Blob
 * - Writes to Customer.Design Proof (overwrites previous)
 * - Marks the related "Upload Proof to Customer" (or revised round) task complete
 *   so Airtable Auto 2 activates the customer review task.
 */
export async function POST(request: NextRequest) {
  const session = await requireSession();

  const formData = await request.formData();
  const file = formData.get('file') as File | null;
  const customerId = formData.get('customerId') as string | null;
  const taskId = formData.get('taskId') as string | null;

  if (!file || !customerId || !taskId) {
    return Response.json(
      { error: 'Missing required fields: file, customerId, taskId' },
      { status: 400 },
    );
  }

  if (file.size > MAX_FILE_SIZE) {
    return Response.json(
      {
        error: `File too large (${(file.size / 1_000_000).toFixed(1)}MB). Maximum is 3.5MB.`,
      },
      { status: 413 },
    );
  }

  // Verify the task is assigned to the current user (or admin)
  const task = await getRecord('Tasks', taskId);
  const assignedTo = task.fields['Assigned To'];
  const assignedIds = Array.isArray(assignedTo)
    ? assignedTo.map((a) => (typeof a === 'string' ? a : (a as { id: string }).id))
    : [];

  if (session.role !== 'Admin' && !assignedIds.includes(session.memberId)) {
    return Response.json({ error: 'Not assigned to you.' }, { status: 403 });
  }

  if (linkedId(task.fields['Customer']) !== customerId) {
    return Response.json(
      { error: 'Task does not belong to this customer.' },
      { status: 400 },
    );
  }

  // Upload to Blob with random suffix — prevents collisions when the same
  // filename is uploaded multiple times (e.g. designer iterating on proof.pdf).
  const blob = await put(file.name, file, { access: 'public', addRandomSuffix: true });

  // Append to Customer.Design Proof — preserves history of all proof revisions.
  // Newest is last; customer-portal ProofTask reads the latest.
  const customerRecord = await getRecord('Customers', customerId);
  const existingProofs = customerRecord.fields['Design Proof'];
  const proofs = Array.isArray(existingProofs) ? existingProofs : [];
  await updateRecord('Customers', customerId, {
    'Design Proof': [...proofs, { url: blob.url, filename: file.name }],
  });

  // Mark task complete — triggers Auto 2 to activate Review & Approve customer task
  await updateRecord('Tasks', taskId, {
    Status: 'Completed',
    'Completed At': new Date().toISOString(),
  });

  // Audit event — non-fatal if it fails (e.g. select-option permission errors).
  // The file was uploaded and the task was marked complete; don't punish the user
  // for an audit-log issue.
  try {
    await createEvent(
      customerId,
      'Task Completed',
      'Team Member',
      `Design proof uploaded (${file.name}) and task marked complete.`,
      taskId,
      session.memberId,
    );
  } catch (err) {
    console.warn('Event log failed (non-fatal):', err);
  }

  return Response.json({
    ok: true,
    url: blob.url,
    filename: file.name,
  });
}
