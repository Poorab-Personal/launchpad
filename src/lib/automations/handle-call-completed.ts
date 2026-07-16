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
import { db } from '@/db';
import { customerSubscriptions } from '@/db/schema/customerSubscriptions';
import {
  getCallById,
  getCustomerById,
  getWorkflowTemplates,
  updateCustomerFields,
} from '@/lib/db';
import { createSubscription, getCustomerDefaultPaymentMethod } from '@/lib/stripe';

/**
 * Stripe sub status → LP subscription_status enum. Mirrors the mapper in
 * closedwon-handler.ts (kept local to avoid a cross-module import for one
 * switch — the two must stay in sync).
 */
function mapStripeSubStatus(
  status: string,
): 'Active' | 'Trial' | 'Past Due' | 'Cancelled' {
  switch (status) {
    case 'trialing':
      return 'Trial';
    case 'past_due':
      return 'Past Due';
    case 'canceled':
    case 'incomplete_expired':
      return 'Cancelled';
    default:
      return 'Active';
  }
}

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

  // Resolve the card the customer saved at intake and set it as the sub's
  // default_payment_method. The primary cure lives at card-save time
  // (setCustomerDefaultPaymentMethod on setup_intent.succeeded); this is the
  // belt-and-suspenders that also pins the default ON the subscription (Stripe
  // consults the sub-level default first). Fail loud if there's no card — a
  // setup-intent-at-intake customer reaching here MUST have one (the Capture
  // Payment Method task gates it); a defaultless sub is exactly the bug we're
  // closing, so surface it rather than silently create one that can't charge.
  const paymentMethodId = await getCustomerDefaultPaymentMethod(customer.stripeCustomerId);
  if (!paymentMethodId) {
    return {
      kind: 'error',
      error:
        'Customer has no saved payment method — cannot set a subscription default. Capture Payment Method should have saved a card.',
      status: 400,
    };
  }

  const trialDays = templates[0]?.trialDays ?? 0;
  const subscription = await createSubscription({
    customerId: customer.id,
    stripeCustomerId: customer.stripeCustomerId,
    stripePriceId: customer.selectedStripePriceId,
    trialDays,
    paymentMethodId,
  });

  await updateCustomerFields(customer.id, {
    stripeSubscriptionId: subscription.id,
    subscriptionStatus: subscription.status === 'trialing' ? 'Trial' : 'Active',
  });

  // Populate the Core customer_subscriptions row so the newer "source of
  // truth" table sees this sub. The Deal-closedwon path writes this table for
  // D2C/Keyes; this ticket→Active trial-create path (IPRE + any future
  // setup-intent-at-intake B2B) must write it too — otherwise the sub is
  // invisible to everything that reads customer_subscriptions (BI renewal
  // windows, days_until_expiry, funnel-audit trial-end). The Stripe webhook
  // only UPDATEs this table (never inserts), so without this seed row its
  // period-sync no-ops forever. Best-effort: the customer-row mirror above is
  // the primary state; a failure here is logged, not fatal.
  try {
    const subAny = subscription as unknown as {
      current_period_start?: number;
      current_period_end?: number;
      items?: {
        data?: Array<{ current_period_start?: number; current_period_end?: number }>;
      };
    };
    const item = subAny.items?.data?.[0];
    const cpsSec =
      item?.current_period_start ?? subAny.current_period_start ?? subscription.start_date ?? null;
    // While trialing, trial_end is the live period boundary; fall back to the
    // item/sub period end once billing starts.
    const cpeSec = subscription.trial_end ?? item?.current_period_end ?? subAny.current_period_end ?? null;
    const mappedStatus = mapStripeSubStatus(subscription.status);

    await db
      .insert(customerSubscriptions)
      .values({
        customerId: customer.id,
        product: 'Core',
        stripeSubscriptionId: subscription.id,
        status: mappedStatus,
        startedAt: subscription.start_date ? new Date(subscription.start_date * 1000) : null,
        currentPeriodStart: cpsSec ? new Date(cpsSec * 1000) : null,
        currentPeriodEnd: cpeSec ? new Date(cpeSec * 1000) : null,
        currentPeriodStartSource: 'stripe',
        paymentSource: 'stripe',
      })
      .onConflictDoUpdate({
        target: [customerSubscriptions.customerId, customerSubscriptions.product],
        set: {
          stripeSubscriptionId: subscription.id,
          status: mappedStatus,
          currentPeriodStart: cpsSec ? new Date(cpsSec * 1000) : null,
          currentPeriodEnd: cpeSec ? new Date(cpeSec * 1000) : null,
          currentPeriodStartSource: 'stripe',
          paymentSource: 'stripe',
          updatedAt: new Date(),
        },
      });
  } catch (err) {
    console.warn(
      `[createTrialSubscriptionForCustomer:${source}] customer_subscriptions upsert failed for sub ${subscription.id} (non-fatal):`,
      err,
    );
  }

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
