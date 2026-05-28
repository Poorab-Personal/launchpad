/**
 * Phase 1b of the DMG roster integration plan: seed Stripe plan rows for
 * the new B2B-IPRE workflow, mirroring the shape of the existing B2B-Keyes
 * plans.
 *
 * Idempotent — for each PLANS entry, SELECT first on (workflow_key=B2B-IPRE,
 * stripe_price_id=$1); insert only if absent. Re-running is safe.
 *
 * NOTE: stripePriceId values are TBD placeholders. Replace every
 * 'price_TBD_*' before running. The script will refuse to insert a row
 * whose stripePriceId still starts with 'price_TBD_'.
 *
 * Usage: npx tsx scripts/seed-ipre-stripe-plans.ts
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const TARGET_WORKFLOW_KEY = 'B2B-IPRE';
const REFERENCE_WORKFLOW_KEY = 'B2B-Keyes';

// Mirror the B2B-Keyes plan shape for IPRE. The user fills in real
// stripePriceId values before running. Adjust the metadata (planName,
// description, priceDisplay, billingDetail, footnote, highlight,
// displayOrder) to match the IPRE pricing if/when it diverges from Keyes.
type PlanSeed = {
  planName: string;
  stripePriceId: string;             // TODO(user): fill in real Stripe price ID before running
  active: boolean;
  description: string | null;
  priceDisplay: string | null;
  pricePeriod: string | null;
  billingDetail: string | null;
  footnote: string | null;
  highlight: string | null;
  displayOrder: number | null;
};

// Mirrors the live B2B-Keyes stripe_plans shape (Monthly + Quarterly Prepay).
// Price IDs created in the Stripe SANDBOX by
// scripts/create-ipre-stripe-products.ts (product prod_UbJvP2vApO2dWq):
//   IPRE Monthly:          price_1Tc7HnFhzZTRrtCySH6UreYs  ($119/mo)
//   IPRE Quarterly Prepay: price_1Tc7HoFhzZTRrtCy9kVrBP9O  ($300 / 3mo, shown $100/mo)
const PLANS: PlanSeed[] = [
  {
    planName: 'IPRE Monthly',
    stripePriceId: 'price_1Tc7HnFhzZTRrtCySH6UreYs',
    active: true,
    description: null,
    priceDisplay: '$119',
    pricePeriod: '/mo',
    billingDetail: null,
    footnote: null,
    highlight: null,
    displayOrder: 1,
  },
  {
    planName: 'IPRE Quarterly Prepay',
    stripePriceId: 'price_1Tc7HoFhzZTRrtCy9kVrBP9O',
    active: true,
    description: null,
    priceDisplay: '$100',
    pricePeriod: '/mo',
    billingDetail: null,
    footnote: null,
    highlight: null,
    displayOrder: 2,
  },
];

async function main() {
  const { db } = await import('../src/db');
  const { stripePlans } = await import('../src/db/schema/stripePlans');
  const { and, eq, asc } = await import('drizzle-orm');

  type NewStripePlan = typeof stripePlans.$inferInsert;

  // -------------------------------------------------------------------
  // Pre-flight: dump existing B2B-Keyes rows so the user can confirm
  // the expected shape (count, plan names, price IDs, display order).
  // -------------------------------------------------------------------
  console.log(`Reference rows for ${REFERENCE_WORKFLOW_KEY}:`);
  const refRows = await db
    .select()
    .from(stripePlans)
    .where(eq(stripePlans.workflowKey, REFERENCE_WORKFLOW_KEY))
    .orderBy(asc(stripePlans.displayOrder), asc(stripePlans.planName));
  if (refRows.length === 0) {
    console.log(`  (none — unexpected; B2B-Keyes plans should exist before seeding IPRE).`);
  } else {
    for (const r of refRows) {
      console.log(
        `  - ${r.planName} (${r.stripePriceId}) ` +
          `active=${r.active} displayOrder=${r.displayOrder} ` +
          `display="${r.priceDisplay ?? ''}${r.pricePeriod ?? ''}"`,
      );
    }
  }

  // -------------------------------------------------------------------
  // Before counts.
  // -------------------------------------------------------------------
  const beforeIpre = await db
    .select()
    .from(stripePlans)
    .where(eq(stripePlans.workflowKey, TARGET_WORKFLOW_KEY));
  console.log(`\nBefore: ${beforeIpre.length} ${TARGET_WORKFLOW_KEY} row(s).`);

  // -------------------------------------------------------------------
  // SELECT-first idempotency. Insert only if no row with this
  // (workflow_key, stripe_price_id) pair exists.
  // -------------------------------------------------------------------
  let inserted = 0;
  let skippedExisting = 0;
  let skippedPlaceholder = 0;

  for (const plan of PLANS) {
    if (plan.stripePriceId.startsWith('price_TBD_')) {
      console.warn(
        `SKIP ${plan.planName}: stripePriceId is still placeholder '${plan.stripePriceId}'. ` +
          `Fill it in before running.`,
      );
      skippedPlaceholder += 1;
      continue;
    }

    const existing = await db
      .select({ id: stripePlans.id })
      .from(stripePlans)
      .where(
        and(
          eq(stripePlans.workflowKey, TARGET_WORKFLOW_KEY),
          eq(stripePlans.stripePriceId, plan.stripePriceId),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      console.log(`Skip ${plan.planName} (${plan.stripePriceId}): already present.`);
      skippedExisting += 1;
      continue;
    }

    const row: NewStripePlan = {
      planName: plan.planName,
      workflowKey: TARGET_WORKFLOW_KEY,
      stripePriceId: plan.stripePriceId,
      active: plan.active,
      description: plan.description,
      priceDisplay: plan.priceDisplay,
      pricePeriod: plan.pricePeriod,
      billingDetail: plan.billingDetail,
      footnote: plan.footnote,
      highlight: plan.highlight,
      displayOrder: plan.displayOrder,
    };
    const [out] = await db
      .insert(stripePlans)
      .values(row)
      .returning({ id: stripePlans.id, planName: stripePlans.planName, stripePriceId: stripePlans.stripePriceId });
    console.log(`Inserted ${out.planName} (${out.stripePriceId}) id=${out.id}.`);
    inserted += 1;
  }

  // -------------------------------------------------------------------
  // After counts.
  // -------------------------------------------------------------------
  const afterIpre = await db
    .select()
    .from(stripePlans)
    .where(eq(stripePlans.workflowKey, TARGET_WORKFLOW_KEY));
  console.log(`\nAfter: ${afterIpre.length} ${TARGET_WORKFLOW_KEY} row(s).`);
  console.log(`Summary: inserted=${inserted} skippedExisting=${skippedExisting} skippedPlaceholder=${skippedPlaceholder}.`);

  if (skippedPlaceholder > 0) {
    console.warn(
      `\n${skippedPlaceholder} plan row(s) were skipped because their stripePriceId ` +
        `is still a 'price_TBD_*' placeholder. Edit this file and re-run.`,
    );
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
