/**
 * Stripe cohort + growth analytics for a B2B brokerage.
 *
 * Complements scripts/stripe-subs.ts (which answers "what is Stripe billing
 * RIGHT NOW"). This one answers the two time-series questions:
 *
 *   1. TRIAL -> PAID CONVERSION. Of subscriptions that entered a Stripe trial
 *      and whose trial has since ENDED, what share produced at least one real
 *      (non-refunded) payment? In-flight trials are excluded from the
 *      denominator -- they haven't had the chance to convert yet.
 *
 *   2. MONTH-END NET ACTIVE SUBS. For each month-end, how many subs were in a
 *      paying state / a trial state, plus the gross adds and churn that moved
 *      the number. Net change = adds - churn.
 *
 * Everything is derived from Stripe alone -- no LP customer join -- so the
 * Keyes Oct-2025 backfill cohort (which never flowed through LP intake) is
 * counted correctly. Source of truth for "which prices count" is still
 * stripe_plans WHERE workflow_key=<key>.
 *
 * State model per subscription (all fields off the Stripe Subscription):
 *   start    = created
 *   trialEnd = trial_end   (null => never trialed, paying from day one)
 *   end      = ended_at    (null => still live)
 * At a month-end T a sub is:
 *   not counted      if start > T, or end != null && end <= T
 *   Trialing         if trialEnd != null && trialEnd > T
 *   Paying           otherwise
 *
 * Usage:
 *   npx tsx scripts/stripe-cohorts.ts keyes
 *   npx tsx scripts/stripe-cohorts.ts ipre --exclude @rejig.ai
 *   npx tsx scripts/stripe-cohorts.ts keyes --exclude @rejig.ai --json out.json
 */
import dotenv from 'dotenv';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type Stripe from 'stripe';

dotenv.config({ path: '.env.local' });

type Args = { target: string; exclude: string[]; json: string | null; csv: boolean };

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let exclude: string[] = [];
  let json: string | null = null;
  let csv = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--exclude') exclude = (argv[++i] ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    else if (a === '--json') json = argv[++i] ?? null;
    else if (a === '--csv') csv = true;
    else if (a.startsWith('--')) { console.error(`Unknown flag: ${a}`); process.exit(2); }
    else positional.push(a);
  }
  if (positional.length === 0) {
    console.error('Usage: npx tsx scripts/stripe-cohorts.ts <workflow_key|brokerage_slug> [--exclude a,b] [--json path] [--csv]');
    process.exit(2);
  }
  return { target: positional[0], exclude, json, csv };
}

const isoDate = (sec: number | null | undefined) => (sec ? new Date(sec * 1000).toISOString().slice(0, 10) : '');
const monthKey = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 7);

async function resolveWorkflowKey(target: string): Promise<string> {
  if (target.startsWith('B2B-') || target.startsWith('D2C-')) return target;
  const { db } = await import('../src/db');
  const schema = await import('../src/db/schema');
  const { eq } = await import('drizzle-orm');
  const row = await db
    .select({ workflowKey: schema.brokerages.defaultWorkflowKey })
    .from(schema.brokerages)
    .where(eq(schema.brokerages.landingPageSlug, target.toLowerCase()))
    .limit(1);
  if (row.length === 0) { console.error(`No brokerage with slug "${target}".`); process.exit(2); }
  return row[0].workflowKey;
}

type SubRec = {
  subId: string;
  name: string;
  email: string;
  plan: string;
  status: string;
  start: number;
  trialStart: number | null;
  trialEnd: number | null;
  end: number | null; // ended_at
  firstPaidAt: number | null;
  paidInvoices: number;
  grossPaid: number;
  refunded: number;
  netPaid: number;
  converted: boolean; // kept net cash > 0
};

/** Refund total on one invoice: invoice -> payment_intent -> latest_charge.amount_refunded. */
async function invoiceRefunded(stripe: Stripe, invId: string): Promise<number> {
  try {
    const full = (await stripe.invoices.retrieve(invId, { expand: ['payments', 'payment_intent'] })) as unknown as {
      payment_intent?: string | { id?: string } | null;
      payments?: { data?: Array<{ payment?: { payment_intent?: string | null } }> } | null;
    };
    const piField = full.payment_intent;
    const piId =
      (typeof piField === 'string' ? piField : piField?.id ?? null) ??
      full.payments?.data?.[0]?.payment?.payment_intent ??
      null;
    if (!piId) return 0;
    const piObj = (await stripe.paymentIntents.retrieve(piId, { expand: ['latest_charge'] })) as unknown as {
      latest_charge?: { amount_refunded?: number } | string | null;
    };
    const ch = piObj.latest_charge;
    return ch && typeof ch === 'object' ? (ch.amount_refunded ?? 0) / 100 : 0;
  } catch {
    return 0; // lookup failure -> assume not refunded
  }
}

/**
 * Payment history for one sub, with refunds netted across EVERY paid invoice.
 *
 * Checking only the first invoice is wrong: several agents had their opening
 * charge refunded (plan swap, goodwill) and then paid normally for months --
 * Margaret Enos paid 3x/$357 with only the first $119 refunded. She converted.
 * "Converted" therefore means net cash kept > 0, not "first charge stuck".
 */
async function paymentHistory(stripe: Stripe, subId: string) {
  let starting_after: string | undefined;
  let firstPaidAt: number | null = null;
  let paidInvoices = 0;
  let grossPaid = 0;
  let refunded = 0;
  while (true) {
    const page = await stripe.invoices.list({ subscription: subId, status: 'paid', limit: 100, starting_after });
    for (const inv of page.data) {
      const paidAt = inv.status_transitions?.paid_at ?? null;
      const amt = (inv.amount_paid ?? 0) / 100;
      if (paidAt == null || amt <= 0) continue; // $0 invoices (trial-start) are not payments
      paidInvoices++;
      grossPaid += amt;
      if (firstPaidAt == null || paidAt < firstPaidAt) firstPaidAt = paidAt;
      refunded += await invoiceRefunded(stripe, inv.id);
    }
    if (!page.has_more) break;
    starting_after = page.data[page.data.length - 1].id;
  }
  const netPaid = Math.max(0, grossPaid - refunded);
  return { firstPaidAt, paidInvoices, grossPaid, refunded, netPaid, converted: netPaid > 0.005 };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workflowKey = await resolveWorkflowKey(args.target);
  const nowSec = Math.floor(Date.now() / 1000);

  const { db } = await import('../src/db');
  const schema = await import('../src/db/schema');
  const { eq } = await import('drizzle-orm');
  const StripeSdk = (await import('stripe')).default;

  const plans = await db.select().from(schema.stripePlans).where(eq(schema.stripePlans.workflowKey, workflowKey));
  if (plans.length === 0) { console.error(`No stripe_plans rows for workflow_key='${workflowKey}'.`); process.exit(2); }
  const planByPrice = new Map(plans.map((p) => [p.stripePriceId, p]));

  const secret = process.env.STRIPE_LIVE_SECRET_KEY ?? process.env.STRIPE_SECRET_KEY;
  if (!secret) throw new Error('STRIPE_LIVE_SECRET_KEY or STRIPE_SECRET_KEY required');
  if (!secret.startsWith('sk_live_')) console.warn(`  ! Stripe key is non-live (${secret.slice(0, 8)}...).`);
  const stripe = new StripeSdk(secret);

  const isExcluded = (email: string) => args.exclude.some((x) => email.toLowerCase().includes(x));

  console.log(`${workflowKey} plans (${plans.length}):`);
  for (const p of plans) console.log(`  ${p.planName}  ${p.priceDisplay ?? ''}${p.pricePeriod ?? ''}  (${p.stripePriceId})`);
  if (args.exclude.length) console.log(`Excluding emails containing: ${args.exclude.join(', ')}`);

  // 1. Every subscription ever created on these prices, any status.
  const subs: SubRec[] = [];
  const seen = new Set<string>();
  for (const priceId of plans.map((p) => p.stripePriceId)) {
    const plan = planByPrice.get(priceId);
    let starting_after: string | undefined;
    while (true) {
      const page = await stripe.subscriptions.list({ price: priceId, status: 'all', limit: 100, starting_after, expand: ['data.customer'] });
      for (const sub of page.data) {
        if (seen.has(sub.id)) continue;
        seen.add(sub.id);
        const cust = sub.customer as Stripe.Customer | Stripe.DeletedCustomer | string;
        const custObj = typeof cust === 'object' && !('deleted' in cust && cust.deleted) ? (cust as Stripe.Customer) : null;
        const email = custObj?.email ?? '';
        if (isExcluded(email)) continue;
        subs.push({
          subId: sub.id,
          name: custObj?.name ?? '(no name)',
          email,
          plan: plan?.planName ?? priceId,
          status: sub.status,
          start: sub.created,
          trialStart: sub.trial_start ?? null,
          trialEnd: sub.trial_end ?? null,
          end: sub.ended_at ?? null,
          firstPaidAt: null,
          paidInvoices: 0,
          grossPaid: 0,
          refunded: 0,
          netPaid: 0,
          converted: false,
        });
      }
      if (!page.has_more) break;
      starting_after = page.data[page.data.length - 1].id;
    }
  }
  console.log(`\nPulled ${subs.length} subscriptions (all statuses) across ${plans.length} prices.`);

  // 2. Payment history per sub (sequential to stay polite to the API).
  process.stdout.write('Resolving payment history');
  for (let i = 0; i < subs.length; i++) {
    const h = await paymentHistory(stripe, subs[i].subId);
    Object.assign(subs[i], h);
    if (i % 10 === 0) process.stdout.write('.');
  }
  process.stdout.write(' done\n');

  // 3. Trial -> paid conversion, on trials that have actually ENDED.
  //    "In flight" is decided by Stripe's CURRENT status, not by trial_end vs
  //    now: a trial ending today still reads `trialing` and has not yet had its
  //    chance to convert, so it must stay out of the denominator.
  const trialed = subs.filter((s) => s.trialStart != null || s.trialEnd != null);
  const trialInFlight = trialed.filter((s) => s.status === 'trialing');
  const trialEnded = trialed.filter((s) => s.status !== 'trialing' && s.trialEnd != null && s.trialEnd <= nowSec);
  const converted = trialEnded.filter((s) => s.converted);
  const notConverted = trialEnded.filter((s) => !s.converted);
  const neverTrialed = subs.filter((s) => s.trialStart == null && s.trialEnd == null);

  const convRate = trialEnded.length ? (converted.length / trialEnded.length) * 100 : 0;

  // Conversion by trial-end cohort month.
  const cohorts = new Map<string, { ended: number; converted: number }>();
  for (const s of trialEnded) {
    const k = monthKey(s.trialEnd!);
    const c = cohorts.get(k) ?? { ended: 0, converted: 0 };
    c.ended++;
    if (s.converted) c.converted++;
    cohorts.set(k, c);
  }

  // 3b. Per-AGENT rollup. Several agents hold more than one subscription (a
  //     retry after a failed trial, a plan swap, or a genuine second business).
  //     Counting subscriptions double-counts those people, so the headline
  //     business number is per unique Stripe customer email.
  const byEmail = new Map<string, SubRec[]>();
  for (const s of subs) {
    const k = (s.email || s.subId).toLowerCase();
    if (!byEmail.has(k)) byEmail.set(k, []);
    byEmail.get(k)!.push(s);
  }
  let agentNoTrial = 0, agentInFlight = 0;
  const agentDenom: Array<{ email: string; name: string; subs: SubRec[]; converted: boolean }> = [];
  for (const [email, list] of byEmail) {
    const trialedAtAll = list.some((s) => s.trialStart != null || s.trialEnd != null);
    if (!trialedAtAll) { agentNoTrial++; continue; }
    const hasCompleted = list.some((s) => s.status !== 'trialing' && s.trialEnd != null && s.trialEnd <= nowSec);
    if (!hasCompleted) { agentInFlight++; continue; }
    agentDenom.push({ email, name: list[0].name, subs: list, converted: list.some((s) => s.converted) });
  }
  const agentConverted = agentDenom.filter((a) => a.converted);
  const agentLost = agentDenom.filter((a) => !a.converted);
  const agentConvRate = agentDenom.length ? (agentConverted.length / agentDenom.length) * 100 : 0;
  const agentsLiveActive = [...byEmail.values()].filter((l) => l.some((s) => s.status === 'active')).length;

  // Current-status split, so this report reconciles against stripe-subs.ts
  // (which lists only `active` + `trialing`).
  const statusSplit: Record<string, number> = {};
  for (const s of subs) statusSplit[s.status] = (statusSplit[s.status] ?? 0) + 1;

  // 4. Month-end state series.
  const firstStart = Math.min(...subs.map((s) => s.start));
  const months: string[] = [];
  {
    const d = new Date(firstStart * 1000);
    let y = d.getUTCFullYear();
    let m = d.getUTCMonth();
    const now = new Date();
    while (y < now.getUTCFullYear() || (y === now.getUTCFullYear() && m <= now.getUTCMonth())) {
      months.push(`${y}-${String(m + 1).padStart(2, '0')}`);
      m++;
      if (m > 11) { m = 0; y++; }
    }
  }
  const monthEndSec = (mk: string) => {
    const [y, mo] = mk.split('-').map(Number);
    return Math.min(Math.floor(Date.UTC(y, mo, 0, 23, 59, 59) / 1000), nowSec);
  };

  type MonthRow = {
    month: string; paying: number; trialing: number; total: number;
    newSubs: number; churned: number; churnedInTrial: number; churnedPaying: number;
    convertedThisMonth: number; net: number; momPct: number | null;
  };
  const series: MonthRow[] = [];
  let prevTotal: number | null = null;
  for (const mk of months) {
    const T = monthEndSec(mk);
    const [y, mo] = mk.split('-').map(Number);
    const mStart = Math.floor(Date.UTC(y, mo - 1, 1, 0, 0, 0) / 1000);
    let paying = 0, trialing = 0;
    for (const s of subs) {
      if (s.start > T) continue;
      if (s.end != null && s.end <= T) continue;
      if (s.trialEnd != null && s.trialEnd > T) trialing++;
      else paying++;
    }
    const newSubs = subs.filter((s) => s.start >= mStart && s.start <= T).length;
    const churnedList = subs.filter((s) => s.end != null && s.end >= mStart && s.end <= T);
    const churnedInTrial = churnedList.filter((s) => s.paidInvoices === 0).length;
    const convertedThisMonth = subs.filter(
      (s) => s.firstPaidAt != null && s.firstPaidAt >= mStart && s.firstPaidAt <= T && s.trialEnd != null,
    ).length;
    const total = paying + trialing;
    series.push({
      month: mk, paying, trialing, total,
      newSubs, churned: churnedList.length, churnedInTrial, churnedPaying: churnedList.length - churnedInTrial,
      convertedThisMonth,
      net: newSubs - churnedList.length,
      momPct: prevTotal && prevTotal > 0 ? ((total - prevTotal) / prevTotal) * 100 : null,
    });
    prevTotal = total;
  }

  // ---- Terminal report ----
  const pct = (n: number) => `${n.toFixed(1)}%`;
  console.log(`\n=== ${workflowKey} — trial -> paid conversion (Stripe actuals) ===`);
  console.log(`  Subscriptions ever created ............ ${subs.length}`);
  console.log(`  ...that entered a trial ............... ${trialed.length}`);
  console.log(`  ...that never trialed (paid day one) .. ${neverTrialed.length}`);
  console.log(`  Trials completed (trial_end passed) ... ${trialEnded.length}   <- conversion denominator`);
  console.log(`  ...converted (>=1 real payment) ....... ${converted.length}`);
  console.log(`  ...did not convert .................... ${notConverted.length}`);
  console.log(`  Trials still in flight (excluded) ..... ${trialInFlight.length}`);
  console.log(`  CONVERSION RATE ....................... ${pct(convRate)}`);

  console.log(`\n  Per AGENT (unique Stripe customer email) — the headline number:`);
  console.log(`    unique agents ever subscribed ....... ${byEmail.size}`);
  console.log(`    ...never trialed .................... ${agentNoTrial}`);
  console.log(`    ...only in-flight trials (excluded) . ${agentInFlight}`);
  console.log(`    agents with a completed trial ....... ${agentDenom.length}   <- denominator`);
  console.log(`    ...ever kept a real payment ......... ${agentConverted.length}`);
  console.log(`    PER-AGENT CONVERSION ................ ${pct(agentConvRate)}`);
  console.log(`    agents with a live active sub today . ${agentsLiveActive}`);

  console.log(`\n  Current Stripe status split (reconciles with stripe-subs.ts):`);
  for (const [k, v] of Object.entries(statusSplit).sort()) console.log(`    ${k.padEnd(20)} ${v}`);

  console.log(`\n  By trial-end cohort month:`);
  console.log(`    month     ended  converted   rate`);
  for (const k of [...cohorts.keys()].sort()) {
    const c = cohorts.get(k)!;
    console.log(`    ${k}   ${String(c.ended).padStart(5)}  ${String(c.converted).padStart(9)}   ${pct((c.converted / c.ended) * 100).padStart(6)}`);
  }

  if (notConverted.length) {
    console.log(`\n  Did-not-convert detail (${notConverted.length}):`);
    for (const s of notConverted.sort((a, b) => (a.trialEnd ?? 0) - (b.trialEnd ?? 0))) {
      const why = s.paidInvoices > 0 ? `paid $${s.grossPaid}, fully refunded` : s.end != null ? `canceled ${isoDate(s.end)}` : `status=${s.status}, no payment`;
      console.log(`    ${isoDate(s.trialEnd).padEnd(11)} ${s.name.slice(0, 28).padEnd(29)} ${s.email.slice(0, 34).padEnd(35)} ${why}`);
    }
  }

  if (agentLost.length) {
    console.log(`\n  Agents who did not convert (${agentLost.length}):`);
    for (const a of agentLost) {
      console.log(`    ${a.name.slice(0, 28).padEnd(29)} ${a.email.slice(0, 34).padEnd(35)} ${a.subs.length} sub(s) [${a.subs.map((s) => s.status).join('/')}]`);
    }
  }

  console.log(`\n=== ${workflowKey} — month-end subscription state ===`);
  console.log(`  month     paying  trial  total    new  churn(trial/paid)  conv   net    MoM`);
  for (const r of series) {
    console.log(
      `  ${r.month}  ${String(r.paying).padStart(6)} ${String(r.trialing).padStart(6)} ${String(r.total).padStart(6)}  ` +
      `${String(r.newSubs).padStart(5)}  ${String(r.churned).padStart(5)} (${r.churnedInTrial}/${r.churnedPaying})`.padEnd(20) +
      `  ${String(r.convertedThisMonth).padStart(4)}  ${(r.net >= 0 ? '+' : '') + r.net}`.padEnd(8) +
      `  ${r.momPct == null ? '   -' : (r.momPct >= 0 ? '+' : '') + r.momPct.toFixed(1) + '%'}`,
    );
  }

  const out = {
    workflowKey,
    generated: new Date().toISOString().slice(0, 10),
    plans: plans.map((p) => ({ name: p.planName, priceId: p.stripePriceId, display: `${p.priceDisplay ?? ''}${p.pricePeriod ?? ''}` })),
    totals: {
      subsEver: subs.length,
      trialed: trialed.length,
      neverTrialed: neverTrialed.length,
      trialEnded: trialEnded.length,
      converted: converted.length,
      notConverted: notConverted.length,
      trialInFlight: trialInFlight.length,
      conversionRate: Number(convRate.toFixed(1)),
      agentsEver: byEmail.size,
      agentNoTrial,
      agentInFlight,
      agentDenom: agentDenom.length,
      agentConverted: agentConverted.length,
      agentConversionRate: Number(agentConvRate.toFixed(1)),
      agentsLiveActive,
    },
    statusSplit,
    agentsNotConverted: agentLost.map((a) => ({ name: a.name, email: a.email, subs: a.subs.length, statuses: a.subs.map((s) => s.status) })),
    cohorts: [...cohorts.entries()].sort().map(([month, c]) => ({ month, ...c, rate: Number(((c.converted / c.ended) * 100).toFixed(1)) })),
    series,
    notConverted: notConverted.map((s) => ({
      name: s.name, email: s.email, plan: s.plan, status: s.status,
      trialEnd: isoDate(s.trialEnd), ended: isoDate(s.end), grossPaid: s.grossPaid, refunded: s.refunded,
    })),
    subs: subs.map((s) => ({
      ...s,
      startISO: isoDate(s.start), trialEndISO: isoDate(s.trialEnd), endISO: isoDate(s.end), firstPaidISO: isoDate(s.firstPaidAt),
    })),
  };

  if (args.json) {
    writeFileSync(resolve(process.cwd(), args.json), JSON.stringify(out, null, 2));
    console.log(`\nJSON written: ${args.json}`);
  }
  if (args.csv) {
    const p = resolve(process.cwd(), `scripts/data/${workflowKey.toLowerCase()}-cohorts-${out.generated}.csv`);
    const esc = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = ['month,paying,trialing,total,newSubs,churned,churnedInTrial,churnedPaying,convertedThisMonth,net'];
    for (const r of series) lines.push([r.month, r.paying, r.trialing, r.total, r.newSubs, r.churned, r.churnedInTrial, r.churnedPaying, r.convertedThisMonth, r.net].map(esc).join(','));
    writeFileSync(p, lines.join('\n'));
    console.log(`CSV written: ${p}`);
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
