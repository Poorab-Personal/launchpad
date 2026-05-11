/**
 * Auto 8 port — create Stripe subscription when an Onboarding call completes.
 *
 * Trigger conditions (re-checked here as defense in depth):
 *   Calls.Status = Completed
 *   AND Calls.Type = Onboarding
 *   AND Customer.workflowTemplates[0].paymentMode = 'setup-intent-at-intake'
 *   AND Customer.stripeCustomerId is set
 *   AND Customer.selectedStripePriceId is set
 *   AND Customer.stripeSubscriptionId is empty (idempotency guard)
 *
 * Fired by:
 *   - updateCall() helper in src/lib/db.ts when call.status transitions
 *     to 'Completed' AND type='Onboarding'
 *   - the legacy /api/webhooks/calls/completed route (which Airtable Auto 8
 *     still POSTs to during the cutover window — same logic shared)
 */
import {
  getCallById,
  getCustomerById,
  getWorkflowTemplates,
  updateCustomerFields,
} from '@/lib/db';
import { createSubscription } from '@/lib/stripe';

export type HandleCallCompletedResult =
  | { kind: 'created'; subscriptionId: string; status: string; trialEnd: number | null }
  | { kind: 'skipped'; reason: string }
  | { kind: 'error'; error: string; status?: number };

export async function handleCallCompleted(
  callId: string,
): Promise<HandleCallCompletedResult> {
  const call = await getCallById(callId);
  if (!call) return { kind: 'error', error: 'Call not found', status: 404 };
  if (call.status !== 'Completed') {
    return { kind: 'skipped', reason: `Call status is ${call.status}, not Completed` };
  }
  if (call.type !== 'Onboarding') {
    return { kind: 'skipped', reason: `Call type is ${call.type}, not Onboarding` };
  }

  const customerId = call.customer[0];
  if (!customerId) return { kind: 'error', error: 'Call has no Customer link', status: 400 };

  const customer = await getCustomerById(customerId);
  if (!customer) return { kind: 'error', error: 'Customer not found', status: 404 };

  // Idempotency: already has a sub
  if (customer.stripeSubscriptionId) {
    return {
      kind: 'skipped',
      reason: `Customer already has Stripe Subscription ID ${customer.stripeSubscriptionId}`,
    };
  }

  const templates = await getWorkflowTemplates(customer.workflowKey);
  const paymentMode = templates[0]?.paymentMode;
  if (paymentMode !== 'setup-intent-at-intake') {
    return {
      kind: 'skipped',
      reason: `Workflow ${customer.workflowKey} payment mode is ${paymentMode ?? '(none)'}, not setup-intent-at-intake`,
    };
  }

  if (!customer.stripeCustomerId) {
    return {
      kind: 'error',
      error: 'Customer has no Stripe Customer ID — cannot create subscription',
      status: 400,
    };
  }
  if (!customer.selectedStripePriceId) {
    return {
      kind: 'error',
      error:
        'Customer has no Selected Stripe Price ID — Capture Payment Method task should have set this.',
      status: 400,
    };
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
    `[handleCallCompleted] Created sub ${subscription.id} (status=${subscription.status}, trial=${trialDays}d) for customer ${customer.id}`,
  );

  return {
    kind: 'created',
    subscriptionId: subscription.id,
    status: subscription.status,
    trialEnd: subscription.trial_end,
  };
}
