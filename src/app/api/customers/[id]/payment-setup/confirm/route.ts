import { NextRequest } from 'next/server';
import { getCustomerById, updateCustomerFields, updateTaskStatus } from '@/lib/db';
import { db } from '@/db';
import * as schema from '@/db/schema';
import { pushCustomerIntakeToHubSpot } from '@/lib/integrations/hubspot/intake-handler';
import { sendAlertEmail } from '@/lib/email/send';

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
  await runHubspotIntakePush(id, customer.name);

  return Response.json({ ok: true });
}

async function runHubspotIntakePush(customerId: string, customerName: string) {
  try {
    const result = await pushCustomerIntakeToHubSpot(customerId);

    if (result.kind === 'pushed') {
      await db.insert(schema.events).values({
        customerId,
        eventType: 'HS Ticket Created',
        actorType: 'System',
        details: `HubSpot Ticket ${result.ticketId} created (Contact ${result.contactId}${result.contactWasNew ? ' [new]' : ''}).`,
      });
    } else if (result.kind === 'skipped') {
      await db.insert(schema.events).values({
        customerId,
        eventType: 'HS Ticket Push Skipped',
        actorType: 'System',
        details: result.reason,
      });
    } else {
      // result.kind === 'error' — push returned a soft failure (HS API said
      // no, brokerage misconfigured, etc.). Audit + alert.
      await db.insert(schema.events).values({
        customerId,
        eventType: 'HS Ticket Push Failed',
        actorType: 'System',
        details: result.error,
      });
      void sendOpsAlert(customerId, customerName, result.error);
    }
  } catch (err) {
    // Threw (network / bug / etc.). Audit + alert. Never surface to user.
    const message = err instanceof Error ? err.message : String(err);
    await db.insert(schema.events).values({
      customerId,
      eventType: 'HS Ticket Push Threw',
      actorType: 'System',
      details: message.slice(0, 1000),
    });
    void sendOpsAlert(customerId, customerName, message);
  }
}

async function sendOpsAlert(customerId: string, customerName: string, reason: string) {
  try {
    await sendAlertEmail({
      // Temporary: route HS-push failures to poorab@rejig.ai until there's a
      // proper internal ops inbox. ALERTS_EMAIL env wins if set in Vercel.
      to: process.env.ALERTS_EMAIL ?? 'poorab@rejig.ai',
      subject: `[LaunchPad] HS Ticket Push Failed: ${customerName}`,
      text: [
        `Customer: ${customerName}`,
        `Customer ID: ${customerId}`,
        `Reason: ${reason}`,
        ``,
        `The customer saved their card successfully. The HubSpot ticket was NOT created.`,
        `Investigate: /workspace/customers/${customerId}`,
      ].join('\n'),
    });
  } catch (err) {
    // Don't let an alert-email failure mask the original problem. Log only.
    console.error('[confirm route] failed to send ops alert', err);
  }
}
