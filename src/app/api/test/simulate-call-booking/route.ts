import { NextRequest } from 'next/server';
import { createCall, getCustomerById } from '@/lib/airtable';
import { updateRecord } from '@/lib/airtable-client';

/**
 * POST /api/test/simulate-call-booking
 * body: { customerId: string, taskId: string }
 *
 * Test-only endpoint that simulates a Calendly booking + completion in one
 * shot. Creates a Calls record (Type=Onboarding, Status=Completed) and
 * marks the Schedule Onboarding Call task as Completed.
 *
 * If Airtable Automation 5 is configured, the Calls record creation will
 * trigger the Stripe sub creation downstream (full E2E test path).
 *
 * Gated by `LAUNCHPAD_ENABLE_TEST_ENDPOINTS=1` env var. Set it in dev
 * and Vercel Preview environments. Do NOT set it in production.
 */
export async function POST(request: NextRequest) {
  if (process.env.LAUNCHPAD_ENABLE_TEST_ENDPOINTS !== '1') {
    return new Response('Not Found', { status: 404 });
  }

  const body = await request.json().catch(() => null);
  const customerId = body?.customerId as string | undefined;
  const taskId = body?.taskId as string | undefined;
  if (!customerId || !taskId) {
    return Response.json({ error: 'customerId and taskId required' }, { status: 400 });
  }

  const customer = await getCustomerById(customerId);
  if (!customer) {
    return Response.json({ error: 'Customer not found' }, { status: 404 });
  }

  // Create a synthetic Calls record (Status=Completed up-front so Auto 5
  // fires on insert if it's set to "matches conditions" rather than "updated")
  const now = new Date().toISOString();
  const call = await createCall({
    title: `Onboarding — ${customer.name} (simulated)`,
    customer: [customerId],
    type: 'Onboarding',
    scheduledDate: now,
    status: 'Completed',
    calendlyEventUuid: `simulated-${Date.now()}`,
  });

  // Mark the task complete
  await updateRecord('Tasks', taskId, { Status: 'Completed' });

  return Response.json({
    ok: true,
    callId: call.id,
    note: 'If Airtable Automation 5 is on, it will fire on the Calls record and create the Stripe subscription.',
  });
}
