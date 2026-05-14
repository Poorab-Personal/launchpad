/**
 * Auto 8 port — create Stripe subscription for setup-intent-at-intake
 * workflows (B2B-Keyes today) when the onboarding flow signals "the call
 * has happened, time to start billing."
 *
 * Trigger conditions (defense in depth — re-checked here):
 *   Customer.workflow_template[0].paymentMode = 'setup-intent-at-intake'
 *   AND Customer.stripeCustomerId is set
 *   AND Customer.selectedStripePriceId is set
 *   AND Customer.stripeSubscriptionId is empty (idempotency guard)
 *
 * Fired by:
 *   - The HubSpot Ticket pipeline-stage webhook when a ticket moves to
 *     'Active' (the primary path post-Phase-1; see
 *     docs/plans/post-launch-migration.md Q6 belts-and-suspenders A).
 *   - handleCallCompleted() (legacy Call-based path — kept for the
 *     legacy Calendly webhook + workspace "Mark Onboarding Call Complete"
 *     code paths that still exist for in-flight customers).
 *
 * Idempotent on the Stripe side (Stripe rejects duplicate sub creation
 * for the same customer+price gracefully).
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

/**
 * Customer-first entry point. Validates eligibility then creates the
 * trial Stripe subscription. Used by the ticket-stage webhook and the
 * legacy Call wrapper.
 */
export async function createTrialSubscriptionForCustomer(
  customerId: string,
  source: 'ticket-stage-active' | 'mark-onboarding-call-complete' | 'legacy-call-webhook',
): Promise<HandleCallCompletedResult> {
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
    customerId: customer.id,
    stripeCustomerId: customer.stripeCustomerId,
    stripePriceId: customer.selectedStripePriceId,
    trialDays,
  });

  await updateCustomerFields(customer.id, {
    stripeSubscriptionId: subscription.id,
    subscriptionStatus: subscription.status === 'trialing' ? 'Trial' : 'Active',
  });

  console.log(
    `[createTrialSubscriptionForCustomer:${source}] Created sub ${subscription.id} (status=${subscription.status}, trial=${trialDays}d) for customer ${customer.id}`,
  );

  return {
    kind: 'created',
    subscriptionId: subscription.id,
    status: subscription.status,
    trialEnd: subscription.trial_end,
  };
}

/**
 * Legacy wrapper — looks up the Call, validates Call shape, then delegates.
 * Kept for the existing /api/webhooks/calls/completed route + updateCall()
 * cascade path so in-flight customers + the legacy Calendly webhook don't
 * break during the Phase 1 migration.
 */
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

  return createTrialSubscriptionForCustomer(customerId, 'legacy-call-webhook');
}
