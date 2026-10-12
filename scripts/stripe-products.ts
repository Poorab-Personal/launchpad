/**
 * Stripe subscriptions grouped by PRODUCT — every product, not just the ones
 * LaunchPad sells through `stripe_plans`.
 *
 * Walks the live Stripe subscription list (no price filter), splits each
 * subscription into its ITEMS, and groups those items by Stripe Product. That
 * matters twice over:
 *   - add-ons ride along as a second item on a core subscription (Avatar on a
 *     Luxury Plan sub), so a per-subscription pull would never see them;
 *   - off-menu prices (the Keyes corporate seat price, legacy/beta plans) have
 *     no `stripe_plans` row, so a per-price pull would miss their revenue
 *     entirely. Flagged here as `off-menu`.
 *
 * Seats are a `quantity`, never a named list — the Keyes corporate sub bills 14
 * seats on one item. Counts are reported as items AND seats; revenue always
 * uses quantity.
 *
 * Revenue is the effective monthly rate (a $1,800/yr sub counts $150/mo), so
 * plans on different cadences are comparable. Average price is given two ways:
 * per-month (normalised) and per-charge (what the card is actually hit for).
 *
 * Usage:
 *   npx tsx scripts/stripe-products.ts
 *   npx tsx scripts/stripe-products.ts --exclude @rejig.ai
 *   npx tsx scripts/stripe-products.ts --summary          # product rows only
 *   npx tsx scripts/stripe-products.ts --product avatar   # drill into matches
 *   npx tsx scripts/stripe-products.ts --status active    # default: active,trialing
 *   npx tsx scripts/stripe-products.ts --csv
 */
import dotenv from 'dotenv';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type Stripe from 'stripe';

dotenv.config({ path: '.env.local' });

type Args = {
  statuses: Array<'active' | 'trialing' | 'past_due' | 'unpaid' | 'paused'>;
  exclude: string[];
  summary: boolean;
  product: string | null;
  csv: boolean;
};

const STATUSES = ['active', 'trialing', 'past_due', 'unpaid', 'paused'] as const;

function parseArgs(argv: string[]): Args {
  let statuses: Args['statuses'] = ['active', 'trialing'];
  const exclude: string[] = [];
  let summary = false;
  let product: string | null = null;
  let csv = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--status') {
      const raw = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const bad = raw.filter((s) => !STATUSES.includes(s as never));
      if (bad.length) { console.error(`--status must be one of ${STATUSES.join(',')} (got ${bad.join(',')})`); process.exit(2); }
      statuses = raw as Args['statuses'];
    } else if (a === '--exclude') {
      exclude.push(...(argv[++i] ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
    } else if (a === '--product') product = (argv[++i] ?? '').trim().toLowerCase() || null;
    else if (a === '--summary') summary = true;
    else if (a === '--csv') csv = true;
    else { console.error(`Unknown flag: ${a}`); process.exit(2); }
  }
  if (statuses.length === 0) { console.error('--status needs at least one status'); process.exit(2); }
  return { statuses, exclude, summary, product, csv };
}

/** Effective monthly dollars for one unit of a recurring price. */
function effectiveMonthly(dollars: number, unit: string, count: number): number {
  if (unit === 'month') return dollars / count;
  if (unit === 'year') return dollars / (12 * count);
  if (unit === 'week') return (dollars * 52) / (12 * count);
  if (unit === 'day') return (dollars * 365) / (12 * count);
  return dollars;
}

/**
 * Coarse family for the rollup. Product names are the only signal Stripe gives
 * (there is no product metadata convention in this account), so this is a
 * naming heuristic — the rollup prints its members so a miscategorised product
 * is visible rather than silently folded in.
 */
function family(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('avatar') && n.includes('voice')) return 'Avatar + Voice';
  if (n.includes('avatar')) return 'Avatar';
  if (n.includes('voice')) return 'Voice';
  if (n.includes('search visibility') || n.includes('rival')) return 'AI Search Visibility';
  if (n.includes('setup fee') || n.includes('deposit')) return 'Setup / one-time';
  if (n.includes('design support')) return 'Add-on services';
  return 'Core subscription';
}

const usd0 = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const usd2 = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const isoDate = (sec: number | null | undefined) =>
  sec ? new Date(sec * 1000).toISOString().slice(0, 10) : '';

type ItemRow = {
  productId: string;
  productName: string;
  priceId: string;
  priceNickname: string;
  status: string;
  cadence: string;        // "/mo", "/3 months", "/yr"
  chargeAmount: number;   // unit_amount dollars (one unit, one charge)
  quantity: number;
  monthly: number;        // effective monthly for the whole item (× quantity)
  customerId: string;
  customerName: string;
  customerEmail: string;
  subId: string;
  created: string;
  currentPeriodEnd: string;
  onMenu: boolean;        // has a stripe_plans row
};

function cadenceLabel(unit: string, count: number): string {
  if (count === 1) return unit === 'month' ? '/mo' : unit === 'year' ? '/yr' : `/${unit}`;
  return `/${count} ${unit}s`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stripeSecret = process.env.STRIPE_LIVE_SECRET_KEY ?? process.env.STRIPE_SECRET_KEY;
  if (!stripeSecret) throw new Error('STRIPE_LIVE_SECRET_KEY or STRIPE_SECRET_KEY required');
  if (!stripeSecret.startsWith('sk_live_')) {
    console.warn(`  ⚠ Stripe key is non-live (${stripeSecret.slice(0, 8)}…) — this is a test-mode pull.`);
  }
  const Stripe = (await import('stripe')).default;
  const stripe = new Stripe(stripeSecret);

  // stripe_plans is used ONLY to mark which prices are on the menu. It never
  // filters the pull: a price missing here is the thing we most want to see.
  const { db } = await import('../src/db');
  const schema = await import('../src/db/schema');
  const planRows = await db
    .select({
      priceId: schema.stripePlans.stripePriceId,
      planName: schema.stripePlans.planName,
      workflowKey: schema.stripePlans.workflowKey,
    })
    .from(schema.stripePlans);
  const menu = new Map(planRows.map((p) => [p.priceId, p]));

  const isExcluded = (email: string, name: string) =>
    args.exclude.some((x) => email.toLowerCase().includes(x) || name.toLowerCase().includes(x));

  // Pull every subscription in the requested statuses, expanding the customer
  // so we can name/exclude rows without a second round trip per sub.
  const rows: ItemRow[] = [];
  const skipped: string[] = [];
  const productNames = new Map<string, string>();
  let subCount = 0;
  let excludedSubs = 0;

  for (const status of args.statuses) {
    let starting_after: string | undefined;
    while (true) {
      const page = await stripe.subscriptions.list({
        status,
        limit: 100,
        starting_after,
        expand: ['data.customer'],
      });
      for (const sub of page.data) {
        const cust = sub.customer as Stripe.Customer | Stripe.DeletedCustomer | string;
        const custObj =
          typeof cust === 'object' && !('deleted' in cust && cust.deleted) ? (cust as Stripe.Customer) : null;
        const customerId = typeof cust === 'string' ? cust : cust.id;
        const email = custObj?.email ?? '';
        const name = custObj?.name ?? '';
        if (isExcluded(email, name)) { excludedSubs++; continue; }
        subCount++;

        for (const item of sub.items.data) {
          const price = item.price;
          const rec = price.recurring;
          const productId = typeof price.product === 'string' ? price.product : price.product.id;
          if (!productNames.has(productId)) {
            if (typeof price.product === 'object' && 'name' in price.product) {
              productNames.set(productId, price.product.name);
            } else {
              const p = await stripe.products.retrieve(productId);
              productNames.set(productId, p.name);
            }
          }
          if (price.unit_amount == null || !rec) {
            // Tiered / metered / one-off price: no single unit amount to average.
            skipped.push(`${productNames.get(productId)} · ${price.id} (${price.billing_scheme}/${price.type}) sub=${sub.id}`);
            continue;
          }
          const dollars = price.unit_amount / 100;
          const qty = item.quantity ?? 1;
          rows.push({
            productId,
            productName: productNames.get(productId) ?? productId,
            priceId: price.id,
            priceNickname: price.nickname ?? '',
            status: sub.status,
            cadence: cadenceLabel(rec.interval, rec.interval_count),
            chargeAmount: dollars,
            quantity: qty,
            monthly: effectiveMonthly(dollars, rec.interval, rec.interval_count) * qty,
            customerId,
            customerName: name,
            customerEmail: email,
            subId: sub.id,
            created: isoDate(sub.created),
            currentPeriodEnd: isoDate((item as unknown as { current_period_end?: number }).current_period_end),
            onMenu: menu.has(price.id),
          });
        }
      }
      if (!page.has_more) break;
      starting_after = page.data[page.data.length - 1].id;
    }
  }

  // ---- Aggregate: product -> price ----
  type Agg = {
    productId: string;
    productName: string;
    items: number;
    seats: number;
    trialItems: number;
    customers: Set<string>;
    monthly: number;
    chargeSum: number; // sum of (unit_amount × qty), for avg per-charge
    prices: Map<string, { items: number; seats: number; trialItems: number; charge: number; cadence: string; monthly: number; onMenu: boolean; planName: string | null }>;
  };
  const byProduct = new Map<string, Agg>();
  for (const r of rows) {
    let a = byProduct.get(r.productId);
    if (!a) {
      a = { productId: r.productId, productName: r.productName, items: 0, seats: 0, trialItems: 0, customers: new Set(), monthly: 0, chargeSum: 0, prices: new Map() };
      byProduct.set(r.productId, a);
    }
    a.items++;
    a.seats += r.quantity;
    if (r.status === 'trialing') a.trialItems++;
    a.customers.add(r.customerId);
    a.monthly += r.monthly;
    a.chargeSum += r.chargeAmount * r.quantity;
    let p = a.prices.get(r.priceId);
    if (!p) {
      p = { items: 0, seats: 0, trialItems: 0, charge: r.chargeAmount, cadence: r.cadence, monthly: 0, onMenu: r.onMenu, planName: menu.get(r.priceId)?.planName ?? null };
      a.prices.set(r.priceId, p);
    }
    p.items++;
    p.seats += r.quantity;
    if (r.status === 'trialing') p.trialItems++;
    p.monthly += r.monthly;
  }
  const aggs = [...byProduct.values()].sort((a, b) => b.monthly - a.monthly);

  // ---- Output ----
  const statusLabel = args.statuses.join(' + ');
  console.log(`\nStripe subscriptions by product — ${new Date().toISOString().slice(0, 10)}`);
  console.log(`Statuses: ${statusLabel}   Subscriptions: ${subCount}   Items: ${rows.length}`);
  if (args.exclude.length) console.log(`Excluded (name/email contains ${args.exclude.join(', ')}): ${excludedSubs} subscription(s)`);
  console.log(`Revenue = effective monthly rate (annual/6-month plans normalised). "charge" = what the card is hit for per billing cycle.\n`);

  const nameW = Math.max(28, ...aggs.map((a) => a.productName.length));
  const head = `${'PRODUCT'.padEnd(nameW)}  ${'SUBS'.padStart(5)} ${'TRIAL'.padStart(5)} ${'SEATS'.padStart(5)} ${'MRR'.padStart(10)} ${'AVG $/MO'.padStart(9)} ${'AVG CHARGE'.padStart(11)}`;
  console.log(head);
  console.log('-'.repeat(head.length));
  for (const a of aggs) {
    const avgMonthly = a.monthly / a.items;
    const avgCharge = a.chargeSum / a.items;
    console.log(
      `${a.productName.padEnd(nameW)}  ${String(a.items).padStart(5)} ${String(a.trialItems).padStart(5)} ${String(a.seats).padStart(5)} ${usd0(a.monthly).padStart(10)} ${usd2(avgMonthly).padStart(9)} ${usd2(avgCharge).padStart(11)}`,
    );
    if (args.summary) continue;
    const prices = [...a.prices.entries()].sort((x, y) => y[1].monthly - x[1].monthly);
    for (const [priceId, p] of prices) {
      const tag = p.onMenu ? `on-menu: ${p.planName}` : 'off-menu (no stripe_plans row)';
      const seats = p.seats !== p.items ? ` (${p.seats} seats)` : '';
      const trial = p.trialItems ? `, ${p.trialItems} trialing` : '';
      console.log(
        `${' '.repeat(2)}· ${usd2(p.charge)}${p.cadence}  ×${p.items}${seats}${trial}  → ${usd0(p.monthly)}/mo  ${priceId}  [${tag}]`,
      );
    }
  }
  console.log('-'.repeat(head.length));
  const totItems = rows.length;
  const totSeats = rows.reduce((s, r) => s + r.quantity, 0);
  const totTrial = rows.filter((r) => r.status === 'trialing').length;
  const totMonthly = rows.reduce((s, r) => s + r.monthly, 0);
  const totCharge = rows.reduce((s, r) => s + r.chargeAmount * r.quantity, 0);
  console.log(
    `${'TOTAL'.padEnd(nameW)}  ${String(totItems).padStart(5)} ${String(totTrial).padStart(5)} ${String(totSeats).padStart(5)} ${usd0(totMonthly).padStart(10)} ${usd2(totMonthly / totItems).padStart(9)} ${usd2(totCharge / totItems).padStart(11)}`,
  );

  // Family rollup — members listed so a naming miscategorisation is visible.
  const byFamily = new Map<string, { items: number; seats: number; monthly: number; products: string[] }>();
  for (const a of aggs) {
    const f = family(a.productName);
    const e = byFamily.get(f) ?? { items: 0, seats: 0, monthly: 0, products: [] };
    e.items += a.items;
    e.seats += a.seats;
    e.monthly += a.monthly;
    e.products.push(a.productName);
    byFamily.set(f, e);
  }
  console.log('\nRollup by family (heuristic on product name — members listed):');
  for (const [f, e] of [...byFamily].sort((x, y) => y[1].monthly - x[1].monthly)) {
    console.log(`  ${f.padEnd(22)} ${String(e.items).padStart(4)} subs  ${String(e.seats).padStart(4)} seats  ${usd0(e.monthly).padStart(9)}/mo  avg ${usd2(e.monthly / e.items)}/mo`);
    console.log(`  ${' '.repeat(22)} ${e.products.join(', ')}`);
  }

  // Multi-item subscriptions = a core plan plus an add-on on one bill.
  const bySub = new Map<string, ItemRow[]>();
  for (const r of rows) bySub.set(r.subId, [...(bySub.get(r.subId) ?? []), r]);
  const multi = [...bySub.entries()].filter(([, items]) => items.length > 1);
  if (multi.length) {
    console.log(`\nMulti-product subscriptions (${multi.length}) — one bill, two products:`);
    for (const [subId, items] of multi) {
      console.log(`  ${items[0].customerName || items[0].customerEmail || items[0].customerId}  ${subId}  ${items.map((i) => `${i.productName} ${usd2(i.chargeAmount)}${i.cadence}`).join('  +  ')}`);
    }
  }

  // Seat-bearing items: a quantity > 1 is a group plan, not a single agent.
  const seated = rows.filter((r) => r.quantity > 1).sort((a, b) => b.quantity - a.quantity);
  if (seated.length) {
    console.log(`\nItems billing more than one seat (${seated.length}) — group plans, not individual agents:`);
    for (const r of seated) {
      console.log(`  ${(r.customerName || r.customerEmail || r.customerId).padEnd(32)} ${String(r.quantity).padStart(3)} × ${usd2(r.chargeAmount)}${r.cadence}  ${r.productName}  ${r.subId}`);
    }
  }

  // Every other product in the account, so "all products" is verifiable rather
  // than just "all products that happen to have a live subscription".
  const idle: string[] = [];
  for await (const p of stripe.products.list({ limit: 100 })) {
    if (!byProduct.has(p.id)) idle.push(p.name);
  }
  if (idle.length) {
    console.log(`\nProducts with no ${statusLabel} subscription (${idle.length}): ${idle.sort().join(', ')}`);
  }

  if (skipped.length) {
    console.log(`\n⚠ ${skipped.length} item(s) had no flat unit amount (tiered/metered) and are excluded from revenue:`);
    for (const s of skipped) console.log(`  ${s}`);
  }

  // Drill-down: every customer on the matching product(s).
  if (args.product) {
    const matches = rows.filter((r) => r.productName.toLowerCase().includes(args.product!));
    console.log(`\nCustomers on products matching "${args.product}" (${matches.length} item(s)):`);
    for (const r of matches.sort((a, b) => a.productName.localeCompare(b.productName) || b.monthly - a.monthly)) {
      console.log(
        `  ${r.productName.padEnd(nameW)}  ${(r.customerName || '(no name)').padEnd(28)} ${(r.customerEmail || '-').padEnd(34)} ${usd2(r.chargeAmount)}${r.cadence}${r.quantity > 1 ? ` ×${r.quantity}` : ''}  ${r.status.padEnd(9)} renews ${r.currentPeriodEnd || '-'}  ${r.subId}`,
      );
    }
  }

  if (args.csv) {
    const stamp = new Date().toISOString().slice(0, 10);
    const esc = (v: string | number | boolean) => {
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const prodCsv = [
      ['product', 'product_id', 'subs', 'trialing', 'seats', 'distinct_customers', 'mrr', 'avg_monthly', 'avg_charge', 'family'].join(','),
      ...aggs.map((a) =>
        [a.productName, a.productId, a.items, a.trialItems, a.seats, a.customers.size, a.monthly.toFixed(2), (a.monthly / a.items).toFixed(2), (a.chargeSum / a.items).toFixed(2), family(a.productName)].map(esc).join(','),
      ),
    ].join('\n');
    const itemCsv = [
      ['product', 'price_id', 'plan_on_menu', 'charge_amount', 'cadence', 'quantity', 'monthly', 'status', 'customer_name', 'customer_email', 'subscription_id', 'created', 'current_period_end'].join(','),
      ...rows.map((r) =>
        [r.productName, r.priceId, r.onMenu ? (menu.get(r.priceId)?.planName ?? 'yes') : 'off-menu', r.chargeAmount.toFixed(2), r.cadence, r.quantity, r.monthly.toFixed(2), r.status, r.customerName, r.customerEmail, r.subId, r.created, r.currentPeriodEnd].map(esc).join(','),
      ),
    ].join('\n');
    const pPath = resolve(process.cwd(), `scripts/data/stripe-products-${stamp}.csv`);
    const iPath = resolve(process.cwd(), `scripts/data/stripe-products-items-${stamp}.csv`);
    writeFileSync(pPath, prodCsv);
    writeFileSync(iPath, itemCsv);
    console.log(`\nCSV: ${pPath}\n     ${iPath}`);
  }

  console.log('');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
