/**
 * Keyes + IPRE trial churn, split into two buckets:
 *   A — cancelled DURING the trial (card captured, never charged)
 *   B — cancelled within 45 days of the trial ending (paid once, then left)
 *
 * Stripe decides who trialed and when they cancelled. LaunchPad supplies the
 * name, the onboarding call and whether the agent ever actually activated, so
 * an onboarding-process gap can be told apart from a value/pricing decision.
 *
 * Read-only. Usage:
 *   npx tsx --env-file=.env.local scripts/trial-churn-buckets.ts
 *   npx tsx --env-file=.env.local scripts/trial-churn-buckets.ts --months=6
 */
import dotenv from 'dotenv';
import { sql } from 'drizzle-orm';
import Stripe from 'stripe';
import { db } from '@/db';
dotenv.config({ path: '.env.local' });

// Keyes + IPRE agent products (not the legacy $150 Luxury pilot plan).
const B2B_PRODUCTS = new Map<string, string>([
  ['prod_UHwP8GCuGqWDoq', 'Keyes'],
  ['prod_UdLIiChZkVXVZo', 'IPRE'],
]);
// Window: cancellations since this date. Default = last 3 whole months.
const MONTHS_BACK = Number(process.argv.find((a) => /^--months=/.test(a))?.split('=')[1] ?? 3);
const NOW = new Date();
const WINDOW_START = Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - MONTHS_BACK, 1);
const AFTER_TRIAL_DAYS = 45;                 // "immediately after" the trial

const stripe = new Stripe(process.env.STRIPE_LIVE_SECRET_KEY ?? process.env.STRIPE_SECRET_KEY!);
const iso = (ms: number | null) => (ms == null ? '—' : new Date(ms).toISOString().slice(0, 10));

type Row = {
  brand: string; subId: string; custId: string | null;
  stripeName: string | null; stripeEmail: string | null;
  trialStart: number | null; trialEnd: number | null; canceledAt: number | null;
  daysAfterTrial: number | null; paidCount: number; paidTotal: number;
  planUsd: number; cadence: string;
};

async function main() {
console.log('Scanning live Stripe for cancelled Keyes/IPRE trial subscriptions...');
const rows: Row[] = [];
for await (const sub of stripe.subscriptions.list({ status: 'canceled', limit: 100, expand: ['data.items.data.price'] })) {
  const it = sub.items?.data?.[0];
  const price = it?.price;
  const pid = typeof price?.product === 'string' ? price.product : (price?.product as Stripe.Product | undefined)?.id;
  const brand = pid ? B2B_PRODUCTS.get(pid) : undefined;
  if (!brand) continue;
  if (!sub.trial_end) continue;                                  // never trialed
  const canceledAt = sub.canceled_at ? sub.canceled_at * 1000 : null;
  if (canceledAt == null || canceledAt < WINDOW_START) continue; // outside window

  const custId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id ?? null;
  let paidCount = 0, paidTotal = 0;
  for await (const inv of stripe.invoices.list({ subscription: sub.id, limit: 100 })) {
    if (inv.status === 'paid' && (inv.amount_paid ?? 0) > 0) { paidCount++; paidTotal += inv.amount_paid ?? 0; }
  }
  let name: string | null = null, email: string | null = null;
  if (custId) {
    try { const c = await stripe.customers.retrieve(custId); if (!('deleted' in c && c.deleted)) { name = (c as Stripe.Customer).name ?? null; email = (c as Stripe.Customer).email ?? null; } } catch { /* ignore */ }
  }
  const trialEnd = sub.trial_end * 1000;
  rows.push({
    brand, subId: sub.id, custId, stripeName: name, stripeEmail: email,
    trialStart: sub.trial_start ? sub.trial_start * 1000 : null, trialEnd, canceledAt,
    daysAfterTrial: Math.round((canceledAt - trialEnd) / 86400000),
    paidCount, paidTotal,
    planUsd: (price?.unit_amount ?? 0) / 100,
    cadence: `${price?.recurring?.interval_count ?? 1}${(price?.recurring?.interval ?? '?')[0]}`,
  });
}
console.log(`  ${rows.length} cancelled Keyes/IPRE trial sub(s) with a cancellation since ${iso(WINDOW_START)}`);

// ---- LP enrichment: name, onboarding call, did they ever activate ----
// Pull every Keyes/IPRE customer and index in JS — binding a JS array into a
// raw drizzle query casts to record, not text[].
const lp = await db.execute(sql`
  SELECT lower(c.contact_email) AS email, c.stripe_customer_id AS scid,
         COALESCE(c.business_name, c.name) AS nm, c.workflow_key AS wk,
         c.onboarding_state::text AS onb,
         (SELECT max(cl.scheduled_date)::text FROM calls cl WHERE cl.customer_id=c.id AND cl.type='Onboarding') AS call_date,
         (SELECT max(cl.status::text) FROM calls cl WHERE cl.customer_id=c.id AND cl.type='Onboarding') AS call_status,
         (SELECT s.signal_value_numeric FROM customer_usage_signals s
            WHERE s.customer_id=c.id AND s.signal_type='rejig.total_published_posts'
            ORDER BY s.observed_at DESC LIMIT 1) AS posts,
         (SELECT s.signal_value_jsonb FROM customer_usage_signals s
            WHERE s.customer_id=c.id AND s.signal_type='rejig.last_login'
            ORDER BY s.observed_at DESC LIMIT 1) AS login
  FROM customers c
  WHERE c.workflow_key IN ('B2B-Keyes','B2B-IPRE')`);
type LpRow = { nm: string; wk: string; onb: string | null; call: string | null; callStatus: string | null; posts: number | null; everLoggedIn: boolean | null };
const lpByEmail = new Map<string, LpRow>(); const lpByCust = new Map<string, LpRow>();
for (const r of lp.rows as Array<Record<string, unknown>>) {
  const jb = r.login as { never?: boolean; lastLoginISO?: string | null } | null;
  const v: LpRow = {
    nm: String(r.nm ?? ''), wk: String(r.wk ?? ''), onb: r.onb ? String(r.onb) : null,
    call: r.call_date ? String(r.call_date).slice(0, 10) : null,
    callStatus: r.call_status ? String(r.call_status) : null,
    posts: r.posts != null ? Number(r.posts) : null,
    everLoggedIn: jb == null ? null : !(jb.never === true),
  };
  if (r.email) lpByEmail.set(String(r.email), v);
  if (r.scid) lpByCust.set(String(r.scid), v);
}
const lpFor = (r: Row) => (r.custId ? lpByCust.get(r.custId) : undefined) ?? lpByEmail.get((r.stripeEmail ?? '').toLowerCase());

const during = rows.filter((r) => r.daysAfterTrial! < 0 || r.paidCount === 0);
const after = rows.filter((r) => !during.includes(r) && r.daysAfterTrial! <= AFTER_TRIAL_DAYS);
const later = rows.filter((r) => !during.includes(r) && !after.includes(r));

const render = (title: string, blurb: string, list: Row[]) => {
  console.log('\n' + '='.repeat(100));
  console.log(`  ${title} — ${list.length} agents`);
  console.log(`  ${blurb}`);
  console.log('='.repeat(100));
  if (list.length === 0) { console.log('  (none)'); return; }
  let lost = 0;
  for (const r of list.sort((a, b) => (a.canceledAt ?? 0) - (b.canceledAt ?? 0))) {
    const l = lpFor(r);
    lost += r.planUsd;
    const act = l == null ? 'no LP record'
      : l.everLoggedIn === null ? 'no Rejig signal'
      : !l.everLoggedIn ? 'NEVER logged in'
      : (l.posts ?? 0) === 0 ? 'logged in, never posted'
      : `${l.posts} posts`;
    console.log(`  ${(l?.nm || r.stripeName || '(unknown)').slice(0, 34).padEnd(34)} ${r.brand.padEnd(5)} $${String(r.planUsd).padStart(5)}/${r.cadence.padEnd(3)} trial ended ${iso(r.trialEnd)} · cancelled ${iso(r.canceledAt)} (${r.daysAfterTrial! >= 0 ? '+' : ''}${r.daysAfterTrial}d) · paid ${r.paidCount}x $${(r.paidTotal / 100).toFixed(0)} · ${act}`);
    if (l) console.log(`${' '.repeat(36)}onboarding call ${l.call ?? 'NONE BOOKED'}${l.callStatus ? ' ['+l.callStatus+']' : ''} · LP state ${l.onb ?? '—'} · ${r.stripeEmail ?? ''}`);
  }
  console.log(`\n  Recurring value lost in this bucket: $${lost.toLocaleString()} per cycle`);
};

render('BUCKET A — cancelled DURING the trial (never charged)',
  'Card captured, trial started, cancelled before any money moved.', during);
render(`BUCKET B — cancelled within ${AFTER_TRIAL_DAYS} days of the trial ending`,
  'Paid at least once, then left almost immediately.', after);
if (later.length) render('(context) cancelled later than that', 'Shown for completeness; not an onboarding failure.', later);

// activation summary
const all = [...during, ...after];
const never = all.filter((r) => lpFor(r)?.everLoggedIn === false).length;
const noPost = all.filter((r) => { const l = lpFor(r); return l?.everLoggedIn && (l.posts ?? 0) === 0; }).length;
const noCall = all.filter((r) => !lpFor(r)?.call).length;
console.log('\n' + '='.repeat(100));
console.log('  ONBOARDING SIGNAL across both buckets');
console.log('='.repeat(100));
console.log(`  total agents                  : ${all.length}`);
console.log(`  never logged into Rejig       : ${never}`);
console.log(`  logged in but never posted    : ${noPost}`);
console.log(`  no onboarding call on record   : ${noCall}`);

// ---- cohort rate: of trials that came DUE in the window, how many survived? ----
{
  const E2 = Date.now();
  let due = 0, alive = 0, dead = 0, dDuring = 0, dAfter = 0, dLater = 0;
  const perBrand = new Map<string, { due: number; dead: number }>();
  for await (const sub of stripe.subscriptions.list({ status: 'all', limit: 100, expand: ['data.items.data.price'] })) {
    const it2 = sub.items?.data?.[0];
    const p2 = it2?.price;
    const pid2 = typeof p2?.product === 'string' ? p2.product : (p2?.product as Stripe.Product | undefined)?.id;
    const br = pid2 ? B2B_PRODUCTS.get(pid2) : undefined;
    if (!br || !sub.trial_end) continue;
    const te = sub.trial_end * 1000;
    if (te < WINDOW_START || te > E2) continue;
    due++;
    const b = perBrand.get(br) ?? { due: 0, dead: 0 };
    b.due++;
    if (sub.status === 'canceled') {
      dead++; b.dead++;
      const ca = sub.canceled_at ? sub.canceled_at * 1000 : null;
      const d = ca != null ? Math.round((ca - te) / 86400000) : null;
      if (d == null) dLater++; else if (d < 0) dDuring++; else if (d <= AFTER_TRIAL_DAYS) dAfter++; else dLater++;
    } else alive++;
    perBrand.set(br, b);
  }
  const pc = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(0)}%` : 'n/a');
  console.log('\n' + '='.repeat(100));
  console.log(`  COHORT RATE — trials whose trial END fell in the window (${iso(WINDOW_START)} onward)`);
  console.log('='.repeat(100));
  console.log(`  came due           : ${due}`);
  console.log(`  still active today : ${alive}  (${pc(alive, due)} survived)`);
  console.log(`  cancelled          : ${dead}  (${pc(dead, due)} churned)  — ${dDuring} during trial, ${dAfter} within ${AFTER_TRIAL_DAYS}d, ${dLater} later`);
  for (const [k, v] of perBrand) console.log(`    ${k.padEnd(6)} due ${String(v.due).padStart(3)}  cancelled ${String(v.dead).padStart(3)}  churn ${pc(v.dead, v.due)}`);
}
process.exit(0);
}
main();
