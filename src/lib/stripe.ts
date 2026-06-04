import Stripe from 'stripe';

let _client: Stripe | null = null;

/**
 * Lazy Stripe client init. Don't throw at module load — only when actually
 * called. Lets the app boot in dev/preview environments without
 * STRIPE_SECRET_KEY set; only the routes that touch Stripe need it.
 *
 * Key resolution mirrors the closedwon-handler pattern:
 *   - Prefer STRIPE_LIVE_SECRET_KEY (the LIVE Rejig Stripe account key,
 *     used by IPRE / future B2B production payments).
 *   - Fall back to STRIPE_SECRET_KEY (typically the sandbox key in local
 *     dev or pre-cutover Preview environments).
 * This means Vercel Production needs only STRIPE_LIVE_SECRET_KEY set;
 * STRIPE_SECRET_KEY can stay as sandbox for dev/preview without leaking
 * sandbox into prod.
 */
function client(): Stripe {
  if (_client) return _client;
  const key = process.env.STRIPE_LIVE_SECRET_KEY ?? process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error(
      'STRIPE_LIVE_SECRET_KEY (or STRIPE_SECRET_KEY) is not set. Required for Stripe operations (customer/sub/SetupIntent creation).',
    );
  }
  _client = new Stripe(key);
  return _client;
}

/**
 * Create a Stripe Customer. Idempotent on the LaunchPad customer id —
 * re-calling with the same customerId returns the same Stripe Customer
 * (Stripe handles this via idempotency-key headers).
 */
export async function createStripeCustomer(params: {
  customerId: string;
  email: string;
  name: string;
  metadata?: Record<string, string>;
}): Promise<Stripe.Customer> {
  return client().customers.create(
    {
      email: params.email,
      name: params.name,
      metadata: {
        launchpad_customer_id: params.customerId,
        ...(params.metadata ?? {}),
      },
    },
    { idempotencyKey: `cust_create_${params.customerId}` },
  );
}

/**
 * Create a SetupIntent so the customer can save a payment method
 * for future charging (when sub is created after the onboarding call).
 * `usage: 'off_session'` because the eventual charge happens without
 * the customer present.
 */
export async function createSetupIntent(params: {
  stripeCustomerId: string;
  customerId: string;
}): Promise<Stripe.SetupIntent> {
  return client().setupIntents.create(
    {
      customer: params.stripeCustomerId,
      payment_method_types: ['card'],
      usage: 'off_session',
      metadata: {
        launchpad_customer_id: params.customerId,
      },
    },
    { idempotencyKey: `setup_intent_${params.customerId}` },
  );
}

/**
 * Create a subscription using a previously-saved payment method.
 * Idempotent on the LaunchPad customer id — call this safely from
 * webhook retries.
 */
export async function createSubscription(params: {
  customerId: string;
  stripeCustomerId: string;
  stripePriceId: string;
  trialDays: number;
  paymentMethodId?: string;
}): Promise<Stripe.Subscription> {
  const subParams: Stripe.SubscriptionCreateParams = {
    customer: params.stripeCustomerId,
    items: [{ price: params.stripePriceId }],
    metadata: {
      launchpad_customer_id: params.customerId,
    },
  };
  if (params.trialDays > 0) {
    subParams.trial_period_days = params.trialDays;
  }
  if (params.paymentMethodId) {
    subParams.default_payment_method = params.paymentMethodId;
  }
  return client().subscriptions.create(subParams, {
    idempotencyKey: `sub_create_${params.customerId}`,
  });
}

/**
 * Verify a Stripe webhook signature and return the parsed event.
 * Throws if the signature is invalid (so the route returns 400).
 */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string,
  secret: string,
): Stripe.Event {
  return client().webhooks.constructEvent(rawBody, signature, secret);
}
