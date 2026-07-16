import { NextRequest } from 'next/server';
import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { customerSubscriptions } from '@/db/schema/customerSubscriptions';
import { customerUsageSignals } from '@/db/schema/customerUsageSignals';
import { verifyWebhookSignature, setCustomerDefaultPaymentMethod } from '@/lib/stripe';
import { getCustomers, getTasksForCustomer, updateCustomerFields, updateTaskStatus } from '@/lib/db';

/**
 * Stripe signal taxonomy (Phase 2 schema — populated here for time-series
 * BI rules in Phase 4). Each subscription / invoice / setup-intent event
 * writes one customer_usage_signals row in addition to the existing side
 * effects (subscriptionStatus update, task completion). 8 types initially
 * per docs/plans/post-launch-migration.md scrutiny point 13.
 */
const SIGNAL_TYPE_BY_EVENT: Record<string, string> = {
  'customer.subscription.created': 'stripe.subscription.created',
  'customer.subscription.updated': 'stripe.subscription.updated',      // status transition tracked via signal_value_jsonb
  'customer.subscription.deleted': 'stripe.subscription.cancelled',
  'customer.subscription.trial_will_end': 'stripe.subscription.trial_will_end',
  'invoice.payment_succeeded': 'stripe.invoice.payment_succeeded',
  'invoice.payment_failed': 'stripe.invoice.payment_failed',
  'setup_intent.succeeded': 'stripe.setup_intent.succeeded',
};

/**
 * §18 — update customer_subscriptions row with the latest period dates from
 * Stripe. Idempotent; no-op if no customer_subscriptions row exists yet for
 * this stripe_subscription_id (e.g. pre-backfill or non-Core subs we don't
 * track). Stripe API v2024-04-10+ moved current_period_* from subscription
 * root to subscription.items.data[0].
 */
async function updateSubscriptionPeriodsFromStripe(sub: Stripe.Subscription): Promise<void> {
  const subAny = sub as unknown as {
    current_period_start?: number;
    current_period_end?: number;
    items?: { data?: Array<{ current_period_start?: number; current_period_end?: number }> };
  };
  const firstItem = subAny.items?.data?.[0];
  const cpsSec = firstItem?.current_period_start ?? subAny.current_period_start;
  const cpeSec = firstItem?.current_period_end ?? subAny.current_period_end;
  if (!cpsSec && !cpeSec) return; // nothing to write

  try {
    await db
      .update(customerSubscriptions)
      .set({
        currentPeriodStart: cpsSec ? new Date(cpsSec * 1000) : null,
        currentPeriodEnd: cpeSec ? new Date(cpeSec * 1000) : null,
        currentPeriodStartSource: 'stripe',
        paymentSource: 'stripe',
      })
      .where(eq(customerSubscriptions.stripeSubscriptionId, sub.id));
  } catch (err) {
    console.warn(`[stripe webhook] customer_subscriptions period update failed for sub=${sub.id}:`, err);
  }
}

/**
 * §18 — update customer_subscriptions row with the latest invoice status.
 * Idempotent; no-op if no row exists for the invoice's subscription_id.
 */
async function updateLastInvoiceFromStripe(invoice: Stripe.Invoice): Promise<void> {
  const invAny = invoice as unknown as { subscription?: string | { id?: string } | null };
  const subId =
    typeof invAny.subscription === 'string'
      ? invAny.subscription
      : invAny.subscription?.id ?? null;
  if (!subId) return; // not a subscription invoice

  try {
    await db
      .update(customerSubscriptions)
      .set({
        lastInvoiceStatus: invoice.status ?? null,
        lastInvoiceUrl: invoice.hosted_invoice_url ?? null,
      })
      .where(eq(customerSubscriptions.stripeSubscriptionId, subId));
  } catch (err) {
    console.warn(`[stripe webhook] customer_subscriptions invoice update failed for sub=${subId}:`, err);
  }
}

async function writeStripeSignal(args: {
  customerId: string;
  stripeCustomerId: string;
  signalType: string;
  occurredAtSeconds: number;
  numeric?: number | null;
  payload: Record<string, unknown>;
}) {
  try {
    await db.insert(customerUsageSignals).values({
      customerId: args.customerId,
      signalType: args.signalType,
      signalValueNumeric: args.numeric != null ? String(args.numeric) : null,
      signalValueJsonb: { stripeCustomerId: args.stripeCustomerId, ...args.payload },
      observedAt: new Date(args.occurredAtSeconds * 1000),
      source: 'stripe_webhook',
    });
  } catch (err) {
    // Signal capture is best-effort. The existing side effects (status
    // update, task completion) are the canonical state; signal is for
    // BI history. Don't block the webhook on a signal write failure.
    console.warn(`[stripe webhook] signal write failed for ${args.signalType}:`, err);
  }
}

/**
 * POST /api/webhooks/stripe
 *
 * Stripe webhook endpoint. Verified via signature header
 * (`Stripe-Signature` + `STRIPE_WEBHOOK_SECRET` env var).
 *
 * Handled events:
 *  - `setup_intent.succeeded` — server-side fallback for the client-side
 *    /confirm flow. Idempotent: no-op if the Capture Payment Method task
 *    is already Completed for this customer.
 *  - `customer.subscription.created` — write Subscription Status (Trial/Active).
 *  - `customer.subscription.updated` — keep Subscription Status in sync
 *    (handles trial-to-active transition, past_due, canceled).
 *  - `customer.subscription.deleted` — mark customer Subscription Status=Cancelled.
 *
 * Customer is matched via Stripe Customer ID — we set this when the
 * Airtable Customer is created (Phase 1.5 / 1.6 routes).
 *
 * For unhandled events: 200 OK so Stripe doesn't retry. Log + move on.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[stripe webhook] STRIPE_WEBHOOK_SECRET not set');
    return Response.json({ error: 'Webhook not configured' }, { status: 500 });
  }

  const sig = request.headers.get('stripe-signature');
  if (!sig) return new Response('Missing signature', { status: 400 });

  const rawBody = await request.text();
  let event: Stripe.Event;
  try {
    event = verifyWebhookSignature(rawBody, sig, secret);
  } catch (err) {
    console.error('[stripe webhook] signature verification failed:', err);
    return new Response('Invalid signature', { status: 400 });
  }

  console.log(`[stripe webhook] received event ${event.type} (${event.id})`);

  try {
    switch (event.type) {
      case 'setup_intent.succeeded':
        await handleSetupIntentSucceeded(event.data.object as Stripe.SetupIntent, event);
        break;

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
      case 'customer.subscription.trial_will_end':
        await handleSubscriptionEvent(event.data.object as Stripe.Subscription, event);
        break;

      case 'invoice.payment_succeeded':
      case 'invoice.payment_failed':
      case 'invoice.paid':                  // §18
      case 'invoice.finalized':             // §18
      case 'invoice.voided':                // §18
      case 'invoice.marked_uncollectible':  // §18
        await handleInvoiceEvent(event.data.object as Stripe.Invoice, event);
        break;

      default:
        // Ignored — not all Stripe events are interesting to us
        break;
    }
  } catch (err) {
    console.error(`[stripe webhook] handler for ${event.type} threw:`, err);
    // Return 500 so Stripe retries — handler errors shouldn't drop events
    return Response.json({ error: 'Handler error' }, { status: 500 });
  }

  return Response.json({ received: true });
}

/**
 * Find the Airtable Customer for a given Stripe customer ID.
 * Linear scan via the Customers list — fine at our scale (hundreds, not
 * tens of thousands). Cache could be added if hot-path performance bites.
 */
async function findAirtableCustomerByStripeId(stripeCustomerId: string) {
  const customers = await getCustomers();
  return customers.find((c) => c.stripeCustomerId === stripeCustomerId) ?? null;
}

async function handleSetupIntentSucceeded(setupIntent: Stripe.SetupIntent, event: Stripe.Event) {
  const stripeCustomerId =
    typeof setupIntent.customer === 'string' ? setupIntent.customer : setupIntent.customer?.id;
  if (!stripeCustomerId) {
    console.warn('[stripe webhook] setup_intent.succeeded with no customer; skipping');
    return;
  }

  const customer = await findAirtableCustomerByStripeId(stripeCustomerId);
  if (!customer) {
    console.warn(`[stripe webhook] no Airtable customer for Stripe customer ${stripeCustomerId}`);
    return;
  }

  const paymentMethodId =
    typeof setupIntent.payment_method === 'string'
      ? setupIntent.payment_method
      : setupIntent.payment_method?.id ?? null;

  // Phase 2: capture as a usage signal regardless of task state.
  await writeStripeSignal({
    customerId: customer.id,
    stripeCustomerId,
    signalType: SIGNAL_TYPE_BY_EVENT['setup_intent.succeeded'],
    occurredAtSeconds: event.created,
    payload: {
      setupIntentId: setupIntent.id,
      paymentMethodId,
    },
  });

  // PRIMARY fix for the "trial ends → invoice stuck open, no card to charge"
  // bug: the moment the customer saves their (one) card, mark it the customer's
  // default. Every future charge_automatically invoice — including the
  // trial-conversion invoice — then auto-charges it. Runs seconds after save,
  // days before the subscription is created, so the default is always in place
  // by billing time. Best-effort: a failure here must not 500 the webhook or
  // block the task-completion below (Stripe retries delivery anyway).
  if (paymentMethodId) {
    try {
      await setCustomerDefaultPaymentMethod(stripeCustomerId, paymentMethodId);
      console.log(`[stripe webhook] set default PM ${paymentMethodId} for ${stripeCustomerId} (customer ${customer.id})`);
    } catch (err) {
      console.warn(
        `[stripe webhook] failed to set default PM ${paymentMethodId} for ${stripeCustomerId} (non-fatal):`,
        err,
      );
    }
  }

  // Find this customer's Capture Payment Method task. If it's already
  // Completed, no-op (the client-side /confirm flow already handled it).
  const allTasks = await getTasksForCustomer(customer.id);
  const captureTask = allTasks.find((t) => t.taskName === 'Capture Payment Method');
  if (!captureTask) {
    console.log(`[stripe webhook] customer ${customer.id} has no Capture Payment Method task`);
    return;
  }
  if (captureTask.status === 'Completed') {
    console.log(`[stripe webhook] Capture Payment Method already Completed for ${customer.id}; no-op`);
    return;
  }

  // Mark it Completed (Auto 2 will then unblock dependents)
  await updateTaskStatus(captureTask.id, 'Completed');
  console.log(`[stripe webhook] marked Capture Payment Method Completed for ${customer.id} (server-side fallback)`);
}

async function handleSubscriptionEvent(subscription: Stripe.Subscription, event: Stripe.Event) {
  const eventType = event.type;
  const stripeCustomerId =
    typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
  if (!stripeCustomerId) {
    console.warn(`[stripe webhook] ${eventType} with no customer; skipping`);
    return;
  }

  const customer = await findAirtableCustomerByStripeId(stripeCustomerId);
  if (!customer) {
    console.warn(`[stripe webhook] no Airtable customer for Stripe customer ${stripeCustomerId}`);
    return;
  }

  // Map Stripe status → Customers.Subscription Status single-select values
  // (existing values: Active | Trial | Past Due | Cancelled)
  const statusMap: Record<string, string> = {
    trialing: 'Trial',
    active: 'Active',
    past_due: 'Past Due',
    canceled: 'Cancelled',
    unpaid: 'Past Due',
    incomplete: 'Past Due',
    incomplete_expired: 'Cancelled',
    paused: 'Past Due',
  };
  const newStatus = statusMap[subscription.status] ?? null;

  // Phase 2: also write a usage signal for time-series BI. Includes the
  // mapped LP status so consumers don't have to re-derive it.
  await writeStripeSignal({
    customerId: customer.id,
    stripeCustomerId,
    signalType: SIGNAL_TYPE_BY_EVENT[eventType] ?? 'stripe.subscription.updated',
    occurredAtSeconds: event.created,
    payload: {
      subscriptionId: subscription.id,
      stripeStatus: subscription.status,
      mappedLPStatus: newStatus,
      trialEnd: subscription.trial_end,
      cancelAt: subscription.cancel_at,
    },
  });

  if (!newStatus) {
    console.log(`[stripe webhook] unmapped subscription status: ${subscription.status}; signal logged, status not updated`);
    return;
  }

  await updateCustomerFields(customer.id, {
    stripeSubscriptionId: subscription.id,
    subscriptionStatus: newStatus as 'Trial' | 'Active' | 'Past Due' | 'Cancelled',
  });

  // §18 — keep customer_subscriptions period dates fresh
  await updateSubscriptionPeriodsFromStripe(subscription);

  console.log(
    `[stripe webhook] ${eventType}: customer ${customer.id} → status=${newStatus} (sub=${subscription.id})`,
  );
}

/**
 * Invoice events — no canonical state side effects today (subscription
 * events handle the customer's subscription_status). Just record the
 * signal for BI's payment-history view. Phase 4 rules will use these.
 */
async function handleInvoiceEvent(invoice: Stripe.Invoice, event: Stripe.Event) {
  const eventType = event.type;
  const stripeCustomerId =
    typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
  if (!stripeCustomerId) {
    console.warn(`[stripe webhook] ${eventType} with no customer; skipping`);
    return;
  }

  const customer = await findAirtableCustomerByStripeId(stripeCustomerId);
  if (!customer) {
    console.warn(`[stripe webhook] no LP customer for Stripe customer ${stripeCustomerId} on ${eventType}`);
    return;
  }

  await writeStripeSignal({
    customerId: customer.id,
    stripeCustomerId,
    signalType: SIGNAL_TYPE_BY_EVENT[eventType] ?? 'stripe.invoice.unknown',
    occurredAtSeconds: event.created,
    numeric: invoice.amount_due ? invoice.amount_due / 100 : null,
    payload: {
      invoiceId: invoice.id,
      amountDue: invoice.amount_due,
      amountPaid: invoice.amount_paid,
      currency: invoice.currency,
      attemptCount: invoice.attempt_count,
    },
  });

  // §18 — keep customer_subscriptions last_invoice_* fresh
  await updateLastInvoiceFromStripe(invoice);

  console.log(`[stripe webhook] ${eventType}: signal logged for customer ${customer.id}`);
}
