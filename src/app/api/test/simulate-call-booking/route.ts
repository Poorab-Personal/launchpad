import { NextRequest } from 'next/server';
import {
  createCall,
  getCustomerById,
  getTeamMembersByRole,
} from '@/lib/airtable';
import { getRecords, updateRecord } from '@/lib/airtable-client';

/**
 * POST /api/test/simulate-call-booking
 * body: { customerId: string, taskId: string }
 *
 * Simulates a Calendly Onboarding booking without the iframe. Produces the
 * same customer/call state the real Calendly webhook produces, so the call
 * lands in the CSM queue ready to be marked complete from the workspace
 * after the (simulated) call date. Mirrors the bookkeeping in
 * `src/app/api/webhooks/calendly/route.ts`.
 *
 * What it does:
 *   1. Picks a scheduled date 3 business days from now at 10:00 local-ish
 *      (UTC; close enough for testing).
 *   2. Resolves a CSM — prefers the Team Member flagged Default=true,
 *      else the first active CSM. May be null if no CSMs exist.
 *   3. Creates a Calls row (Type=Onboarding, Status=Scheduled) with the
 *      CSM linked. Reusable across simulate runs — uuid is per-call.
 *   4. Stamps Customer.Call Booked = true, Customer.Call Date, and
 *      Customer.CSM Assigned (the fields the portal + workspace read).
 *   5. Marks the Schedule Onboarding Call task Completed (Auto 2 then
 *      activates Mark Onboarding Call Complete, which is reassigned to
 *      the CSM in step 6).
 *   6. Re-routes the existing Mark Onboarding Call Complete task to the
 *      resolved CSM (Auto 1 originally assigned it to the default).
 *
 * Differs from prior behavior: previously the call was created with
 * Status=Completed which immediately triggered downstream Stripe sub
 * creation. That made it impossible to test the CSM queue flow — the
 * call was already history before the CSM could see it. The Stripe path
 * can still be tested by marking the call complete from the workspace.
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

  // ── 1. Compute a scheduled date 3 business days out ─────────────
  const scheduledAt = nBusinessDaysFromNow(3);
  const scheduledIso = scheduledAt.toISOString();

  // ── 2. Resolve CSM (default flagged, else first active) ─────────
  const csms = await getTeamMembersByRole('CSM');
  const csm = csms.find((m) => m.isDefault) ?? csms[0] ?? null;

  // ── 3. Create the Calls row (Status=Scheduled) ─────────────────
  const call = await createCall({
    title: `Onboarding — ${customer.name} (simulated)`,
    customer: [customerId],
    type: 'Onboarding',
    scheduledDate: scheduledIso,
    status: 'Scheduled',
    calendlyEventUuid: `simulated-${Date.now()}`,
    notes: 'Created via /api/test/simulate-call-booking — test endpoint.',
    ...(csm ? { csm: [csm.id] } : {}),
  });

  // ── 4. Stamp customer flags (Call Booked / Date / CSM Assigned) ─
  const customerUpdate: Record<string, unknown> = {
    'Call Booked': true,
    'Call Date': scheduledIso,
  };
  if (csm) customerUpdate['CSM Assigned'] = [csm.id];
  await updateRecord('Customers', customerId, customerUpdate);

  // ── 5. Mark Schedule task Completed ────────────────────────────
  await updateRecord('Tasks', taskId, {
    Status: 'Completed',
    'Completed At': new Date().toISOString(),
  });

  // ── 6. Re-route Mark Onboarding Call Complete to the CSM ───────
  // Auto 1 assigned this to the default at customer-creation. Match
  // the Calendly webhook which re-routes to the actual host so the
  // task lands in their queue. Skip if already Completed.
  let reroutedMarkTaskId: string | null = null;
  if (csm) {
    const allTasks = await getRecords('Tasks');
    const markTask = allTasks.find((t) => {
      const linked = t.fields['Customer'];
      const isCustomer = Array.isArray(linked) && JSON.stringify(linked).includes(customerId);
      const name = (t.fields['Task Name'] as string) ?? '';
      const status =
        typeof t.fields['Status'] === 'object'
          ? (t.fields['Status'] as { name: string }).name
          : t.fields['Status'];
      return isCustomer && name === 'Mark Onboarding Call Complete' && status !== 'Completed';
    });
    if (markTask) {
      await updateRecord('Tasks', markTask.id, { 'Assigned To': [csm.id] });
      reroutedMarkTaskId = markTask.id;
    }
  }

  return Response.json({
    ok: true,
    callId: call.id,
    scheduledDate: scheduledIso,
    csmId: csm?.id ?? null,
    csmName: csm?.name ?? null,
    reroutedMarkTaskId,
    note: 'Call is Scheduled (not Completed). Mark it complete from the workspace to test the post-call Stripe flow.',
  });
}

/**
 * Returns a Date n business days from now (skipping Sat/Sun). Time set to
 * 17:00 UTC ≈ 10am Pacific / 1pm Eastern — a "normal looking" call slot.
 * Good enough for a test endpoint; not trying to honor real CSM availability.
 */
function nBusinessDaysFromNow(n: number): Date {
  const d = new Date();
  let added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  d.setUTCHours(17, 0, 0, 0);
  return d;
}
