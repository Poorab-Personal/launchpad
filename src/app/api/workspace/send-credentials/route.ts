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
import { tempPasswordFromName } from '@/lib/temp-password';

/**
 * Send the credentials email and complete the "Send Credentials" task.
 * Requires Customer.Platform Email to already be set (Create Account step).
 *
 * Marking the task Completed triggers Airtable Auto 2 to activate the next
 * dependent tasks (e.g. "Book Onboarding Call").
 */
export async function POST(request: NextRequest) {
  const session = await requireSession();

  let body: { taskId?: string; customerId?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const { taskId, customerId } = body;
  if (!taskId || !customerId) {
    return Response.json(
      { error: 'Missing required fields: taskId, customerId' },
      { status: 400 },
    );
  }

  // Verify task assignment.
  const task = await getTaskById(taskId);
  if (!task) {
    return Response.json({ error: 'Task not found.' }, { status: 404 });
  }
  if (
    session.role !== 'Admin' &&
    !(session.role === 'Account Creator' && task.assignedTo.includes(session.memberId))
  ) {
    return Response.json({ error: 'Not assigned to you.' }, { status: 403 });
  }

  if (task.customer[0] !== customerId) {
    return Response.json(
      { error: 'Task does not belong to this customer.' },
      { status: 400 },
    );
  }

  // Re-fetch customer so we use authoritative platform email + portal URL.
  const customer = await getCustomerById(customerId);
  if (!customer) {
    return Response.json({ error: 'Customer not found.' }, { status: 404 });
  }
  if (!customer.platformEmail) {
    return Response.json(
      {
        error:
          'Customer has no platform email yet. Complete the Create Account step first.',
      },
      { status: 409 },
    );
  }
  if (!customer.contactEmail) {
    return Response.json(
      { error: 'Customer has no contact email — cannot send credentials.' },
      { status: 409 },
    );
  }

  const portalBase = customer.portalBaseUrl || 'https://launchpad-indol-ten.vercel.app';
  const portalUrl = `${portalBase}/r/${customer.id}`;
  const firstName = customer.name.trim().split(/\s+/)[0] || 'there';
  const password = tempPasswordFromName(customer.name);

  await sendEmail({
    template: 'credentials-sent',
    to: customer.contactEmail,
    data: {
      firstName,
      portalUrl,
      platformEmail: customer.platformEmail,
      password,
      callDate: customer.callDate || '',
    },
  });

  // Mark task complete + flip flag on customer. Auto 2 (Phase 3) picks up
  // the status change to activate dependent tasks.
  await updateTaskFields(taskId, {
    status: 'Completed',
    completedAt: new Date(),
  });
  await updateCustomerFields(customerId, { credentialsSent: true });

  // Non-fatal audit event.
  try {
    await createEvent(
      customerId,
      'Task Completed',
      'Team Member',
      `Credentials email sent to ${customer.contactEmail}.`,
      taskId,
      session.memberId,
    );
  } catch (err) {
    console.warn('Event log failed (non-fatal):', err);
  }

  return Response.json({ ok: true });
}
