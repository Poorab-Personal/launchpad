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
import { resolveTempPassword } from '@/lib/temp-password';

/**
 * Send the credentials email and complete the "Send Credentials" task.
 * Requires Customer.Platform Email to already be set (Create Account step).
 *
 * Marking the task Completed triggers Airtable Auto 2 to activate the next
 * dependent tasks (e.g. "Book Onboarding Call").
 */
export async function POST(request: NextRequest) {
  const session = await requireSession();

  let body: { taskId?: string; customerId?: string; password?: string };
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

  // The Account Creator can edit the temp password inline before sending; we
  // trust the submitted value (route is already role- + assignment-gated) but
  // guard against a blank/absurd send. The exact value is what we email AND
  // persist, so every downstream surface matches what actually went out.
  const password = (body.password ?? '').trim();
  if (!password) {
    return Response.json({ error: 'Temp password cannot be empty.' }, { status: 400 });
  }
  if (password.length < 8 || password.length > 128) {
    return Response.json(
      { error: 'Temp password must be between 8 and 128 characters.' },
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

  const portalBase = customer.portalBaseUrl || 'https://onboarding.rejig.ai';
  const portalUrl = `${portalBase}/r/${customer.accessToken}`;
  const firstName = customer.name.trim().split(/\s+/)[0] || 'there';

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
  // the status change to activate dependent tasks. Persist the exact password
  // that went out so the email, portal Sign In task, and Handy page all read
  // back the same value (via resolveTempPassword).
  await updateTaskFields(taskId, {
    status: 'Completed',
    completedAt: new Date(),
  });
  await updateCustomerFields(customerId, {
    credentialsSent: true,
    tempPassword: password,
  });

  // Non-fatal audit event. Flag when the AC edited away from the derived
  // default — helps future "why is the password X?" debugging.
  const derivedDefault = resolveTempPassword({
    tempPassword: null,
    name: customer.name,
    platformEmail: customer.platformEmail,
  });
  const editedNote =
    password === derivedDefault ? '' : ' (edited from derived default)';
  try {
    await createEvent(
      customerId,
      'Task Completed',
      'Team Member',
      `Credentials email sent to ${customer.contactEmail}${editedNote}.`,
      taskId,
      session.memberId,
    );
  } catch (err) {
    console.warn('Event log failed (non-fatal):', err);
  }

  return Response.json({ ok: true });
}
