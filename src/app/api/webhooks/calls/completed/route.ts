import { NextRequest } from 'next/server';
import {
  getCallById,
  getCustomerById,
  getWorkflowTemplates,
  updateCustomerFields,
} from '@/lib/db';
import { createSubscription } from '@/lib/stripe';

/**
 * POST /api/webhooks/calls/completed
 * body: { recordId: string }
 * headers: Authorization: Bearer ${AIRTABLE_WEBHOOK_SECRET}
 *
 * Called from an Airtable automation (`scripts/airtable-automations/calls-completed-webhook.js`)
 * when a Calls record's Status changes to "Completed". This route is the only
 * place that creates a Stripe subscription for setup-intent-at-intake workflows.
 *
 * Trigger condition (defense in depth — re-checked here):
 *   Calls.Status = Completed
 *   AND Calls.Type = Onboarding
 *   AND Customer.Workflow.Payment Mode = setup-intent-at-intake
 *   AND Customer.Stripe Customer ID is set
 *   AND Customer.Selected Stripe Price ID is set
 *   AND Customer.Stripe Subscription ID is empty (idempotency guard)
 *
 * Sub creation is idempotent (Stripe idempotency-key + the empty-sub-id guard).
 * Safe to retry.
 */
export async function POST(request: NextRequest) {
  // Auth: shared secret in Authorization header
  const expectedSecret = process.env.AIRTABLE_WEBHOOK_SECRET;
  if (!expectedSecret) {
    console.error('[calls/completed] AIRTABLE_WEBHOOK_SECRET not set in env');
    return Response.json({ error: 'Webhook not configured' }, { status: 500 });
  }
  const authHeader = request.headers.get('authorization') ?? '';
  if (authHeader !== `Bearer ${expectedSecret}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const recordId = body?.recordId as string | undefined;
  if (!recordId) {
    return Response.json({ error: 'recordId is required' }, { status: 400 });
  }

  // Re-validate from Airtable (the automation's view of the record may be stale)
  const call = await getCallById(recordId);
  if (!call) {
    return Response.json({ error: 'Call not found' }, { status: 404 });
  }
  if (call.status !== 'Completed') {
    return Response.json({ skipped: true, reason: `Call status is ${call.status}, not Completed` });
  }
  if (call.type !== 'Onboarding') {
    return Response.json({ skipped: true, reason: `Call type is ${call.type}, not Onboarding` });
  }
  const customerId = call.customer[0];
  if (!customerId) {
    return Response.json({ error: 'Call has no Customer link' }, { status: 400 });
  }

  const customer = await getCustomerById(customerId);
  if (!customer) {
    return Response.json({ error: 'Customer not found' }, { status: 404 });
  }

  // Idempotency: already has a sub
  if (customer.stripeSubscriptionId) {
    return Response.json({
      skipped: true,
      reason: 'Customer already has Stripe Subscription ID',
      stripeSubscriptionId: customer.stripeSubscriptionId,
    });
  }

  // Workflow check
  const templates = await getWorkflowTemplates(customer.workflowKey);
  const paymentMode = templates[0]?.paymentMode;
  if (paymentMode !== 'setup-intent-at-intake') {
    return Response.json({
      skipped: true,
      reason: `Workflow ${customer.workflowKey} payment mode is ${paymentMode ?? '(none)'}, not setup-intent-at-intake`,
    });
  }

  // Required customer state
  if (!customer.stripeCustomerId) {
    return Response.json(
      { error: 'Customer has no Stripe Customer ID — cannot create subscription' },
      { status: 400 },
    );
  }
  if (!customer.selectedStripePriceId) {
    return Response.json(
      {
        error:
          'Customer has no Selected Stripe Price ID — Capture Payment Method task should have set this. Check that the customer completed the payment-setup flow.',
      },
      { status: 400 },
    );
  }

  const trialDays = templates[0]?.trialDays ?? 0;

  const subscription = await createSubscription({
    airtableCustomerId: customer.id,
    stripeCustomerId: customer.stripeCustomerId,
    stripePriceId: customer.selectedStripePriceId,
    trialDays,
  });

  await updateCustomerFields(customer.id, {
    stripeSubscriptionId: subscription.id,
    subscriptionStatus: subscription.status === 'trialing' ? 'Trial' : 'Active',
  });

  console.log(
    `[calls/completed] Created sub ${subscription.id} (status=${subscription.status}, trial=${trialDays}d) for customer ${customer.id}`,
  );

  return Response.json({
    ok: true,
    stripeSubscriptionId: subscription.id,
    status: subscription.status,
    trialEnd: subscription.trial_end,
  });
}
