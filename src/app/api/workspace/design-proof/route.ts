import { NextRequest } from 'next/server';
import { put } from '@vercel/blob';
import { requireSession } from '@/lib/auth/dal';
import { getRecord, updateRecord } from '@/lib/airtable-client';
import { createEvent, getCustomerById } from '@/lib/airtable';
import { sendEmail } from '@/lib/email/send';

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
  const files = formData.getAll('file').filter((v): v is File => v instanceof File);
  const customerId = formData.get('customerId') as string | null;
  const taskId = formData.get('taskId') as string | null;

  if (files.length === 0 || !customerId || !taskId) {
    return Response.json(
      { error: 'Missing required fields: at least one file, customerId, taskId' },
      { status: 400 },
    );
  }

  // Per-file size guard. Reject the whole batch on the first oversize file —
  // we don't want to half-upload and leave the designer guessing what made it.
  for (const f of files) {
    if (f.size > MAX_FILE_SIZE) {
      return Response.json(
        {
          error: `${f.name} is ${(f.size / 1_000_000).toFixed(1)}MB. Max is 3.5MB per file.`,
        },
        { status: 413 },
      );
    }
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

  // Upload all files in parallel. Random suffix prevents collisions when the
  // same filename is uploaded again (e.g. designer iterating on proof.pdf).
  const uploaded = await Promise.all(
    files.map(async (f) => {
      const blob = await put(f.name, f, { access: 'public', addRandomSuffix: true });
      return { url: blob.url, filename: f.name };
    }),
  );

  // Append all to Customer.Design Proof — preserves history of all proof revisions.
  // Customer-portal ProofTask renders the full set as a gallery.
  const customerRecord = await getRecord('Customers', customerId);
  const existingProofs = customerRecord.fields['Design Proof'];
  const proofs = Array.isArray(existingProofs) ? existingProofs : [];
  await updateRecord('Customers', customerId, {
    'Design Proof': [...proofs, ...uploaded],
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
    const fileNames = uploaded.map((u) => u.filename).join(', ');
    const fileWord = uploaded.length === 1 ? 'proof' : 'proofs';
    await createEvent(
      customerId,
      'Task Completed',
      'Team Member',
      `Design ${fileWord} uploaded (${fileNames}) and task marked complete.`,
      taskId,
      session.memberId,
    );
  } catch (err) {
    console.warn('Event log failed (non-fatal):', err);
  }

  // Revision rounds: send the design-ready email directly.
  // Round 0 (initial "Upload Proof to Customer") is handled by the Airtable
  // automation that fires when "Review & Approve Your Brand Kit" activates.
  // For rounds 1+, that customer task is already Active so no activation
  // event fires — we trigger the email here instead. Non-fatal on failure.
  const taskName = (task.fields['Task Name'] as string) ?? '';
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
    uploaded,
    count: uploaded.length,
  });
}
