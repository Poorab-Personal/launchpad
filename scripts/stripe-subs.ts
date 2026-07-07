/**
 * Direct Stripe pull: subscriptions / payments for a B2B brokerage.
 *
 * Two modes, both straight off the live Stripe API — no LP-customer or Rejig
 * join. Source of truth for "which prices count" = the plan price IDs LP knows
 * (stripe_plans WHERE workflow_key=<key>); everything else (subs, statuses,
 * amounts, names, emails, invoices) comes from Stripe.
 *
 *   DEFAULT (no --as-of): current active (Paying) + trialing subs. Revenue is
 *     the effective monthly rate; rev-share is on that monthly figure.
 *
 *   --as-of <YYYY-MM-DD>: CASH BASIS through that date. Includes a customer iff
 *     a real payment (paid invoice) landed on or before the cutoff, and counts
 *     only cash actually collected by then. Subs that started after the cutoff
 *     are excluded ("nothing after"). Rev-share is <pct>% of collected cash.
 *     Customers whose trial was active at the cutoff (no payment yet) are shown
 *     for context but carry no revenue. Cumulative through the date — run two
 *     month-ends and diff for a single month, or re-run monthly.
 *
 * Output: terminal summary + CSV (scripts/data/<key>-stripe-subs[-asof-<date>]-<run>.csv).
 * Pass --email a,b,c to also send the summary + CSV via Resend.
 *
 * Usage:
 *   npx tsx scripts/stripe-subs.ts keyes
 *   npx tsx scripts/stripe-subs.ts keyes --as-of 2026-06-30 --email poorab@rejig.ai
 *   npx tsx scripts/stripe-subs.ts ipre --rev-share 20 --as-of 2026-06-30
 */
import dotenv from 'dotenv';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type Stripe from 'stripe';

dotenv.config({ path: '.env.local' });

type Args = {
  target: string;
  email: string[];
  revShare: number; // fraction, e.g. 0.15; 0 = hide rev-share column
  subject: string | null;
  asOf: string | null; // YYYY-MM-DD cash-basis cutoff (cumulative through date)
  month: string | null; // YYYY-MM single-month cash window
  exclude: string[]; // email substrings to drop from counts + revenue
  customer: string | null; // drill-down: filter to name/email substring + dump invoice detail
};

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let email: string[] = [];
  let revShare = 0.15;
  let subject: string | null = null;
  let asOf: string | null = null;
  let month: string | null = null;
  let exclude: string[] = [];
  let customer: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--email') email = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--rev-share') {
      const raw = (argv[++i] ?? '').replace('%', '');
      const n = parseFloat(raw);
      if (Number.isNaN(n) || n < 0) { console.error('--rev-share requires a non-negative number (percent, e.g. 15)'); process.exit(2); }
      revShare = n > 1 ? n / 100 : n; // accept "15" or "0.15"
    } else if (a === '--subject') subject = argv[++i] ?? null;
    else if (a === '--as-of') {
      asOf = argv[++i] ?? null;
      if (!asOf || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) { console.error('--as-of requires a YYYY-MM-DD date'); process.exit(2); }
    } else if (a === '--month') {
      month = argv[++i] ?? null;
      if (!month || !/^\d{4}-\d{2}$/.test(month)) { console.error('--month requires a YYYY-MM value'); process.exit(2); }
    } else if (a === '--exclude') {
      exclude = (argv[++i] ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    } else if (a === '--customer') {
      customer = (argv[++i] ?? '').trim().toLowerCase() || null;
    } else if (a.startsWith('--')) { console.error(`Unknown flag: ${a}`); process.exit(2); }
    else positional.push(a);
  }
  if (positional.length === 0) {
    console.error('Usage: npx tsx scripts/stripe-subs.ts <workflow_key|brokerage_slug> [--month YYYY-MM | --as-of YYYY-MM-DD] [--exclude a,b] [--customer q] [--rev-share 15] [--email a,b] [--subject <s>]');
    process.exit(2);
  }
  if (asOf && month) { console.error('Pass at most one of --month / --as-of'); process.exit(2); }
  return { target: positional[0], email, revShare, subject, asOf, month, exclude, customer };
}

type Row = {
  name: string;
  email: string;
  state: 'Paying' | 'Trial';
  plan: string;
  amount: string; // Stripe charge + cadence, e.g. "$300 / 3 months"
  perMonth: string; // effective monthly, e.g. "$100/mo"
  monthlyAmount: number; // effective monthly dollars (current-state revenue)
  collected: number; // NET cash kept in the window (cash mode; gross − refunds); else 0
  refunded: number; // refunds netted out of this row's in-window charges
  firstPaid: string; // ISO date of first in-window payment (cash mode); else ''
  subId: string;
  priceId: string;
  currentPeriodEnd: string;
  created: string;
  dup: boolean; // same customer email appears on >1 counted row
};

type PlanAgg = {
  paying: number;
  trialing: number;
  revenue: number; // monthly effective (default) OR cash collected (as-of), paying only
  perCustomerMonthly: number; // effective monthly $ for one sub on this plan
  count: number; // billing interval_count
  unit: string; // billing interval unit
  amountStr: string; // charge cadence string
};

function isoDate(sec: number | null | undefined): string {
  return sec ? new Date(sec * 1000).toISOString().slice(0, 10) : '';
}

const usd = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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
  if (row.length === 0) {
    console.error(`No brokerage with slug "${target}". Pass a workflow_key directly (e.g. B2B-Keyes).`);
    process.exit(2);
  }
  return row[0].workflowKey;
}

// Per-price billing cadence, captured during the pull for the footnote/aggregate.
const planCadence = new Map<string, { count: number; unit: string; monthlyAmount: number; amountStr: string }>();

/** Effective monthly dollars for a Stripe price's recurring terms. */
function effectiveMonthly(dollars: number | null, unit: string, count: number): number {
  if (dollars == null) return 0;
  if (unit === 'month') return dollars / count;
  if (unit === 'year') return dollars / (12 * count);
  if (unit === 'week') return (dollars * 52) / (12 * count);
  return dollars; // day/other
}

/**
 * Cash actually kept on a subscription for paid invoices with paid_at in window.
 * NETS OUT REFUNDS: a $119 charge later fully refunded contributes $0. We must
 * not pay rev-share on money we handed back (Alex Cika: paid Jun 11, refunded
 * Jun 12 → net $0). Returns gross (before refunds), refunded, and net.
 */
async function collectedInWindow(
  stripe: Stripe,
  subId: string,
  sinceSec: number,
  untilSec: number,
): Promise<{ gross: number; refunded: number; net: number; firstPaidAt: number | null }> {
  let starting_after: string | undefined;
  let gross = 0;
  let refunded = 0;
  let firstPaidAt: number | null = null;
  while (true) {
    const page = await stripe.invoices.list({ subscription: subId, status: 'paid', limit: 100, starting_after });
    for (const inv of page.data) {
      const paidAt = inv.status_transitions?.paid_at ?? null;
      if (paidAt == null || paidAt < sinceSec || paidAt > untilSec) continue;
      gross += (inv.amount_paid ?? 0) / 100;
      if (firstPaidAt == null || paidAt < firstPaidAt) firstPaidAt = paidAt;
      // Resolve the charge to read amount_refunded. New API: invoice → payment_intent
      // (id) → retrieve PI with latest_charge. The one-call nested expand doesn't
      // populate reliably, so do it in two steps.
      try {
        const full = (await stripe.invoices.retrieve(inv.id, { expand: ['payments', 'payment_intent'] })) as unknown as {
          payment_intent?: string | { id?: string } | null;
          payments?: { data?: Array<{ payment?: { payment_intent?: string | null } }> } | null;
        };
        const piField = full.payment_intent;
        const piId =
          (typeof piField === 'string' ? piField : piField?.id ?? null) ??
          full.payments?.data?.[0]?.payment?.payment_intent ??
          null;
        if (piId) {
          const piObj = (await stripe.paymentIntents.retrieve(piId, { expand: ['latest_charge'] })) as unknown as {
            latest_charge?: { amount_refunded?: number } | string | null;
          };
          const ch = piObj.latest_charge;
          if (process.env.SS_DEBUG) console.error(`    [refund] inv=${inv.id} pi=${piId} chType=${typeof ch} refunded=${typeof ch === 'object' ? ch?.amount_refunded : 'n/a'}`);
          if (ch && typeof ch === 'object') refunded += (ch.amount_refunded ?? 0) / 100;
        } else if (process.env.SS_DEBUG) {
          console.error(`    [refund] inv=${inv.id} no payment_intent id (pi=${JSON.stringify(pi)})`);
        }
      } catch (e) {
        if (process.env.SS_DEBUG) console.error(`    [refund] error inv=${inv.id}: ${(e as Error).message}`);
      }
    }
    if (!page.has_more) break;
    starting_after = page.data[page.data.length - 1].id;
  }
  return { gross, refunded, net: gross - refunded, firstPaidAt };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workflowKey = await resolveWorkflowKey(args.target);
  const displayKey = workflowKey.replace(/^B2B-|^D2C-/, '');

  // Cash-basis window. --month = single month; --as-of = cumulative through date;
  // neither = current active/trialing mode. cashMode gates the invoice pull.
  const cashMode = !!(args.month || args.asOf);
  let sinceSec = 0;
  let untilSec: number | null = null;
  let windowLabel = ''; // human label for headers, e.g. "June 2026"
  let mode: 'month' | 'asof' = 'asof';
  if (args.month) {
    mode = 'month';
    const [y, mo] = args.month.split('-').map(Number);
    sinceSec = Math.floor(Date.UTC(y, mo - 1, 1, 0, 0, 0) / 1000);
    untilSec = Math.floor(Date.UTC(y, mo, 0, 23, 59, 59) / 1000); // day 0 of next month = last day
    windowLabel = new Date(Date.UTC(y, mo - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  } else if (args.asOf) {
    mode = 'asof';
    sinceSec = 0;
    untilSec = Math.floor(new Date(`${args.asOf}T23:59:59Z`).getTime() / 1000);
    windowLabel = `through ${args.asOf}`;
  }
  const excludes = args.exclude;
  const isExcluded = (email: string) => excludes.some((x) => email.toLowerCase().includes(x));

  const { db } = await import('../src/db');
  const schema = await import('../src/db/schema');
  const { eq } = await import('drizzle-orm');
  const Stripe = (await import('stripe')).default;

  // 1. Plans (price id -> name + display) from LP.
  const plans = await db
    .select()
    .from(schema.stripePlans)
    .where(eq(schema.stripePlans.workflowKey, workflowKey));
  if (plans.length === 0) {
    console.error(`No stripe_plans rows for workflow_key='${workflowKey}'. Nothing to pull.`);
    process.exit(2);
  }
  const planByPrice = new Map(plans.map((p) => [p.stripePriceId, p]));
  const priceIds = plans.map((p) => p.stripePriceId);
  console.log(`${displayKey} plans (${priceIds.length}):`);
  for (const p of plans) console.log(`  ${p.planName}  ${p.priceDisplay ?? ''}${p.pricePeriod ?? ''}  (${p.stripePriceId})`);
  if (cashMode) console.log(`\nMode: CASH BASIS — payments received ${mode === 'month' ? `in ${windowLabel}` : windowLabel} (nothing after).`);
  if (excludes.length) console.log(`Excluding rows whose email contains: ${excludes.join(', ')}`);

  // 2. Stripe client (prefer live key).
  const stripeSecret = process.env.STRIPE_LIVE_SECRET_KEY ?? process.env.STRIPE_SECRET_KEY;
  if (!stripeSecret) throw new Error('STRIPE_LIVE_SECRET_KEY or STRIPE_SECRET_KEY required');
  if (!stripeSecret.startsWith('sk_live_')) console.warn(`  ⚠ Stripe key is non-live (${stripeSecret.slice(0, 8)}…). Brokerage prices are live-mode.`);
  const stripe = new Stripe(stripeSecret);

  // 3. Pull. In cash mode we list ALL statuses and gate on real payments in the
  //    window; otherwise just the current active + trialing subs.
  const rows: Row[] = [];
  const statuses = cashMode ? (['all'] as const) : (['active', 'trialing'] as const);
  // Customers whose in-window payment netted to $0 after refunds (excluded from totals).
  const refundedOut: Array<{ name: string; email: string; gross: number; refunded: number }> = [];
  for (const priceId of priceIds) {
    const plan = planByPrice.get(priceId);
    for (const status of statuses) {
      let starting_after: string | undefined;
      while (true) {
        const page = await stripe.subscriptions.list({ price: priceId, status, limit: 100, starting_after, expand: ['data.customer'] });
        for (const sub of page.data) {
          if (cashMode && untilSec != null && sub.created > untilSec) continue; // started after window → excluded

          const cust = sub.customer as Stripe.Customer | Stripe.DeletedCustomer | string;
          const custObj = typeof cust === 'object' && !('deleted' in cust && cust.deleted) ? (cust as Stripe.Customer) : null;
          const email = custObj?.email ?? '';
          const name = custObj?.name ?? '';
          if (isExcluded(email)) continue; // internal / non-brokerage rows
          if (args.customer && !`${name} ${email}`.toLowerCase().includes(args.customer)) continue; // drill-down filter

          // Drill-down: dump every invoice on this sub so it's clear which payment counted.
          if (args.customer) {
            console.log(`\n· ${name} <${email}>  cust=${typeof cust === 'string' ? cust : cust.id}  sub=${sub.id}  status=${sub.status}  price=${priceId}  created=${isoDate(sub.created)}  canceled=${sub.canceled_at ? isoDate(sub.canceled_at) : '-'}`);
            let sa: string | undefined;
            while (true) {
              const ip = await stripe.invoices.list({ subscription: sub.id, limit: 100, starting_after: sa });
              for (const inv of ip.data) {
                const pa = inv.status_transitions?.paid_at ?? null;
                const inWin = pa != null && untilSec != null && pa >= sinceSec && pa <= untilSec;
                console.log(`    inv ${inv.id}  status=${inv.status}  amount_paid=$${((inv.amount_paid ?? 0) / 100).toFixed(2)}  paid_at=${isoDate(pa) || '-'}  created=${isoDate(inv.created)}${inWin ? '   <== counted in window' : ''}`);
              }
              if (!ip.has_more) break;
              sa = ip.data[ip.data.length - 1].id;
            }
          }

          const item = sub.items.data.find((i) => i.price.id === priceId) ?? sub.items.data[0];
          const price = item?.price;
          const rec = price?.recurring;
          const dollars = price?.unit_amount != null ? price.unit_amount / 100 : null;
          const count = rec?.interval_count ?? 1;
          const unit = rec?.interval ?? 'month';
          const amt = dollars != null
            ? count > 1 ? `$${dollars.toFixed(0)} / ${count} ${unit}s` : `$${dollars.toFixed(0)}/${unit}`
            : plan?.priceDisplay ? `${plan.priceDisplay}${plan.pricePeriod ?? ''}` : '?';
          const monthlyAmount = effectiveMonthly(dollars, unit, count);
          const perMonth = dollars != null && monthlyAmount ? `$${monthlyAmount.toFixed(0)}/mo` : '';
          if (!planCadence.has(priceId)) planCadence.set(priceId, { count, unit, monthlyAmount, amountStr: amt });

          let state: 'Paying' | 'Trial';
          let collected = 0;
          let refunded = 0;
          let firstPaid = '';
          if (cashMode && untilSec != null) {
            const paid = await collectedInWindow(stripe, sub.id, sinceSec, untilSec);
            if (args.customer) console.log(`    → window net: gross=${usd(paid.gross)} refunded=${usd(paid.refunded)} net=${usd(paid.net)}`);
            if (paid.net > 0.005) {
              state = 'Paying';
              collected = paid.net;
              refunded = paid.refunded;
              firstPaid = isoDate(paid.firstPaidAt);
            } else if (paid.gross > 0) {
              // Had an in-window payment but it netted to ~$0 after refunds → not real cash.
              refundedOut.push({ name, email, gross: paid.gross, refunded: paid.refunded });
              continue;
            } else {
              // No in-window payment — count only if a trial overlapped the window.
              // month: trial active anytime in [since, until]; asof: trial active AT until.
              const ts = sub.trial_start ?? null;
              const te = sub.trial_end ?? null;
              const trialOverlap =
                ts != null && ts <= untilSec && (te == null || te > (mode === 'month' ? sinceSec : untilSec));
              if (!trialOverlap) continue; // no payment, not trialing in window → skip
              state = 'Trial';
            }
          } else {
            state = status === 'active' ? 'Paying' : 'Trial';
          }

          rows.push({
            name: custObj?.name ?? '',
            email,
            state,
            plan: plan?.planName ?? price?.nickname ?? priceId,
            amount: amt,
            perMonth,
            monthlyAmount,
            collected,
            refunded,
            firstPaid,
            subId: sub.id,
            priceId,
            currentPeriodEnd: isoDate(sub.current_period_end ?? (item as unknown as { current_period_end?: number })?.current_period_end),
            created: isoDate(sub.created),
            dup: false,
          });
        }
        if (!page.has_more) break;
        starting_after = page.data[page.data.length - 1].id;
      }
    }
  }

  // Flag customers (by normalized email) appearing on >1 counted row.
  const emailCounts = new Map<string, number>();
  for (const r of rows) if (r.email) emailCounts.set(r.email.toLowerCase(), (emailCounts.get(r.email.toLowerCase()) ?? 0) + 1);
  const dupEmails = new Set(Array.from(emailCounts.entries()).filter(([, n]) => n > 1).map(([e]) => e));
  for (const r of rows) r.dup = !!r.email && dupEmails.has(r.email.toLowerCase());

  rows.sort((a, b) => a.plan.localeCompare(b.plan) || a.state.localeCompare(b.state) || a.name.localeCompare(b.name));

  // 4. Counts + economics (paying only for $).
  const paying = rows.filter((r) => r.state === 'Paying').length;
  const trialing = rows.filter((r) => r.state === 'Trial').length;
  const REV_SHARE = args.revShare;
  const byPlan = new Map<string, PlanAgg>();
  for (const r of rows) {
    const cad = planCadence.get(r.priceId);
    const e = byPlan.get(r.plan) ?? {
      paying: 0, trialing: 0, revenue: 0, perCustomerMonthly: r.monthlyAmount,
      count: cad?.count ?? 1, unit: cad?.unit ?? 'month', amountStr: cad?.amountStr ?? r.amount,
    };
    if (r.state === 'Paying') { e.paying++; e.revenue += cashMode ? r.collected : r.monthlyAmount; }
    else e.trialing++;
    byPlan.set(r.plan, e);
  }
  const totalRevenue = Array.from(byPlan.values()).reduce((s, e) => s + e.revenue, 0);
  const totalRevShare = totalRevenue * REV_SHARE;

  const today = new Date().toISOString().slice(0, 10);
  const pct = Math.round(REV_SHARE * 100);
  const revLabel = cashMode ? 'Collected' : 'Monthly rev';
  const shareLabel = cashMode ? `${pct}% of collected` : `${pct}% rev share / mo`;
  const dupList = rows.filter((r) => r.dup);

  // Dynamic footnote.
  const footnoteLines: string[] = [];
  if (cashMode) {
    const scope = mode === 'month' ? `in ${windowLabel}` : windowLabel;
    footnoteLines.push(`Cash basis: amounts actually collected via paid invoices ${scope}. Rev-share = ${pct}% of collected.`);
    footnoteLines.push(`Trials shown had an active trial ${mode === 'month' ? `during ${windowLabel}` : windowLabel} (no payment yet → no revenue). Subscriptions that started after the window are excluded.`);
    footnoteLines.push(`Refunds are netted out — a payment later refunded contributes $0 (we don't pay rev-share on money handed back).`);
    if (excludes.length) footnoteLines.push(`Excluded from all figures (email contains): ${excludes.join(', ')}.`);
    if (refundedOut.length) footnoteLines.push(`Fully refunded → excluded (${refundedOut.length}): ${refundedOut.map((r) => `${r.name || r.email} (paid ${usd(r.gross)}, refunded ${usd(r.refunded)})`).join('; ')}.`);
    const partial = rows.filter((r) => r.refunded > 0.005);
    if (partial.length) footnoteLines.push(`Partial refunds netted on: ${partial.map((r) => `${r.name || r.email} (−${usd(r.refunded)})`).join('; ')}.`);
    if (dupList.length) footnoteLines.push(`⚠ Duplicate customer(s) with >1 counted sub — verify before treating both as real: ${Array.from(new Set(dupList.map((r) => `${r.name || r.email}`))).join(', ')}.`);
  } else {
    for (const [plan, e] of byPlan) {
      const monthlyShare = e.perCustomerMonthly * REV_SHARE;
      if (e.count > 1) {
        footnoteLines.push(`${plan}: ${e.amountStr} = $${e.perCustomerMonthly.toFixed(0)}/mo effective → ${usd(monthlyShare)}/mo share, paid across the ${e.count} ${e.unit}s (= ${usd(monthlyShare * e.count)} per ${e.count} ${e.unit}s).`);
      } else {
        footnoteLines.push(`${plan}: $${e.perCustomerMonthly.toFixed(0)}/mo × ${pct}% = ${usd(monthlyShare)}/mo share.`);
      }
    }
  }

  // 5. Terminal summary.
  const modeNote = cashMode ? ` — payments received ${mode === 'month' ? `in ${windowLabel}` : windowLabel}` : ' (active + trialing)';
  console.log(`\n=== ${displayKey} Stripe${modeNote} — generated ${today} ===\n`);
  console.log(`Total: ${rows.length}   Paying: ${paying}   Trialing: ${trialing}\n`);
  console.log(`${cashMode ? 'Cash collected' : 'Monthly economics'} — PAYING only (trials excluded from $):`);
  for (const [plan, c] of byPlan) {
    const share = REV_SHARE > 0 ? `   ${shareLabel} ${usd(c.revenue * REV_SHARE).padStart(10)}` : '';
    console.log(`  ${plan.padEnd(24)} ${String(c.paying).padStart(3)} paying   ${revLabel} ${usd(c.revenue).padStart(11)}${share}`);
  }
  const totShare = REV_SHARE > 0 ? `   ${shareLabel} ${usd(totalRevShare).padStart(10)}` : '';
  console.log(`  ${'TOTAL'.padEnd(24)} ${String(paying).padStart(3)} paying   ${revLabel} ${usd(totalRevenue).padStart(11)}${totShare}`);
  if (REV_SHARE > 0) footnoteLines.forEach((l) => console.log(`  ${l}`));
  console.log('\nBy plan (counts):');
  for (const [plan, c] of byPlan) console.log(`  ${plan.padEnd(24)} Paying ${c.paying}   Trialing ${c.trialing}   (total ${c.paying + c.trialing})`);
  console.log('');
  for (const r of rows) {
    const money = cashMode ? `${usd(r.collected).padStart(10)} (${r.firstPaid || '—'})` : r.amount.padEnd(16);
    console.log(`  [${r.state.padEnd(6)}]${r.dup ? '‼' : ' '} ${r.plan.padEnd(22)} ${money} ${(r.name || '(no name)').padEnd(28)} ${r.email}`);
  }

  // 6. CSV.
  const csvName = `${workflowKey.toLowerCase()}-stripe-subs${mode === 'month' && args.month ? `-${args.month}` : args.asOf ? `-asof-${args.asOf}` : ''}-${today}.csv`;
  const csvPath = resolve('scripts/data', csvName);
  const cols: Array<keyof Row> = cashMode
    ? ['name', 'email', 'state', 'plan', 'amount', 'collected', 'refunded', 'firstPaid', 'dup', 'created', 'subId', 'priceId']
    : ['name', 'email', 'state', 'plan', 'amount', 'perMonth', 'currentPeriodEnd', 'created', 'subId', 'priceId'];
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csvBody = cols.join(',') + '\n' + rows.map((r) => cols.map((c) => esc(r[c])).join(',')).join('\n') + '\n';
  writeFileSync(csvPath, csvBody);
  console.log(`\nCSV written: ${csvPath}`);

  // 7. Email.
  if (args.email.length > 0) {
    const html = buildEmailHtml({
      displayKey, today, cashMode, mode, windowLabel, rows, paying, trialing, byPlan,
      totalRevenue, totalRevShare, revSharePct: REV_SHARE, footnoteLines, revLabel, shareLabel,
    });
    const scope = cashMode ? (mode === 'month' ? windowLabel : windowLabel) : today;
    const subject = args.subject ?? `${displayKey} Stripe ${cashMode ? 'payments' : 'subs'} — ${scope} (${paying} paying · ${trialing} trialing)`;
    await sendEmail({ to: args.email, subject, html, attachment: { filename: csvName, content: csvBody } });
    console.log(`Email sent to: ${args.email.join(', ')}`);
  }
}

function escHtml(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildEmailHtml(opts: {
  displayKey: string;
  today: string;
  cashMode: boolean;
  mode: 'month' | 'asof';
  windowLabel: string;
  rows: Row[];
  paying: number;
  trialing: number;
  byPlan: Map<string, PlanAgg>;
  totalRevenue: number;
  totalRevShare: number;
  revSharePct: number;
  footnoteLines: string[];
  revLabel: string;
  shareLabel: string;
}): string {
  const { displayKey, today, cashMode, mode, windowLabel, rows, paying, trialing, byPlan, totalRevenue, totalRevShare, revSharePct, footnoteLines, revLabel, shareLabel } = opts;
  const th = 'padding:6px 10px;border-bottom:2px solid #444;background:#f6f6f6;font-size:13px;text-align:left;';
  const td = 'padding:6px 10px;border-bottom:1px solid #eee;font-size:13px;';
  const tf = 'padding:6px 10px;border-top:2px solid #444;font-size:13px;font-weight:bold;';
  const showShare = revSharePct > 0;

  const econRows = Array.from(byPlan.entries()).map(([plan, c]) => `
      <tr>
        <td style="${td}">${escHtml(plan)}</td>
        <td style="${td};text-align:right;">${c.paying}</td>
        <td style="${td};text-align:right;">${usd(c.revenue)}</td>
        ${showShare ? `<td style="${td};text-align:right;">${usd(c.revenue * revSharePct)}</td>` : ''}
      </tr>`).join('');
  const econTable = `
    <table style="border-collapse:collapse;margin:0 0 8px;">
      <tr>
        <th style="${th}">Plan</th>
        <th style="${th};text-align:right;">Paying</th>
        <th style="${th};text-align:right;">${escHtml(revLabel)}</th>
        ${showShare ? `<th style="${th};text-align:right;">${escHtml(shareLabel)}</th>` : ''}
      </tr>
      ${econRows}
      <tr>
        <td style="${tf}">TOTAL</td>
        <td style="${tf};text-align:right;">${paying}</td>
        <td style="${tf};text-align:right;">${usd(totalRevenue)}</td>
        ${showShare ? `<td style="${tf};text-align:right;">${usd(totalRevShare)}</td>` : ''}
      </tr>
    </table>
    <div style="font-size:12px;color:#666;margin:0 0 24px;">
      Paying subscribers only — trials excluded from $ figures.
      <ul style="margin:6px 0 0;padding-left:18px;">${footnoteLines.map((l) => `<li>${escHtml(l)}</li>`).join('')}</ul>
    </div>`;

  const planRows = Array.from(byPlan.entries()).map(([plan, c]) => `
      <tr>
        <td style="${td}">${escHtml(plan)}</td>
        <td style="${td};text-align:right;">${c.paying}</td>
        <td style="${td};text-align:right;">${c.trialing}</td>
        <td style="${td};text-align:right;">${c.paying + c.trialing}</td>
      </tr>`).join('');

  const cols: Array<[keyof Row, string]> = cashMode
    ? [['state', 'State'], ['plan', 'Plan'], ['collected', 'Collected'], ['firstPaid', 'First paid'], ['name', 'Name'], ['email', 'Email']]
    : [['state', 'State'], ['plan', 'Plan'], ['amount', 'Amount'], ['perMonth', 'Per month'], ['name', 'Name'], ['email', 'Email']];
  const cell = (r: Row, k: keyof Row) => (k === 'collected' ? usd(r.collected) : String(r[k] ?? ''));
  const dupTd = `${td}background:#fff5f5;`;
  const dataRows = rows.map((r) => `\n      <tr>${cols.map(([k]) => `<td style="${r.dup ? dupTd : td}">${escHtml(cell(r, k))}${k === 'state' && r.dup ? ' ‼' : ''}</td>`).join('')}</tr>`).join('');

  const heading = cashMode
    ? `${escHtml(displayKey)} Stripe payments — ${mode === 'month' ? escHtml(windowLabel) : `received ${escHtml(windowLabel)}`}`
    : `${escHtml(displayKey)} Stripe subscriptions — active + trialing`;

  return `
<!doctype html>
<html>
  <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111;background:#fff;padding:24px;max-width:900px;margin:0 auto;">
    <h2 style="margin:0 0 6px;font-size:18px;">${heading}</h2>
    <div style="font-size:12px;color:#666;margin:0 0 14px;">Direct Stripe pull · generated ${escHtml(today)}${cashMode ? ` · cash basis (${escHtml(windowLabel)})` : ''}</div>
    <div style="font-size:15px;margin:0 0 16px;"><strong>${paying}</strong> paying &nbsp;·&nbsp; <strong>${trialing}</strong> trialing &nbsp;·&nbsp; ${paying + trialing} total</div>

    <h3 style="margin:0 0 8px;font-size:14px;">${cashMode ? 'Cash collected' : 'Monthly revenue'}${showShare ? ` &amp; ${Math.round(revSharePct * 100)}% rev-share` : ''} — paying only</h3>
    ${econTable}

    <h3 style="margin:0 0 8px;font-size:14px;">By plan (counts)</h3>
    <table style="border-collapse:collapse;margin:0 0 24px;">
      <tr><th style="${th}">Plan</th><th style="${th};text-align:right;">Paying</th><th style="${th};text-align:right;">Trialing</th><th style="${th};text-align:right;">Total</th></tr>
      ${planRows}
    </table>

    <h3 style="margin:0 0 8px;font-size:14px;">Per-customer</h3>
    <table style="border-collapse:collapse;width:100%;">
      <tr>${cols.map(([, l]) => `<th style="${th}">${l}</th>`).join('')}</tr>
      ${dataRows}
    </table>

    <div style="font-size:11px;color:#888;margin-top:24px;border-top:1px solid #eee;padding-top:12px;">
      Direct Stripe pull on ${escHtml(displayKey)} plan price IDs (from stripe_plans). Full data in the attached CSV.
    </div>
  </body>
</html>`.trim();
}

async function sendEmail(opts: {
  to: string[];
  subject: string;
  html: string;
  attachment: { filename: string; content: string };
}) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not set');
  const { Resend } = await import('resend');
  const resend = new Resend(apiKey);
  const result = await resend.emails.send({
    from: 'Rejig.ai Success Team <success@rejig.ai>',
    to: opts.to,
    replyTo: 'success@rejig.ai',
    subject: opts.subject,
    html: opts.html,
    attachments: [
      { filename: opts.attachment.filename, content: Buffer.from(opts.attachment.content, 'utf8').toString('base64') },
    ],
  });
  if (result.error) throw new Error(`Resend error: ${result.error.message}`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
