/**
 * Flip B2B-IPRE stripe_plans rows from SANDBOX to LIVE Stripe price IDs.
 *
 * Run this AFTER you've already:
 *   1. Swapped Vercel env vars (STRIPE_SECRET_KEY, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
 *      STRIPE_WEBHOOK_SECRET) from sandbox → live values.
 *   2. Configured the live webhook endpoint at Stripe Dashboard
 *      (pointing at https://onboarding.rejig.ai/api/webhooks/stripe).
 *   3. Updated .env.local STRIPE_SECRET_KEY to sk_live_* if you want to test
 *      from local dev too.
 *
 * The script:
 *   - Refuses to run unless STRIPE_SECRET_KEY starts with sk_live_ (safety
 *     guard so we don't accidentally "swap" while still on sandbox).
 *   - Looks up each B2B-IPRE stripe_plans row by its CURRENT (sandbox) price ID.
 *   - Updates each row to the corresponding LIVE price ID below.
 *   - Verifies post-swap that the new price IDs are valid in live Stripe.
 *
 * Idempotent — if rows already point at the live IDs, it's a no-op.
 *
 * To roll back: re-run `scripts/inspect-stripe-ipre.ts` against the
 * pre-swap snapshot or use the sandbox IDs documented below.
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

// ─── LIVE Stripe IDs (created via scripts/create-live-stripe-ipre.ts) ──────
const LIVE = {
  PRODUCT: 'prod_UdLIiChZkVXVZo',
  MONTHLY_PRICE: 'price_1Te4cGCQTlvKI2ANuUa0G9Ye',
  QUARTERLY_PRICE: 'price_1Te4cGCQTlvKI2ANf2szy7vU',
} as const;

// ─── SANDBOX Stripe IDs (for reference / rollback) ─────────────────────────
const SANDBOX = {
  PRODUCT: 'prod_UbJvP2vApO2dWq',
  MONTHLY_PRICE: 'price_1Tc7HnFhzZTRrtCySH6UreYs',
  QUARTERLY_PRICE: 'price_1Tc7HoFhzZTRrtCy9kVrBP9O',
} as const;

// Map: row's current price ID (sandbox or live) → desired LIVE price ID.
// Keyed off the sandbox IDs so the swap works no matter when this is run.
const SWAP: Record<string, string> = {
  [SANDBOX.MONTHLY_PRICE]: LIVE.MONTHLY_PRICE,
  [SANDBOX.QUARTERLY_PRICE]: LIVE.QUARTERLY_PRICE,
};

async function main() {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) throw new Error('STRIPE_SECRET_KEY missing');
  if (!stripeKey.startsWith('sk_live_')) {
    throw new Error(
      `STRIPE_SECRET_KEY is "${stripeKey.slice(0, 8)}…" — expected sk_live_*. ` +
      `Refusing to flip stripe_plans while still on sandbox. ` +
      `Swap Vercel + .env.local env vars to live keys first.`,
    );
  }

  const Stripe = (await import('stripe')).default;
  const stripe = new Stripe(stripeKey);

  // Validate live IDs actually exist before touching DB
  console.log('Validating live Stripe IDs...');
  for (const id of [LIVE.MONTHLY_PRICE, LIVE.QUARTERLY_PRICE]) {
    const price = await stripe.prices.retrieve(id);
    if (!price.active) throw new Error(`Live price ${id} is not active`);
  }
  console.log('✓ Both live prices retrievable + active.');

  const { db } = await import('../src/db');
  const schema = await import('../src/db/schema');
  const { eq } = await import('drizzle-orm');

  // Pull current rows
  const rows = await db
    .select()
    .from(schema.stripePlans)
    .where(eq(schema.stripePlans.workflowKey, 'B2B-IPRE'));
  console.log(`\nFound ${rows.length} B2B-IPRE row(s) in stripe_plans:`);

  let swapped = 0;
  let skipped = 0;
  for (const row of rows) {
    const target = SWAP[row.stripePriceId];
    if (!target) {
      if (row.stripePriceId === LIVE.MONTHLY_PRICE || row.stripePriceId === LIVE.QUARTERLY_PRICE) {
        console.log(`  ${row.planName}  already LIVE (${row.stripePriceId}) — skipping`);
        skipped++;
        continue;
      }
      console.warn(`  ${row.planName}  unrecognized price ID ${row.stripePriceId} — skipping (manual review required)`);
      skipped++;
      continue;
    }
    console.log(`  ${row.planName}  ${row.stripePriceId} → ${target}`);
    await db
      .update(schema.stripePlans)
      .set({ stripePriceId: target })
      .where(eq(schema.stripePlans.id, row.id));
    swapped++;
  }

  console.log(`\n✓ Swapped ${swapped} row(s), skipped ${skipped}.`);
  console.log(`\nVerify in UI: hit /ipre/test on prod, walk to Capture Payment Method.`);
  console.log(`Stripe Dashboard (live mode) should now receive the test transactions.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
