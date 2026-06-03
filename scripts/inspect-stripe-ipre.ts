/**
 * Inspect current IPRE Stripe setup (sandbox). Run with the existing
 * STRIPE_SECRET_KEY (sandbox key). Outputs the product + all prices
 * + relevant metadata so we can review before mirroring to live.
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

async function main() {
  const Stripe = (await import('stripe')).default;
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

  const { db } = await import('../src/db');
  const schema = await import('../src/db/schema');
  const { eq } = await import('drizzle-orm');

  // Pull IPRE plans from DB to find the price IDs
  const plans = await db
    .select()
    .from(schema.stripePlans)
    .where(eq(schema.stripePlans.workflowKey, 'B2B-IPRE'));

  console.log(`Found ${plans.length} B2B-IPRE plan(s) in stripe_plans:\n`);

  // Each plan has a stripe_price_id → fetch that price + its product
  const productIds = new Set<string>();
  for (const p of plans) {
    const price = await stripe.prices.retrieve(p.stripePriceId, { expand: ['product'] });
    const product = price.product as import('stripe').Stripe.Product;
    productIds.add(product.id);

    console.log(`─── plan_id=${p.id} ───`);
    console.log(`  workflowKey:     ${p.workflowKey}`);
    console.log(`  planName (DB):   ${p.planName}`);
    console.log(`  priceDisplay:    ${p.priceDisplay}${p.pricePeriod ?? ''}`);
    console.log(`  billingDetail:   ${p.billingDetail ?? '(none)'}`);
    console.log(`  footnote:        ${p.footnote ?? '(none)'}`);
    console.log(`  highlight:       ${p.highlight ?? '(none)'}`);
    console.log(`  displayOrder:    ${p.displayOrder}`);
    console.log(`  active:          ${p.active}`);
    console.log(`  ─ Stripe Price:`);
    console.log(`    id:            ${price.id}`);
    console.log(`    amount:        ${price.unit_amount} ${price.currency} = $${((price.unit_amount ?? 0) / 100).toFixed(2)}`);
    console.log(`    type:          ${price.type}`);
    console.log(`    recurring:     ${JSON.stringify(price.recurring)}`);
    console.log(`    nickname:      ${price.nickname ?? '(none)'}`);
    console.log(`    metadata:      ${JSON.stringify(price.metadata)}`);
    console.log(`  ─ Stripe Product:`);
    console.log(`    id:            ${product.id}`);
    console.log(`    name:          "${product.name}"`);
    console.log(`    description:   ${product.description ?? '(none)'}`);
    console.log(`    statement_descriptor: ${product.statement_descriptor ?? '(none)'}`);
    console.log(`    tax_code:      ${product.tax_code ?? '(none)'}`);
    console.log(`    metadata:      ${JSON.stringify(product.metadata)}`);
    console.log();
  }

  // If multiple plans share a product, list its other prices too
  for (const productId of productIds) {
    const prices = await stripe.prices.list({ product: productId, active: true, limit: 20 });
    console.log(`─── All active prices on product ${productId} (${prices.data.length}) ───`);
    for (const p of prices.data) {
      console.log(`  ${p.id}  $${((p.unit_amount ?? 0) / 100).toFixed(2)}  ${p.recurring ? `${p.recurring.interval_count}${p.recurring.interval}` : 'one-time'}  nickname="${p.nickname ?? ''}"`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
