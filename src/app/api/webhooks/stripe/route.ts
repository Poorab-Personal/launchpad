import { NextRequest } from 'next/server';
import Stripe from 'stripe';
import { verifyWebhookSignature } from '@/lib/stripe';
import { getCustomers, updateCustomerFields } from '@/lib/airtable';
import { updateRecord } from '@/lib/airtable-client';

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
        await handleSetupIntentSucceeded(event.data.object as Stripe.SetupIntent);
        break;

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await handleSubscriptionEvent(event.data.object as Stripe.Subscription, event.type);
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

async function handleSetupIntentSucceeded(setupIntent: Stripe.SetupIntent) {
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

  // Find this customer's Capture Payment Method task. If it's already
  // Completed, no-op (the client-side /confirm flow already handled it).
  const tasks = customer.tasks; // array of task IDs
  if (!tasks || tasks.length === 0) {
    console.log(`[stripe webhook] customer ${customer.id} has no tasks; skipping`);
    return;
  }

  // We need the actual task records to find the Capture Payment Method one
  // and check its status. Re-fetch via the tasks function.
  const { getTasksForCustomer } = await import('@/lib/airtable');
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
  await updateRecord('Tasks', captureTask.id, { Status: 'Completed' });
  console.log(`[stripe webhook] marked Capture Payment Method Completed for ${customer.id} (server-side fallback)`);
}

async function handleSubscriptionEvent(subscription: Stripe.Subscription, eventType: string) {
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
  if (!newStatus) {
    console.log(`[stripe webhook] unmapped subscription status: ${subscription.status}; no-op`);
    return;
  }

  // Update only if changed (avoid noisy Airtable writes)
  if (customer.stripeSubscriptionId === subscription.id) {
    // Same sub — just update status. Skip if no change is detectable.
    // (We don't track the previous status in TypeScript Customer type,
    // but Airtable's update is idempotent per value, so this is fine.)
  }

  await updateCustomerFields(customer.id, {
    'Stripe Subscription ID': subscription.id,
    'Subscription Status': newStatus,
  });
  console.log(
    `[stripe webhook] ${eventType}: customer ${customer.id} → status=${newStatus} (sub=${subscription.id})`,
  );
}
