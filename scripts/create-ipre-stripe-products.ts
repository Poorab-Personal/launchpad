/**
 * Create IPRE's Stripe product + recurring prices in the SANDBOX (test mode),
 * mirroring the existing B2B-Keyes setup.
 *
 * SAFETY: this script uses ONLY process.env.STRIPE_SECRET_KEY and asserts it
 * begins with `sk_test` before doing anything. If the key is not a test key,
 * the script exits(1) loudly. It NEVER reads STRIPE_LIVE_SECRET_KEY.
 *
 * Pricing (identical to Keyes, per product owner):
 *   - IPRE Monthly:           $119/mo   (unit_amount 11900, interval month x1)
 *   - IPRE Quarterly Prepay:  $300/3mo  (unit_amount 30000, interval month x3)
 *
 * Idempotent:
 *   - Searches products by metadata['workflow_key']='B2B-IPRE'; reuses if found.
 *   - Lists prices on the product; skips a price whose unit_amount + interval
 *     + interval_count already match.
 *
 * Usage: npx tsx --env-file=.env.local scripts/create-ipre-stripe-products.ts
 */
import Stripe from 'stripe';

// Reference Keyes price IDs (live in stripe_plans + Stripe sandbox). We fetch
// these first to mirror their structure exactly.
const KEYES_MONTHLY_PRICE_ID = 'price_1TJQ3BFhzZTRrtCyfQ1pRmqf';
const KEYES_QUARTERLY_PRICE_ID = 'price_1TJQ3MFhzZTRrtCyeH0w5GeL';

const IPRE_WORKFLOW_KEY = 'B2B-IPRE';

// Target IPRE prices.
const IPRE_MONTHLY = {
  label: 'IPRE Monthly',
  unit_amount: 11900,
  currency: 'usd' as const,
  interval: 'month' as const,
  interval_count: 1,
};
const IPRE_QUARTERLY = {
  label: 'IPRE Quarterly Prepay',
  unit_amount: 30000,
  currency: 'usd' as const,
  interval: 'month' as const,
  interval_count: 3,
};

function assertTestKey(): string {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.error(
      '\nFATAL: STRIPE_SECRET_KEY is not set. Aborting. ' +
        '(Run with: npx tsx --env-file=.env.local ...)',
    );
    process.exit(1);
  }
  if (!key.startsWith('sk_test')) {
    console.error(
      '\nFATAL: STRIPE_SECRET_KEY does NOT start with "sk_test". ' +
        `Got prefix "${key.slice(0, 7)}...". This script refuses to run ` +
        'against anything other than a Stripe TEST/SANDBOX key. ' +
        'It will NEVER create products against a live key. Aborting.',
    );
    process.exit(1);
  }
  console.log(`OK: STRIPE_SECRET_KEY is a test key (prefix "${key.slice(0, 8)}...").`);
  return key;
}

function summarizePrice(p: Stripe.Price): string {
  const r = p.recurring;
  return (
    `id=${p.id} unit_amount=${p.unit_amount} ${p.currency} ` +
    `recurring={interval:${r?.interval ?? 'n/a'}, ` +
    `interval_count:${r?.interval_count ?? 'n/a'}, ` +
    `usage_type:${r?.usage_type ?? 'n/a'}} ` +
    `type=${p.type} active=${p.active} ` +
    `product=${typeof p.product === 'string' ? p.product : p.product?.id}`
  );
}

async function main() {
  const key = assertTestKey();
  const stripe = new Stripe(key);

  // -------------------------------------------------------------------
  // 1. Fetch + log the Keyes prices so we mirror their structure exactly.
  // -------------------------------------------------------------------
  console.log('\n=== Reference: existing Keyes prices ===');
  const keyesMonthly = await stripe.prices.retrieve(KEYES_MONTHLY_PRICE_ID, {
    expand: ['product'],
  });
  const keyesQuarterly = await stripe.prices.retrieve(KEYES_QUARTERLY_PRICE_ID, {
    expand: ['product'],
  });

  for (const [label, p] of [
    ['Keyes Monthly', keyesMonthly],
    ['Keyes Quarterly', keyesQuarterly],
  ] as const) {
    console.log(`\n${label}:`);
    console.log('  ' + summarizePrice(p));
    const prod = p.product;
    if (prod && typeof prod !== 'string' && !('deleted' in prod && prod.deleted)) {
      const product = prod as Stripe.Product;
      console.log(
        `  product: id=${product.id} name="${product.name}" ` +
          `metadata=${JSON.stringify(product.metadata)}`,
      );
    }
    console.log('  full price object:');
    console.log(JSON.stringify(p, null, 2));
  }

  // -------------------------------------------------------------------
  // 2. Find-or-create the IPRE product (idempotent on metadata.workflow_key).
  // -------------------------------------------------------------------
  console.log('\n=== IPRE product ===');
  const search = await stripe.products.search({
    query: `metadata['workflow_key']:'${IPRE_WORKFLOW_KEY}'`,
  });

  let product: Stripe.Product;
  if (search.data.length > 0) {
    product = search.data[0];
    console.log(
      `Reusing existing IPRE product: id=${product.id} name="${product.name}" ` +
        `metadata=${JSON.stringify(product.metadata)}`,
    );
    if (search.data.length > 1) {
      console.warn(
        `WARNING: found ${search.data.length} products with ` +
          `metadata.workflow_key='${IPRE_WORKFLOW_KEY}'. Using the first ` +
          `(${product.id}). Others: ${search.data.slice(1).map((p) => p.id).join(', ')}`,
      );
    }
  } else {
    product = await stripe.products.create({
      name: 'IPRE Onboarding',
      metadata: {
        brokerage: 'ipre',
        workflow_key: IPRE_WORKFLOW_KEY,
      },
    });
    console.log(
      `Created IPRE product: id=${product.id} name="${product.name}" ` +
        `metadata=${JSON.stringify(product.metadata)}`,
    );
  }

  // -------------------------------------------------------------------
  // 3. Find-or-create the two recurring prices under that product.
  // -------------------------------------------------------------------
  // Pull existing prices on the product so we can dedupe by
  // unit_amount + interval + interval_count.
  const existingPrices: Stripe.Price[] = [];
  for await (const p of stripe.prices.list({ product: product.id, limit: 100 })) {
    existingPrices.push(p);
  }

  function findMatching(spec: {
    unit_amount: number;
    interval: 'month';
    interval_count: number;
  }): Stripe.Price | undefined {
    return existingPrices.find(
      (p) =>
        p.active &&
        p.type === 'recurring' &&
        p.unit_amount === spec.unit_amount &&
        p.currency === 'usd' &&
        p.recurring?.interval === spec.interval &&
        (p.recurring?.interval_count ?? 1) === spec.interval_count,
    );
  }

  async function findOrCreatePrice(spec: {
    label: string;
    unit_amount: number;
    currency: 'usd';
    interval: 'month';
    interval_count: number;
  }): Promise<Stripe.Price> {
    const match = findMatching(spec);
    if (match) {
      console.log(`Reusing existing price for ${spec.label}: ${summarizePrice(match)}`);
      return match;
    }
    const created = await stripe.prices.create({
      product: product.id,
      unit_amount: spec.unit_amount,
      currency: spec.currency,
      recurring: {
        interval: spec.interval,
        interval_count: spec.interval_count,
      },
      metadata: {
        brokerage: 'ipre',
        workflow_key: IPRE_WORKFLOW_KEY,
        plan_label: spec.label,
      },
    });
    console.log(`Created price for ${spec.label}: ${summarizePrice(created)}`);
    return created;
  }

  console.log('\n=== IPRE prices ===');
  const monthly = await findOrCreatePrice(IPRE_MONTHLY);
  const quarterly = await findOrCreatePrice(IPRE_QUARTERLY);

  // -------------------------------------------------------------------
  // 4. Final, clearly-parseable summary.
  // -------------------------------------------------------------------
  console.log('\n=== RESULT ===');
  console.log(`IPRE_PRODUCT_ID=${product.id}`);
  console.log(`IPRE_MONTHLY_PRICE_ID=${monthly.id}`);
  console.log(`IPRE_QUARTERLY_PRICE_ID=${quarterly.id}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('\nFAILED:', e);
    process.exit(1);
  });
