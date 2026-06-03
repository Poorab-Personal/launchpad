/**
 * Create the IPRE product + two prices in LIVE Stripe.
 *
 * Mirrors the sandbox setup verified via scripts/inspect-stripe-ipre.ts:
 *   - One Product:  "IPRE - Rejig.ai" w/ statement_descriptor "REJIG.AI*IPRE"
 *   - Two Prices:   $119/month (Monthly), $300/3-month (Quarterly Prepay)
 *
 * Runs against STRIPE_LIVE_SECRET_KEY. After creation it prints the new
 * live IDs to stdout so they can be copied into the flip-prep script
 * (scripts/flip-to-live-stripe-ipre.ts) for later.
 *
 * Idempotent: searches for existing live products with metadata
 * brokerage=ipre + workflow_key=B2B-IPRE first; if one exists, skips
 * product creation and reuses it. Same for prices (checks by interval_count).
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const PRODUCT_NAME = 'IPRE - Rejig.ai';
const PRODUCT_DESCRIPTION =
  'Your AI-powered social media assistant, exclusively for IPRE agents. ' +
  'Includes custom IPRE-branded posts, videos, and reels, AI Listing Concierge, ' +
  'monthly market content, local news automation, and publishing to all social platforms.';
const STATEMENT_DESCRIPTOR = 'REJIG.AI*IPRE';
const TAX_CODE = 'txcd_10103001';
const PRODUCT_METADATA = { brokerage: 'ipre', workflow_key: 'B2B-IPRE' };

const MONTHLY_AMOUNT = 11900;            // $119.00 USD
const QUARTERLY_AMOUNT = 30000;          // $300.00 USD ($100/mo effective, saves 16%)

async function main() {
  const LIVE_KEY = process.env.STRIPE_LIVE_SECRET_KEY;
  if (!LIVE_KEY) {
    throw new Error('STRIPE_LIVE_SECRET_KEY missing in .env.local');
  }
  if (!LIVE_KEY.startsWith('sk_live_')) {
    throw new Error(`STRIPE_LIVE_SECRET_KEY does not start with sk_live_ — refusing to proceed (got ${LIVE_KEY.slice(0, 8)}...)`);
  }

  const Stripe = (await import('stripe')).default;
  const stripe = new Stripe(LIVE_KEY);

  // ─── 1. Find or create the Product ───────────────────────────────────────
  // Stripe doesn't index metadata, so we list all active products and filter.
  // At our scale this is fine (single-digit products).
  console.log('Searching for existing IPRE product...');
  const allProducts = await stripe.products.list({ active: true, limit: 100 });
  let product = allProducts.data.find(
    (p) => p.metadata.brokerage === 'ipre' && p.metadata.workflow_key === 'B2B-IPRE',
  );

  if (product) {
    console.log(`✓ Reusing existing product ${product.id} ("${product.name}")`);
  } else {
    console.log('Creating new product...');
    product = await stripe.products.create({
      name: PRODUCT_NAME,
      description: PRODUCT_DESCRIPTION,
      statement_descriptor: STATEMENT_DESCRIPTOR,
      tax_code: TAX_CODE,
      metadata: PRODUCT_METADATA,
    });
    console.log(`✓ Created product ${product.id}`);
  }

  // ─── 2. Find or create the Prices ────────────────────────────────────────
  const existingPrices = await stripe.prices.list({ product: product.id, active: true, limit: 50 });

  let monthly = existingPrices.data.find(
    (p) => p.recurring?.interval === 'month' && p.recurring.interval_count === 1,
  );
  if (monthly) {
    console.log(`✓ Reusing existing monthly price ${monthly.id}`);
  } else {
    console.log('Creating monthly price...');
    monthly = await stripe.prices.create({
      product: product.id,
      unit_amount: MONTHLY_AMOUNT,
      currency: 'usd',
      recurring: { interval: 'month', interval_count: 1 },
      metadata: { brokerage: 'ipre', plan_label: 'IPRE Monthly', workflow_key: 'B2B-IPRE' },
    });
    console.log(`✓ Created monthly price ${monthly.id}`);
  }

  let quarterly = existingPrices.data.find(
    (p) => p.recurring?.interval === 'month' && p.recurring.interval_count === 3,
  );
  if (quarterly) {
    console.log(`✓ Reusing existing quarterly price ${quarterly.id}`);
  } else {
    console.log('Creating quarterly price...');
    quarterly = await stripe.prices.create({
      product: product.id,
      unit_amount: QUARTERLY_AMOUNT,
      currency: 'usd',
      recurring: { interval: 'month', interval_count: 3 },
      metadata: { brokerage: 'ipre', plan_label: 'IPRE Quarterly Prepay', workflow_key: 'B2B-IPRE' },
    });
    console.log(`✓ Created quarterly price ${quarterly.id}`);
  }

  // ─── 3. Report ───────────────────────────────────────────────────────────
  console.log('\n═══ LIVE Stripe IPRE setup ═══');
  console.log(`PRODUCT_LIVE   = '${product.id}'`);
  console.log(`MONTHLY_LIVE   = '${monthly.id}'`);
  console.log(`QUARTERLY_LIVE = '${quarterly.id}'`);
  console.log('\nCopy these IDs into scripts/flip-to-live-stripe-ipre.ts before committing.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
