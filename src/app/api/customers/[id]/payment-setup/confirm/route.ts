import { NextRequest } from 'next/server';
import { getCustomerById, updateCustomerFields, updateTaskStatus } from '@/lib/db';
import { runHubspotIntakePushWithAudit } from '@/lib/integrations/hubspot/intake-handler';

/**
 * POST /api/customers/[id]/payment-setup/confirm
 * body: { stripePriceId: string, planName: string, taskId: string }
 *
 * Called from PaymentSetupTask AFTER the client-side Stripe Elements
 * confirmSetup() succeeds. Records the customer's plan choice + marks
 * the Capture Payment Method task complete + creates the HubSpot ticket
 * in Pre-Onboarding (B2B).
 *
 * The Stripe webhook (setup_intent.succeeded) does the same task-complete
 * work as a server-side safety net (idempotent — no-op if task already
 * Completed). The HS push there is also idempotent (no-op if the customer
 * row already has hubspotTicketId), so the two paths are safe together.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json();
  const { stripePriceId, planName, taskId } = body as {
    stripePriceId?: string;
    planName?: string;
    taskId?: string;
  };

  if (!stripePriceId || !planName || !taskId) {
    return Response.json(
      { error: 'stripePriceId, planName, and taskId are required' },
      { status: 400 },
    );
  }

  const customer = await getCustomerById(id);
  if (!customer) {
    return Response.json({ error: 'Customer not found' }, { status: 404 });
  }

  // Idempotent: if already saved, return success
  if (customer.selectedStripePriceId === stripePriceId) {
    return Response.json({ ok: true, alreadyRecorded: true });
  }

  await updateCustomerFields(id, {
    selectedStripePriceId: stripePriceId,
    selectedPlanName: planName,
  });

  // Mark the task Completed (Auto 2 will then unblock dependents — Phase 3)
  await updateTaskStatus(taskId, 'Completed');

  // HubSpot ticket creation — primary, synchronous, observable.
  //
  // Was previously wired only via INTAKE_PUSH_TRIGGER_TASK inside Auto 2's
  // dynamic-imported automation chain, which has bitten us repeatedly:
  // module-cache/hot-reload gotchas on Vercel, multi-path firing (this route
  // + Stripe webhook), no audit-log breadcrumbs, errors buried in
  // console.error. Three confirmed misfires on Albany / Barbara / Albany-v2.
  //
  // Now: explicit, awaited, here in the route. Failure is silent to the
  // user (their card saved — that's the user-facing contract) but writes a
  // customer event + emails ALERTS_EMAIL so the gap is observable.
  // Auto 2's trigger remains in place as an idempotent backstop in case the
  // Stripe-webhook path fires before this route (e.g., user closes tab
  // between Stripe.confirmSetup() and this POST landing).
  await runHubspotIntakePushWithAudit(id, customer.name);

  return Response.json({ ok: true });
}
