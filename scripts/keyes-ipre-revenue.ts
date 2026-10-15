/**
 * Keyes + IPRE total revenue — cash actually collected, straight off Stripe.
 *
 * Built Stripe-first: walks every invoice in the account and keeps the ones
 * belonging to a Keyes or IPRE agent. LaunchPad is used only to *identify* who
 * is a Keyes/IPRE agent, never to select or price anything (its subscription
 * mirror fields go stale silently — see CLAUDE.md "Known Data Hazards").
 *
 * Attribution, in precedence order, per Stripe customer:
 *   1. a subscription on the brokerage's own Stripe product
 *      ("Rejig.ai for Keyes Agents" / "IPRE - Rejig.ai")
 *   2. a LaunchPad customer row with workflow_key B2B-Keyes / B2B-IPRE, matched
 *      by stripe_customer_id, then email, then normalised name key — agents
 *      bill under spouse / LLC / personal identities, so email alone loses real
 *      payers (docs/integrations/keyes-pilot-to-individual.md)
 *   3. email domain (@keyes.com, @onekeyes.com / @ipre.com) as a last resort
 *
 * THE PILOT / CORPORATE SUBSCRIPTION (sub_1SVaSP…, Mike Pappas):
 *   Nov 2025 - May 2026  25 seats x $150 = $2,250/mo   pilot era   -> EXCLUDED
 *   Jun 2026 onwards     14 seats x $150 = $1,260/mo   corporate   -> INCLUDED
 * Seat quantity is a pricing lever, not a headcount. The split is driven by the
 * invoice amount, and both sides are printed so the cut is auditable.
 *
 * Refunds are netted against the invoice they reversed (so they land in the
 * month the money came in, not the month it went back out) — a charge handed
 * back never counts as revenue.
 *
 * Usage:
 *   npx tsx scripts/keyes-ipre-revenue.ts
 *   npx tsx scripts/keyes-ipre-revenue.ts --no-monthly   # totals only
 *   npx tsx scripts/keyes-ipre-revenue.ts --csv
 */
import dotenv from 'dotenv';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type Stripe from 'stripe';

dotenv.config({ path: '.env.local' });

const PILOT_SUB = 'sub_1SVaSPCQTlvKI2ANEPPEOtMI';
const PILOT_ERA_CENTS = 225000; // $2,250 = 25 seats; the excluded pilot-era amount

const KEYES_PRODUCT_RE = /keyes/i;
const IPRE_PRODUCT_RE = /^ipre\b/i;
const KEYES_DOMAINS = ['keyes.com', 'onekeyes.com'];
const IPRE_DOMAINS = ['ipre.com'];

type Brand = 'Keyes' | 'IPRE';

const usd0 = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const month = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 7);

/**
 * Name key for cross-identity matching: lowercased letters only, sorted words.
 * Returns '' for anything under two words — LaunchPad has a Keyes customer
 * named just "Michelle ", and a one-word key happily matches strangers (it
 * pulled in two unrelated @kw.com customers before this guard).
 */
function nameKey(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/\b(team|group|llc|inc|pa|pllc|realty|realtor|real estate|the)\b/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 1);
  if (cleaned.length < 2) return '';
  return cleaned.sort().join(' ');
}

async function main() {
  const argv = process.argv.slice(2);
  const monthly = !argv.includes('--no-monthly');
  const csv = argv.includes('--csv');
  for (const a of argv) if (!['--no-monthly', '--csv'].includes(a)) { console.error(`Unknown flag: ${a}`); process.exit(2); }

  const secret = process.env.STRIPE_LIVE_SECRET_KEY ?? process.env.STRIPE_SECRET_KEY;
  if (!secret) throw new Error('STRIPE_LIVE_SECRET_KEY or STRIPE_SECRET_KEY required');
  if (!secret.startsWith('sk_live_')) console.warn(`  ⚠ non-live Stripe key (${secret.slice(0, 8)}…)`);
  const Stripe = (await import('stripe')).default;
  const stripe = new Stripe(secret);

  // ---- 1. LaunchPad identity index (identification only, never selection) ----
  const { db } = await import('../src/db');
  const { sql } = await import('drizzle-orm');
  const lpRows = (await db.execute(sql`
    select workflow_key, name, contact_email, platform_email, stripe_customer_id
    from customers where workflow_key in ('B2B-Keyes','B2B-IPRE')`)).rows as Array<{
      workflow_key: string; name: string | null; contact_email: string | null;
      platform_email: string | null; stripe_customer_id: string | null;
    }>;
  const byStripeCust = new Map<string, Brand>();
  const byEmail = new Map<string, Brand>();
  const byName = new Map<string, Brand>();
  for (const r of lpRows) {
    const brand: Brand = r.workflow_key === 'B2B-Keyes' ? 'Keyes' : 'IPRE';
    if (r.stripe_customer_id) byStripeCust.set(r.stripe_customer_id, brand);
    for (const e of [r.contact_email, r.platform_email]) {
      if (e) byEmail.set(e.trim().toLowerCase(), brand);
    }
    if (r.name) {
      const k = nameKey(r.name);
      if (k && !byName.has(k)) byName.set(k, brand);
    }
  }
  console.log(`LaunchPad identity index: ${lpRows.length} Keyes/IPRE customer rows → ${byEmail.size} emails, ${byName.size} name keys, ${byStripeCust.size} stripe customer ids`);

  // ---- 2. Stripe product map, so brand products can be recognised by price ----
  const productBrand = new Map<string, Brand>();
  for await (const p of stripe.products.list({ limit: 100 })) {
    if (KEYES_PRODUCT_RE.test(p.name)) productBrand.set(p.id, 'Keyes');
    else if (IPRE_PRODUCT_RE.test(p.name)) productBrand.set(p.id, 'IPRE');
  }

  // ---- 3. Every subscription (all statuses): customer identity + brand signal ----
  type CustInfo = { id: string; name: string; email: string; brand: Brand | null; via: string; subIds: Set<string> };
  const custs = new Map<string, CustInfo>();
  const subToCust = new Map<string, string>();
  let subTotal = 0;
  for await (const sub of stripe.subscriptions.list({ status: 'all', limit: 100, expand: ['data.customer'] })) {
    subTotal++;
    const c = sub.customer as Stripe.Customer | Stripe.DeletedCustomer | string;
    const id = typeof c === 'string' ? c : c.id;
    const obj = typeof c === 'object' && !('deleted' in c && c.deleted) ? (c as Stripe.Customer) : null;
    const email = (obj?.email ?? '').trim().toLowerCase();
    const name = obj?.name ?? '';
    subToCust.set(sub.id, id);
    let info = custs.get(id);
    if (!info) { info = { id, name, email, brand: null, via: '', subIds: new Set() }; custs.set(id, info); }
    info.subIds.add(sub.id);
    if (!info.name && name) info.name = name;
    if (!info.email && email) info.email = email;
    // Signal 1 (strongest): a subscription on the brokerage's own product.
    for (const item of sub.items.data) {
      const prodId = typeof item.price.product === 'string' ? item.price.product : item.price.product.id;
      const b = productBrand.get(prodId);
      if (b) { info.brand = b; info.via = 'brand product'; }
    }
  }

  // Signals 2 and 3 for customers the product signal did not settle.
  for (const info of custs.values()) {
    if (info.brand) continue;
    const byId = byStripeCust.get(info.id);
    if (byId) { info.brand = byId; info.via = 'LP stripe_customer_id'; continue; }
    const byMail = info.email ? byEmail.get(info.email) : undefined;
    if (byMail) { info.brand = byMail; info.via = 'LP email'; continue; }
    const k = info.name ? nameKey(info.name) : '';
    const byNm = k ? byName.get(k) : undefined;
    if (byNm) { info.brand = byNm; info.via = 'LP name key'; continue; }
    const domain = info.email.split('@')[1] ?? '';
    if (KEYES_DOMAINS.includes(domain)) { info.brand = 'Keyes'; info.via = 'email domain'; continue; }
    if (IPRE_DOMAINS.includes(domain)) { info.brand = 'IPRE'; info.via = 'email domain'; continue; }
  }
  const keyesCusts = [...custs.values()].filter((c) => c.brand === 'Keyes');
  const ipreCusts = [...custs.values()].filter((c) => c.brand === 'IPRE');
  console.log(`Stripe: ${subTotal} subscriptions (all statuses) across ${custs.size} customers → Keyes ${keyesCusts.length}, IPRE ${ipreCusts.length}`);
  const viaCount = new Map<string, number>();
  for (const c of [...keyesCusts, ...ipreCusts]) viaCount.set(`${c.brand} via ${c.via}`, (viaCount.get(`${c.brand} via ${c.via}`) ?? 0) + 1);
  for (const [k, v] of [...viaCount].sort()) console.log(`  ${k}: ${v}`);
  // The fuzzy matches are the ones that can go wrong, so they are always named.
  const fuzzy = [...keyesCusts, ...ipreCusts].filter((c) => c.via === 'LP name key' || c.via === 'email domain');
  if (fuzzy.length) {
    console.log('  Fuzzy-matched customers (verify these):');
    for (const c of fuzzy) console.log(`    ${c.brand.padEnd(5)} ${c.via.padEnd(12)} ${(c.name || '(no name)').padEnd(30)} ${c.email || '-'}`);
  }

  // ---- 4. Refund map, keyed by PaymentIntent ----
  // The 2026-04-22 API exposes no charge→invoice or payment_intent→invoice
  // pointer, so refunds are matched to invoices from the invoice side: the
  // invoice walk below expands `payments`, which carries the PI id.
  const refundByPi = new Map<string, number>();
  let refundCount = 0;
  for await (const r of stripe.refunds.list({ limit: 100 })) {
    if (r.status !== 'succeeded') continue;
    const piId = typeof r.payment_intent === 'string' ? r.payment_intent : r.payment_intent?.id;
    if (!piId) continue;
    refundCount++;
    refundByPi.set(piId, (refundByPi.get(piId) ?? 0) + r.amount);
  }
  console.log(`Refunds all-time: ${refundCount} succeeded, ${refundByPi.size} payment intents`);

  // ---- 5. Walk every invoice once; collect paid cash for attributed customers ----
  type CashRow = {
    custId: string; brand: Brand; month: string; net: number; gross: number;
    onBrandProduct: boolean; isPilot: boolean; hasSub: boolean;
  };
  const cash: CashRow[] = [];
  let refundedApplied = 0;
  let invTotal = 0;
  let pilotExcluded = 0;
  let pilotExcludedCount = 0;

  for await (const inv of stripe.invoices.list({ limit: 100, expand: ['data.payments'] })) {
    invTotal++;
    if (inv.status !== 'paid') continue;
    const paidAt = inv.status_transitions?.paid_at;
    if (!paidAt) continue;
    const custId = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id;
    if (!custId) continue;
    const info = custs.get(custId);
    if (!info?.brand) continue;

    const gross = inv.amount_paid ?? 0;
    // Net out refunds via the payment intents on this invoice. The 2026-04-22
    // API exposes no charge→invoice pointer, so the match runs invoice→PI.
    const pis = ((inv as unknown as { payments?: { data?: Array<{ payment?: { payment_intent?: string | null } }> } }).payments?.data ?? [])
      .map((pay) => pay.payment?.payment_intent)
      .filter((x): x is string => !!x);
    let refunded = 0;
    for (const pi of pis) refunded += refundByPi.get(pi) ?? 0;
    const netCents = gross - refunded;
    refundedApplied += refunded / 100;
    if (netCents <= 0) continue;

    // Which subscription? In this API version it is on parent.subscription_details,
    // not the removed top-level `subscription` field.
    const parent = (inv as unknown as {
      parent?: { subscription_details?: { subscription?: string | { id: string } | null } | null } | null;
    }).parent;
    const rawSub = parent?.subscription_details?.subscription ?? null;
    const subId =
      (typeof rawSub === 'string' ? rawSub : rawSub?.id) ??
      (inv.lines.data
        .map((l) => {
          const lp = (l as unknown as {
            parent?: { subscription_item_details?: { subscription?: string | null } | null } | null;
          }).parent;
          return lp?.subscription_item_details?.subscription ?? null;
        })
        .find(Boolean) ?? null);

    // The pilot/corporate subscription: $2,250 (25 seats) pilot era is excluded,
    // $1,260 (14 seats) corporate era counts. Driven by the invoiced amount.
    if (subId === PILOT_SUB && gross >= PILOT_ERA_CENTS) {
      pilotExcluded += gross / 100;
      pilotExcludedCount++;
      continue;
    }

    // Is THIS invoice on the brokerage's own product? Read the line's own
    // price, not the subscription's current price: a legacy D2C subscription
    // later switched onto a Keyes price would otherwise drag its whole
    // pre-Keyes history into the brokerage era.
    const onBrandProduct = inv.lines.data.some((l) => {
      const prod = (l as unknown as {
        pricing?: { price_details?: { product?: string | null } | null } | null;
      }).pricing?.price_details?.product;
      return prod ? productBrand.get(prod) === info.brand : false;
    });

    cash.push({
      custId,
      brand: info.brand,
      month: month(paidAt),
      net: netCents / 100,
      gross: gross / 100,
      onBrandProduct,
      isPilot: subId === PILOT_SUB,
      hasSub: !!subId,
    });
  }

  // When did each brokerage's billing actually start? = first cash on the
  // brokerage's own product (or the pilot sub, for Keyes). Money an attributed
  // customer paid before that is legacy D2C revenue they earned under a
  // different relationship, so it is reported apart from brokerage revenue
  // rather than silently inflating it.
  // Per customer where possible (their own first brand-product invoice), with
  // the brand-wide first as the fallback for anyone attributed by identity who
  // never bought the core product — an add-on-only payer, or a second Stripe
  // identity for an agent who pays the core plan under another one.
  const eraStart: Partial<Record<Brand, string>> = {};
  const custEraStart = new Map<string, string>();
  for (const r of cash) {
    if (!r.onBrandProduct && !r.isPilot) continue;
    const cur = eraStart[r.brand];
    if (!cur || r.month < cur) eraStart[r.brand] = r.month;
    const cc = custEraStart.get(r.custId);
    if (!cc || r.month < cc) custEraStart.set(r.custId, r.month);
  }
  console.log(`Invoices scanned: ${invTotal}; refunds netted out: ${usd0(refundedApplied)}`);
  console.log(`Brokerage billing starts: Keyes ${eraStart.Keyes ?? 'n/a'}, IPRE ${eraStart.IPRE ?? 'n/a'}\n`);

  // ---- 6. Bucket the cash ----
  type Bucket = 'Keyes agents' | 'IPRE agents' | 'Keyes corporate' | 'Pre-brokerage';
  const BUCKETS: Bucket[] = ['Keyes agents', 'IPRE agents', 'Keyes corporate'];
  const blank = (): Record<Bucket, number> =>
    ({ 'Keyes agents': 0, 'IPRE agents': 0, 'Keyes corporate': 0, 'Pre-brokerage': 0 });
  const monthTotals = new Map<string, Record<Bucket, number>>();
  const bucketTotal = blank();
  const payers: Record<Bucket, Set<string>> = {
    'Keyes agents': new Set(), 'IPRE agents': new Set(), 'Keyes corporate': new Set(), 'Pre-brokerage': new Set(),
  };
  const preRows: CashRow[] = [];

  for (const r of cash) {
    const era = custEraStart.get(r.custId) ?? eraStart[r.brand];
    let bucket: Bucket;
    if (r.isPilot) bucket = 'Keyes corporate';
    else if (era && r.month < era) { bucket = 'Pre-brokerage'; preRows.push(r); }
    else bucket = r.brand === 'Keyes' ? 'Keyes agents' : 'IPRE agents';
    const row = monthTotals.get(r.month) ?? blank();
    row[bucket] += r.net;
    monthTotals.set(r.month, row);
    bucketTotal[bucket] += r.net;
    payers[bucket].add(r.custId);
  }

  const grand = BUCKETS.reduce((t, b) => t + bucketTotal[b], 0);

  if (monthly) {
    const head = `${'MONTH'.padEnd(9)} ${'KEYES AGENTS'.padStart(13)} ${'IPRE AGENTS'.padStart(12)} ${'KEYES CORP'.padStart(11)} ${'TOTAL'.padStart(11)}`;
    console.log(head);
    console.log('-'.repeat(head.length));
    for (const m of [...monthTotals.keys()].sort()) {
      const r = monthTotals.get(m)!;
      const t = BUCKETS.reduce((x, b) => x + r[b], 0);
      if (t === 0) continue; // a pre-brokerage-only month
      console.log(`${m.padEnd(9)} ${usd0(r['Keyes agents']).padStart(13)} ${usd0(r['IPRE agents']).padStart(12)} ${usd0(r['Keyes corporate']).padStart(11)} ${usd0(t).padStart(11)}`);
    }
    console.log('-'.repeat(head.length));
    console.log(`${'TOTAL'.padEnd(9)} ${usd0(bucketTotal['Keyes agents']).padStart(13)} ${usd0(bucketTotal['IPRE agents']).padStart(12)} ${usd0(bucketTotal['Keyes corporate']).padStart(11)} ${usd0(grand).padStart(11)}\n`);
  }

  console.log('TOTAL CASH COLLECTED (net of refunds, all time)');
  for (const b of BUCKETS) {
    console.log(`  ${b.padEnd(16)} ${usd0(bucketTotal[b]).padStart(10)}   ${payers[b].size} paying customer(s)`);
  }
  console.log(`  ${'─'.repeat(16)} ${'─'.repeat(10)}`);
  console.log(`  ${'TOTAL'.padEnd(16)} ${usd0(grand).padStart(10)}`);

  console.log(`\nNot counted:`);
  console.log(`  Pilot-era corporate invoices at $2,250 (25 seats): ${pilotExcludedCount} invoice(s), ${usd0(pilotExcluded)}`);
  if (bucketTotal['Pre-brokerage'] > 0) {
    console.log(`  Pre-brokerage cash from attributed customers (legacy D2C, before the brokerage launched): ${usd0(bucketTotal['Pre-brokerage'])} from ${payers['Pre-brokerage'].size} customer(s)`);
    const byCust = new Map<string, number>();
    for (const r of preRows) byCust.set(r.custId, (byCust.get(r.custId) ?? 0) + r.net);
    for (const [id, amt] of [...byCust].sort((a, b) => b[1] - a[1])) {
      const c = custs.get(id)!;
      console.log(`    ${usd0(amt).padStart(8)}  ${(c.name || '(no name)').padEnd(28)} ${c.email || '-'}  [${c.brand} via ${c.via}]`);
    }
  }

  if (csv) {
    const stamp = new Date().toISOString().slice(0, 10);
    const lines = [
      ['month', 'keyes_agents', 'ipre_agents', 'keyes_corporate', 'total', 'pre_brokerage_excluded'].join(','),
      ...[...monthTotals.keys()].sort().map((m) => {
        const r = monthTotals.get(m)!;
        const t = BUCKETS.reduce((x, b) => x + r[b], 0);
        return [m, r['Keyes agents'].toFixed(2), r['IPRE agents'].toFixed(2), r['Keyes corporate'].toFixed(2), t.toFixed(2), r['Pre-brokerage'].toFixed(2)].join(',');
      }),
      ['TOTAL', bucketTotal['Keyes agents'].toFixed(2), bucketTotal['IPRE agents'].toFixed(2), bucketTotal['Keyes corporate'].toFixed(2), grand.toFixed(2), bucketTotal['Pre-brokerage'].toFixed(2)].join(','),
    ].join('\n');
    const out = resolve(process.cwd(), `scripts/data/keyes-ipre-revenue-${stamp}.csv`);
    writeFileSync(out, lines);
    console.log(`\nCSV: ${out}`);
  }
  console.log('');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
