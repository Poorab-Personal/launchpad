/**
 * Renewals digest — upcoming Core renewals + trial conversions for a given month.
 *
 * Pulls every Core subscription whose currentPeriodEnd lands in the target
 * month, buckets it into:
 *
 *   - Trial converting → first paid   (status=Trial)
 *   - Renewing paying                 (status=Active)
 *   - At-risk                         (status=Past Due, OR customer.atRisk,
 *                                      OR customer.attentionReason set)
 *
 * Per-row we surface: name, workflow, plan + amount + cadence (live Stripe
 * lookup), next-charge date, BI flags (at-risk + attention reason),
 * engagement (days-since-last-login + total posts published) from
 * customer_usage_signals. Cancel-at-period-end subs are kept in the bucket
 * with a ⚠ flag — those are the ones a CSM nudge might save.
 *
 * MVP: terminal-only. CSV + email + skill metadata come in a follow-up.
 *
 * Usage:
 *   npx tsx scripts/renewals-digest.ts                      # next month
 *   npx tsx scripts/renewals-digest.ts 2026-07
 *   npx tsx scripts/renewals-digest.ts july
 *   npx tsx scripts/renewals-digest.ts 2026-07 --workflow B2B-IPRE
 *   npx tsx scripts/renewals-digest.ts 2026-07 --include-test
 */
import dotenv from 'dotenv';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { and, desc, eq, gte, inArray, isNotNull, lte, ne, notInArray } from 'drizzle-orm';
import Stripe from 'stripe';
import { db } from '@/db';
import { customers } from '@/db/schema/customers';
import { customerSubscriptions } from '@/db/schema/customerSubscriptions';
import { customerUsageSignals } from '@/db/schema/customerUsageSignals';

dotenv.config({ path: '.env.local' });

// Workflows with no Stripe subscription by design — B&W's brokerage master
// agreement, Ruhl's intake-only pilot. Excluded from the digest by default.
const NO_STRIPE_WORKFLOW_KEYS = ['B2B-BW', 'B2B-RUHL'];

// ---------- arg parsing ----------

type Args = {
  monthInput: string | null;
  workflow: string | null;
  includeTest: boolean;
  email: string[];
  subject: string | null;
  csv: boolean;
};

function parseArgs(argv: string[]): Args {
  const out: Args = { monthInput: null, workflow: null, includeTest: false, email: [], subject: null, csv: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--workflow') {
      out.workflow = argv[++i] ?? null;
    } else if (a === '--include-test') {
      out.includeTest = true;
    } else if (a === '--email') {
      const list = argv[++i] ?? '';
      out.email = list.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--subject') {
      out.subject = argv[++i] ?? null;
    } else if (a === '--csv') {
      out.csv = true;
    } else if (!a.startsWith('--') && !out.monthInput) {
      out.monthInput = a;
    } else {
      throw new Error(`Unknown arg: ${a}`);
    }
  }
  return out;
}

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

function parseMonth(input: string | null): { start: Date; end: Date; label: string } {
  // Today is whatever the cron / human running the script says it is.
  // We don't use Date.now() relative defaults beyond "next month / this month".
  const now = new Date();
  let year = now.getUTCFullYear();
  let monthIdx: number; // 0-11

  if (!input || input === 'next-month') {
    monthIdx = now.getUTCMonth() + 1;
    if (monthIdx > 11) { monthIdx = 0; year++; }
  } else if (input === 'this-month') {
    monthIdx = now.getUTCMonth();
  } else if (/^\d{4}-\d{1,2}$/.test(input)) {
    const [y, m] = input.split('-').map(Number);
    year = y;
    monthIdx = m - 1;
  } else {
    // "july" or "july 2026"
    const parts = input.toLowerCase().split(/\s+/);
    const nameIdx = MONTH_NAMES.indexOf(parts[0]);
    if (nameIdx < 0) throw new Error(`Can't parse month: "${input}" (try 2026-07, july, or next-month)`);
    monthIdx = nameIdx;
    if (parts[1] && /^\d{4}$/.test(parts[1])) year = Number(parts[1]);
  }

  if (monthIdx < 0 || monthIdx > 11) throw new Error(`Invalid month index ${monthIdx}`);
  const start = new Date(Date.UTC(year, monthIdx, 1));
  const end = new Date(Date.UTC(year, monthIdx + 1, 1));
  const label = `${MONTH_NAMES[monthIdx][0].toUpperCase()}${MONTH_NAMES[monthIdx].slice(1)} ${year}`;
  return { start, end, label };
}

// ---------- stripe ----------

function getStripe(): Stripe {
  // Live subs live in the live Stripe account. The default STRIPE_SECRET_KEY
  // in .env.local is the sandbox — use STRIPE_LIVE_SECRET_KEY when set.
  const key = process.env.STRIPE_LIVE_SECRET_KEY ?? process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('Neither STRIPE_LIVE_SECRET_KEY nor STRIPE_SECRET_KEY is set');
  if (!key.startsWith('sk_live_')) {
    console.warn(`⚠  Using non-live Stripe key (${key.slice(0, 8)}...) — production subs will 404`);
  }
  return new Stripe(key);
}

type SubFacts = {
  unitAmount: number | null;       // cents
  interval: string | null;          // 'month' | 'year' | etc.
  intervalCount: number | null;
  productName: string | null;
  nickname: string | null;
  cancelAtPeriodEnd: boolean;
  error: string | null;
};

async function fetchSubFacts(stripe: Stripe, subId: string | null): Promise<SubFacts> {
  if (!subId) return { unitAmount: null, interval: null, intervalCount: null, productName: null, nickname: null, cancelAtPeriodEnd: false, error: 'no stripeSubscriptionId' };
  try {
    const sub = await stripe.subscriptions.retrieve(subId, { expand: ['items.data.price.product'] });
    const item = sub.items.data[0];
    if (!item) return { unitAmount: null, interval: null, intervalCount: null, productName: null, nickname: null, cancelAtPeriodEnd: sub.cancel_at_period_end, error: 'subscription has no items' };
    const price = item.price;
    const product = price.product as Stripe.Product;
    return {
      unitAmount: price.unit_amount,
      interval: price.recurring?.interval ?? null,
      intervalCount: price.recurring?.interval_count ?? null,
      productName: product?.name ?? null,
      nickname: price.nickname,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      error: null,
    };
  } catch (err) {
    return {
      unitAmount: null, interval: null, intervalCount: null, productName: null, nickname: null, cancelAtPeriodEnd: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function formatPrice(f: SubFacts): string {
  if (f.unitAmount == null || f.interval == null) return f.error ? `?? (${f.error})` : '??';
  const dollars = (f.unitAmount / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const cadence = f.intervalCount && f.intervalCount > 1 ? `${f.intervalCount}${f.interval[0]}` : f.interval === 'month' ? 'mo' : f.interval === 'year' ? 'yr' : f.interval;
  const planLabel = f.nickname || f.productName || 'Plan';
  return `$${dollars}/${cadence} ${planLabel}`;
}

// ---------- engagement signals ----------

type Engagement = {
  daysSinceLogin: number | null;
  totalPosts: number | null;
  loginIso: string | null;
  daysSinceLastPost: number | null;        // null when neverPosted=true OR no signal
  neverPosted: boolean;
  hasPostSignal: boolean;                  // distinguish "no signal yet" from "neverPosted"
};

async function fetchEngagement(customerIds: string[]): Promise<Map<string, Engagement>> {
  const out = new Map<string, Engagement>();
  for (const id of customerIds) out.set(id, {
    daysSinceLogin: null, totalPosts: null, loginIso: null,
    daysSinceLastPost: null, neverPosted: false, hasPostSignal: false,
  });
  if (customerIds.length === 0) return out;

  const rows = await db
    .select({
      customerId: customerUsageSignals.customerId,
      signalType: customerUsageSignals.signalType,
      signalValueNumeric: customerUsageSignals.signalValueNumeric,
      signalValueJsonb: customerUsageSignals.signalValueJsonb,
      observedAt: customerUsageSignals.observedAt,
    })
    .from(customerUsageSignals)
    .where(
      and(
        inArray(customerUsageSignals.customerId, customerIds),
        inArray(customerUsageSignals.signalType, [
          'rejig.last_login',
          'rejig.total_published_posts',
          'rejig.days_since_last_post',
        ]),
      ),
    )
    .orderBy(desc(customerUsageSignals.observedAt));

  // First-seen-wins per (customerId, signalType) = latest signal.
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.customerId) continue;
    const key = `${r.customerId}|${r.signalType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const e = out.get(r.customerId)!;
    if (r.signalType === 'rejig.last_login') {
      e.daysSinceLogin = r.signalValueNumeric != null ? Number(r.signalValueNumeric) : null;
      const jb = r.signalValueJsonb as { lastLoginISO?: string | null; never?: boolean } | null;
      e.loginIso = jb?.lastLoginISO ?? null;
      if (jb?.never) e.daysSinceLogin = null;
    } else if (r.signalType === 'rejig.total_published_posts') {
      e.totalPosts = r.signalValueNumeric != null ? Number(r.signalValueNumeric) : null;
    } else if (r.signalType === 'rejig.days_since_last_post') {
      e.hasPostSignal = true;
      const jb = r.signalValueJsonb as { neverPosted?: boolean } | null;
      e.neverPosted = jb?.neverPosted === true;
      e.daysSinceLastPost = r.signalValueNumeric != null ? Number(r.signalValueNumeric) : null;
    }
  }
  return out;
}

function formatEngagement(e: Engagement): string {
  const loginPart =
    e.daysSinceLogin == null ? (e.loginIso === null ? 'never' : 'no signal')
    : e.daysSinceLogin === 0 ? 'today'
    : `${e.daysSinceLogin}d ago`;
  const postsPart = e.totalPosts == null ? '? posts' : `${e.totalPosts} posts`;
  let lastPart: string;
  if (!e.hasPostSignal) lastPart = 'last ?';
  else if (e.neverPosted) lastPart = 'never posted';
  else if (e.daysSinceLastPost == null) lastPart = 'last ?';
  else if (e.daysSinceLastPost === 0) lastPart = 'last today';
  else lastPart = `last ${e.daysSinceLastPost}d ago`;
  return `login ${loginPart} · ${postsPart} · ${lastPart}`;
}

// ---------- main ----------

type Row = {
  customerId: string;
  name: string;
  workflowKey: string | null;
  contactEmail: string | null;
  status: string | null;
  currentPeriodEnd: Date | null;
  stripeSubscriptionId: string | null;
  attentionReason: string | null;
  atRisk: boolean;
  atRiskReason: string | null;
  billingRelationship: string | null;
  facts: SubFacts;
  engagement: Engagement;
  bucket: 'trial' | 'renew' | 'risk';
  cadence: 'monthly' | 'non-monthly';
};

// BI auto-stamps these two reasons on every customer with an approaching
// renewal — they're the whole point of this digest, so they're not a
// risk signal here. Real risk reasons (engagement_drop_30d, payment_failed,
// payment_past_due, no_show_*, customer_cancelled_onboarding,
// partial_no_completion, stuck_in_onboarding) still flag at-risk.
const CALENDAR_NOISE_REASONS = new Set(['renewal_approaching_2w', 'renewal_approaching_6w']);

function bucketize(r: {
  status: string | null;
  attentionReason: string | null;
  atRisk: boolean;
  cancelAtPeriodEnd: boolean;
}): Row['bucket'] {
  const reasonIsRisk = r.attentionReason
    && r.attentionReason.trim() !== ''
    && !CALENDAR_NOISE_REASONS.has(r.attentionReason);
  if (
    r.status === 'Past Due' ||
    r.status === 'Unpaid' ||
    r.cancelAtPeriodEnd ||
    r.atRisk ||
    reasonIsRisk
  ) {
    return 'risk';
  }
  if (r.status === 'Trial') return 'trial';
  return 'renew';
}

function classifyCadence(facts: SubFacts): 'monthly' | 'non-monthly' {
  // Monthly = 1-month cycle. Everything else (3mo / 6mo / yearly) is the focus.
  // Unknown cadence (no Stripe data) defaults to non-monthly so it stays visible.
  if (facts.interval == null || facts.intervalCount == null) return 'non-monthly';
  return facts.interval === 'month' && facts.intervalCount === 1 ? 'monthly' : 'non-monthly';
}

function colorize(text: string, code: string): string {
  return `\x1b[${code}m${text}\x1b[0m`;
}

function pad(s: string, w: number): string {
  // padEnd counts JS chars; emoji + ANSI break it. Strip ANSI for width calc.
  const visible = s.replace(/\x1b\[[0-9;]*m/g, '');
  const padding = Math.max(0, w - visible.length);
  return s + ' '.repeat(padding);
}

function renderBucket(label: string, rows: Row[], subtotalCents: number): void {
  if (rows.length === 0) {
    console.log(`\n── ${label} (0) ──`);
    console.log('  (none)');
    return;
  }
  console.log(`\n── ${label} (${rows.length}) — subtotal $${(subtotalCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ──\n`);

  const cols = [
    { key: 'date', label: 'Renews' },
    { key: 'name', label: 'Customer' },
    { key: 'workflow', label: 'Workflow' },
    { key: 'plan', label: 'Plan' },
    { key: 'flags', label: 'Flags' },
    { key: 'engagement', label: 'Engagement' },
    { key: 'email', label: 'Email' },
  ] as const;

  const cells = rows.map((r) => {
    const flags: string[] = [];
    if (r.bucket === 'trial') flags.push('Trial→Paid');
    if (r.facts.cancelAtPeriodEnd) flags.push('⚠cancel');
    if (r.atRiskReason) flags.push(`at-risk:${r.atRiskReason}`);
    if (r.attentionReason && !CALENDAR_NOISE_REASONS.has(r.attentionReason)) flags.push(`attn:${r.attentionReason.slice(0, 32)}`);
    if (r.billingRelationship && r.billingRelationship !== 'paying') flags.push(`bill:${r.billingRelationship}`);
    if (r.status === 'Past Due') flags.push('past-due');

    return {
      date: r.currentPeriodEnd?.toISOString().slice(0, 10) ?? '?',
      name: r.name,
      workflow: r.workflowKey ?? '',
      plan: formatPrice(r.facts),
      flags: flags.join(' · ') || '—',
      engagement: formatEngagement(r.engagement),
      email: r.contactEmail ?? '',
    };
  });

  const widths = cols.map((c) => Math.max(c.label.length, ...cells.map((row) => row[c.key].length)));
  const sep = '+' + widths.map((w) => '-'.repeat(w + 2)).join('+') + '+';
  console.log(sep);
  console.log('| ' + cols.map((c, i) => pad(c.label, widths[i])).join(' | ') + ' |');
  console.log(sep);
  for (let i = 0; i < cells.length; i++) {
    const row = cells[i];
    const r = rows[i];
    const line = '| ' + cols.map((c, j) => pad(row[c.key], widths[j])).join(' | ') + ' |';
    // Red highlight for at-risk rows AND cancel-at-end rows in any bucket
    const highlight = r.bucket === 'risk' || r.facts.cancelAtPeriodEnd;
    console.log(highlight ? colorize(line, '31') : line);
  }
  console.log(sep);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { start, end, label } = parseMonth(args.monthInput);

  console.log(`\nRenewals digest — ${label}`);
  console.log(`Window: ${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)} (currentPeriodEnd)\n`);

  // ---------- query ----------

  const baseFilters = [
    eq(customerSubscriptions.product, 'Core'),
    isNotNull(customerSubscriptions.currentPeriodEnd),
    gte(customerSubscriptions.currentPeriodEnd, start),
    lte(customerSubscriptions.currentPeriodEnd, end),
    ne(customerSubscriptions.status, 'Cancelled'),
  ];
  if (args.workflow) {
    baseFilters.push(eq(customers.workflowKey, args.workflow));
  } else {
    // These workflows have no Stripe sub by design (B&W's brokerage master
    // agreement; Ruhl's intake-only pilot) — amount can't be resolved.
    // Exclude by default; --workflow B2B-BW / B2B-RUHL still works to drill in.
    baseFilters.push(notInArray(customers.workflowKey, NO_STRIPE_WORKFLOW_KEYS));
  }

  const rawRows = await db
    .select({
      customerId: customerSubscriptions.customerId,
      status: customerSubscriptions.status,
      currentPeriodEnd: customerSubscriptions.currentPeriodEnd,
      stripeSubscriptionId: customerSubscriptions.stripeSubscriptionId,
      name: customers.name,
      businessName: customers.businessName,
      contactEmail: customers.contactEmail,
      workflowKey: customers.workflowKey,
      attentionReason: customers.attentionReason,
      atRisk: customers.atRisk,
      atRiskReason: customers.atRiskReason,
      billingRelationship: customers.billingRelationship,
      environment: customers.environment,
    })
    .from(customerSubscriptions)
    .innerJoin(customers, eq(customerSubscriptions.customerId, customers.id))
    .where(and(...baseFilters))
    .orderBy(customerSubscriptions.currentPeriodEnd);

  // Filter test customers (environment is text[] in PG; default exclude)
  const filtered = rawRows.filter((r) => {
    if (args.includeTest) return true;
    const envs = (r.environment ?? []) as string[];
    return !envs.includes('test');
  });

  console.log(`Found ${rawRows.length} candidate sub(s); ${filtered.length} after test-env filter${args.workflow ? `; filtered to workflow=${args.workflow}` : ''}\n`);
  if (filtered.length === 0) {
    console.log('No renewals in this window. Done.');
    return;
  }

  // ---------- enrich with Stripe + engagement ----------

  const stripe = getStripe();
  console.log(`Fetching ${filtered.length} sub(s) from Stripe (sequential, ~${Math.round(filtered.length * 0.5)}s)...`);
  const factsList: SubFacts[] = [];
  for (const r of filtered) {
    factsList.push(await fetchSubFacts(stripe, r.stripeSubscriptionId));
  }

  const engagementMap = await fetchEngagement(filtered.map((r) => r.customerId));

  const rows: Row[] = filtered.map((r, i) => ({
    customerId: r.customerId,
    name: r.businessName ?? r.name,
    workflowKey: r.workflowKey,
    contactEmail: r.contactEmail,
    status: r.status,
    currentPeriodEnd: r.currentPeriodEnd,
    stripeSubscriptionId: r.stripeSubscriptionId,
    attentionReason: r.attentionReason,
    atRisk: r.atRisk,
    atRiskReason: r.atRiskReason,
    billingRelationship: r.billingRelationship,
    facts: factsList[i],
    engagement: engagementMap.get(r.customerId)!,
    bucket: bucketize({
      status: r.status,
      attentionReason: r.attentionReason,
      atRisk: r.atRisk,
      cancelAtPeriodEnd: factsList[i].cancelAtPeriodEnd,
    }),
    cadence: classifyCadence(factsList[i]),
  }));

  // ---------- 2x2 partition: cadence × safety ----------

  const isSafe = (r: Row) => r.bucket !== 'risk';
  const nonMonthlySafe = rows.filter((r) => r.cadence === 'non-monthly' && isSafe(r));
  const nonMonthlyRisk = rows.filter((r) => r.cadence === 'non-monthly' && !isSafe(r));
  const monthlySafe    = rows.filter((r) => r.cadence === 'monthly'     && isSafe(r));
  const monthlyRisk    = rows.filter((r) => r.cadence === 'monthly'     && !isSafe(r));

  const sumCents = (rs: Row[]) => rs.reduce((acc, r) => acc + (r.facts.unitAmount ?? 0), 0);
  const nmsTotal = sumCents(nonMonthlySafe);
  const nmrTotal = sumCents(nonMonthlyRisk);
  const msTotal  = sumCents(monthlySafe);
  const mrTotal  = sumCents(monthlyRisk);
  const nmSubtotal = nmsTotal + nmrTotal;
  const mSubtotal  = msTotal  + mrTotal;
  const grand = nmSubtotal + mSubtotal;

  const dollars = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  console.log('\nNote: B2B-BW (Baird & Warner) and B2B-RUHL (Ruhl) excluded — they have no Stripe subscription, so renewal $ cannot be resolved.\n');

  console.log('Summary:');
  console.log('  NON-MONTHLY ($300 / 6-mo / yearly) — primary focus');
  console.log(`    Safe (Renewing + Trial→Paid) : ${String(nonMonthlySafe.length).padStart(3)}   ${dollars(nmsTotal)}`);
  console.log(`    At-risk                      : ${String(nonMonthlyRisk.length).padStart(3)}   ${dollars(nmrTotal)}`);
  console.log(`    Non-monthly subtotal         : ${String(nonMonthlySafe.length + nonMonthlyRisk.length).padStart(3)}   ${dollars(nmSubtotal)}`);
  console.log('');
  console.log('  MONTHLY');
  console.log(`    Safe (Renewing + Trial→Paid) : ${String(monthlySafe.length).padStart(3)}   ${dollars(msTotal)}`);
  console.log(`    At-risk                      : ${String(monthlyRisk.length).padStart(3)}   ${dollars(mrTotal)}`);
  console.log(`    Monthly subtotal             : ${String(monthlySafe.length + monthlyRisk.length).padStart(3)}   ${dollars(mSubtotal)}`);
  console.log('  ───────────────────────────────────────────────');
  console.log(`  GRAND TOTAL                    : ${String(rows.length).padStart(3)}   ${dollars(grand)}`);

  // ---------- render ----------

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  NON-MONTHLY RENEWALS (primary focus)');
  console.log('══════════════════════════════════════════════════════════');
  renderBucket('Safe — Renewing + Trial→Paid', nonMonthlySafe, nmsTotal);
  renderBucket('At-risk', nonMonthlyRisk, nmrTotal);

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  MONTHLY RENEWALS');
  console.log('══════════════════════════════════════════════════════════');
  renderBucket('Safe — Renewing + Trial→Paid', monthlySafe, msTotal);
  renderBucket('At-risk', monthlyRisk, mrTotal);

  // ---------- footer ----------

  const unresolved = rows.filter((r) => r.facts.error).length;
  if (unresolved > 0) {
    console.log(`\n⚠  ${unresolved} sub(s) had Stripe lookup errors — see "??" rows above for reason.`);
  }
  console.log('');

  // ---------- CSV (always built; written to disk if --csv; attached to email always) ----------
  const orderedRows = [...nonMonthlySafe, ...nonMonthlyRisk, ...monthlySafe, ...monthlyRisk];
  const csvBody = buildCsv(orderedRows);
  const monthSlug = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`;
  const today = new Date().toISOString().slice(0, 10);
  const csvName = `renewals-${monthSlug}-${today}.csv`;

  if (args.csv) {
    const csvPath = resolve('scripts/data', csvName);
    writeFileSync(csvPath, csvBody);
    console.log(`CSV written: ${csvPath}`);
  }

  // ---------- email ----------
  if (args.email.length > 0) {
    const subject = args.subject ?? `Renewals digest — ${label} (non-monthly $${(nmSubtotal / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })} · monthly $${(mSubtotal / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })})`;
    const html = buildEmailHtml({
      label,
      windowStart: start.toISOString().slice(0, 10),
      windowEnd: end.toISOString().slice(0, 10),
      nonMonthlySafe,
      nonMonthlyRisk,
      monthlySafe,
      monthlyRisk,
      nmsTotal,
      nmrTotal,
      msTotal,
      mrTotal,
      nmSubtotal,
      mSubtotal,
      grand,
      workflowFilter: args.workflow,
    });
    await sendRenewalsEmail({
      to: args.email,
      subject,
      html,
      attachment: { filename: csvName, content: csvBody },
    });
    console.log(`Email sent to: ${args.email.join(', ')} (CSV attached: ${csvName})`);
  }
}

// ---------- CSV ----------

function csvEsc(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_COLS = [
  'bucket', 'cadence', 'name', 'workflowKey', 'contactEmail',
  'currentPeriodEnd', 'subscriptionStatus',
  'planLabel', 'unitAmountUsd', 'interval', 'intervalCount',
  'cancelAtPeriodEnd', 'attentionReason', 'atRisk', 'atRiskReason',
  'billingRelationship',
  'daysSinceLogin', 'lastLoginISO', 'totalPosts', 'daysSinceLastPost', 'neverPosted',
  'stripeSubscriptionId', 'customerId', 'stripeLookupError',
] as const;

function buildCsv(rows: Row[]): string {
  const lines = [CSV_COLS.join(',')];
  for (const r of rows) {
    const planLabel = r.facts.nickname || r.facts.productName || '';
    const unitUsd = r.facts.unitAmount != null ? (r.facts.unitAmount / 100).toFixed(2) : '';
    const row: Record<typeof CSV_COLS[number], unknown> = {
      bucket: r.bucket,
      cadence: r.cadence,
      name: r.name,
      workflowKey: r.workflowKey,
      contactEmail: r.contactEmail,
      currentPeriodEnd: r.currentPeriodEnd?.toISOString().slice(0, 10) ?? '',
      subscriptionStatus: r.status,
      planLabel,
      unitAmountUsd: unitUsd,
      interval: r.facts.interval,
      intervalCount: r.facts.intervalCount,
      cancelAtPeriodEnd: r.facts.cancelAtPeriodEnd,
      attentionReason: r.attentionReason,
      atRisk: r.atRisk,
      atRiskReason: r.atRiskReason,
      billingRelationship: r.billingRelationship,
      daysSinceLogin: r.engagement.daysSinceLogin,
      lastLoginISO: r.engagement.loginIso,
      totalPosts: r.engagement.totalPosts,
      daysSinceLastPost: r.engagement.daysSinceLastPost,
      neverPosted: r.engagement.neverPosted,
      stripeSubscriptionId: r.stripeSubscriptionId,
      customerId: r.customerId,
      stripeLookupError: r.facts.error,
    };
    lines.push(CSV_COLS.map((c) => csvEsc(row[c])).join(','));
  }
  return lines.join('\n') + '\n';
}

// ---------- email ----------

function escHtml(s: string | null | undefined): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function buildEmailHtml(opts: {
  label: string;
  windowStart: string;
  windowEnd: string;
  nonMonthlySafe: Row[];
  nonMonthlyRisk: Row[];
  monthlySafe: Row[];
  monthlyRisk: Row[];
  nmsTotal: number;
  nmrTotal: number;
  msTotal: number;
  mrTotal: number;
  nmSubtotal: number;
  mSubtotal: number;
  grand: number;
  workflowFilter: string | null;
}): string {
  const {
    label, windowStart, windowEnd,
    nonMonthlySafe, nonMonthlyRisk, monthlySafe, monthlyRisk,
    nmsTotal, nmrTotal, msTotal, mrTotal, nmSubtotal, mSubtotal, grand,
    workflowFilter,
  } = opts;
  const total = nonMonthlySafe.length + nonMonthlyRisk.length + monthlySafe.length + monthlyRisk.length;
  const fmt = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const td = 'padding:6px 10px;border-bottom:1px solid #eee;font-size:13px;vertical-align:top;';
  const tdRisk = `${td}background:#fff5f5;color:#a00;`;
  const tdCancel = `${td}background:#fff8e6;`;
  const th = 'padding:6px 10px;border-bottom:2px solid #444;background:#f6f6f6;font-size:13px;text-align:left;';
  const tdGroup = `${td}background:#eef3ff;font-weight:600;`;
  const tdSubtotal = `${td}background:#f6f6f6;font-weight:600;border-top:1px solid #ccc;`;

  const summaryTable = `
    <table style="border-collapse:collapse;margin:0 0 24px 0;">
      <tr><th style="${th}">Bucket</th><th style="${th};text-align:right;">Count</th><th style="${th};text-align:right;">Subtotal</th></tr>
      <tr><td colspan="3" style="${tdGroup}">NON-MONTHLY ($300 / 6-mo / yearly) — primary focus</td></tr>
      <tr><td style="${td}">&nbsp;&nbsp;Safe (Renewing + Trial→Paid)</td><td style="${td};text-align:right;">${nonMonthlySafe.length}</td><td style="${td};text-align:right;">${fmt(nmsTotal)}</td></tr>
      <tr><td style="${td}">&nbsp;&nbsp;At-risk</td><td style="${td};text-align:right;">${nonMonthlyRisk.length}</td><td style="${td};text-align:right;">${fmt(nmrTotal)}</td></tr>
      <tr><td style="${tdSubtotal}">&nbsp;&nbsp;Non-monthly subtotal</td><td style="${tdSubtotal};text-align:right;">${nonMonthlySafe.length + nonMonthlyRisk.length}</td><td style="${tdSubtotal};text-align:right;">${fmt(nmSubtotal)}</td></tr>
      <tr><td colspan="3" style="${tdGroup}">MONTHLY</td></tr>
      <tr><td style="${td}">&nbsp;&nbsp;Safe (Renewing + Trial→Paid)</td><td style="${td};text-align:right;">${monthlySafe.length}</td><td style="${td};text-align:right;">${fmt(msTotal)}</td></tr>
      <tr><td style="${td}">&nbsp;&nbsp;At-risk</td><td style="${td};text-align:right;">${monthlyRisk.length}</td><td style="${td};text-align:right;">${fmt(mrTotal)}</td></tr>
      <tr><td style="${tdSubtotal}">&nbsp;&nbsp;Monthly subtotal</td><td style="${tdSubtotal};text-align:right;">${monthlySafe.length + monthlyRisk.length}</td><td style="${tdSubtotal};text-align:right;">${fmt(mSubtotal)}</td></tr>
      <tr><td style="${td};font-weight:700;border-top:2px solid #444;">GRAND TOTAL</td><td style="${td};text-align:right;font-weight:700;border-top:2px solid #444;">${total}</td><td style="${td};text-align:right;font-weight:700;border-top:2px solid #444;">${fmt(grand)}</td></tr>
    </table>
  `;

  const renderTable = (rows: Row[]) => {
    if (rows.length === 0) return '<div style="font-size:13px;color:#888;margin:0 0 20px 0;">(none)</div>';
    const headers = ['Renews', 'Customer', 'Workflow', 'Plan', 'Flags', 'Engagement', 'Email'];
    const rowsHtml = rows.map((r) => {
      const flags: string[] = [];
      if (r.bucket === 'trial') flags.push('Trial→Paid');
      if (r.facts.cancelAtPeriodEnd) flags.push('⚠ cancel');
      if (r.atRiskReason) flags.push(`at-risk:${r.atRiskReason}`);
      if (r.attentionReason && !CALENDAR_NOISE_REASONS.has(r.attentionReason)) flags.push(`attn:${r.attentionReason}`);
      if (r.billingRelationship && r.billingRelationship !== 'paying') flags.push(`bill:${r.billingRelationship}`);
      if (r.status === 'Past Due') flags.push('past-due');
      const cellStyle = r.bucket === 'risk' ? tdRisk : r.facts.cancelAtPeriodEnd ? tdCancel : td;
      return `<tr>
        <td style="${cellStyle}">${escHtml(r.currentPeriodEnd?.toISOString().slice(0, 10) ?? '?')}</td>
        <td style="${cellStyle}">${escHtml(r.name)}</td>
        <td style="${cellStyle}">${escHtml(r.workflowKey)}</td>
        <td style="${cellStyle}">${escHtml(formatPrice(r.facts))}</td>
        <td style="${cellStyle}">${escHtml(flags.join(' · ') || '—')}</td>
        <td style="${cellStyle}">${escHtml(formatEngagement(r.engagement))}</td>
        <td style="${cellStyle}">${escHtml(r.contactEmail)}</td>
      </tr>`;
    }).join('');
    return `<table style="border-collapse:collapse;margin:0 0 24px 0;width:100%;">
      <tr>${headers.map((h) => `<th style="${th}">${h}</th>`).join('')}</tr>
      ${rowsHtml}
    </table>`;
  };

  const filterNote = workflowFilter ? ` (filtered to ${escHtml(workflowFilter)})` : '';
  const exclusionBanner = workflowFilter && NO_STRIPE_WORKFLOW_KEYS.includes(workflowFilter) ? '' : `
    <div style="background:#fff4e5;border:1px solid #f0b67f;padding:10px 14px;margin:0 0 18px 0;font-size:13px;color:#7a4a00;">
      <strong>Note — B2B-BW (Baird &amp; Warner) and B2B-RUHL (Ruhl) are excluded from this digest.</strong>
      These customers have no Stripe subscription by design, so their renewal $ cannot be resolved. Pass <code>--workflow B2B-BW</code> or <code>--workflow B2B-RUHL</code> to drill in if needed.
    </div>
  `;

  return `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111;background:#fff;padding:24px;max-width:1200px;margin:0 auto;">
  <h2 style="margin:0 0 6px 0;font-size:18px;">Renewals digest — ${escHtml(label)}${filterNote}</h2>
  <div style="font-size:12px;color:#666;margin:0 0 18px 0;">Window: ${escHtml(windowStart)} → ${escHtml(windowEnd)} (currentPeriodEnd). Cancelled subs excluded.</div>
  ${exclusionBanner}
  <h3 style="margin:0 0 8px 0;font-size:14px;">Summary</h3>
  ${summaryTable}

  <h2 style="margin:24px 0 4px 0;font-size:17px;border-bottom:2px solid #444;padding-bottom:4px;">Non-monthly renewals — primary focus</h2>
  <h3 style="margin:14px 0 8px 0;font-size:14px;">Safe — Renewing + Trial→Paid (${nonMonthlySafe.length}) — ${fmt(nmsTotal)}</h3>
  ${renderTable(nonMonthlySafe)}
  <h3 style="margin:14px 0 8px 0;font-size:14px;">At-risk (${nonMonthlyRisk.length}) — ${fmt(nmrTotal)}</h3>
  ${renderTable(nonMonthlyRisk)}

  <h2 style="margin:28px 0 4px 0;font-size:17px;border-bottom:2px solid #444;padding-bottom:4px;">Monthly renewals</h2>
  <h3 style="margin:14px 0 8px 0;font-size:14px;">Safe — Renewing + Trial→Paid (${monthlySafe.length}) — ${fmt(msTotal)}</h3>
  ${renderTable(monthlySafe)}
  <h3 style="margin:14px 0 8px 0;font-size:14px;">At-risk (${monthlyRisk.length}) — ${fmt(mrTotal)}</h3>
  ${renderTable(monthlyRisk)}

  <div style="font-size:11px;color:#888;margin-top:24px;border-top:1px solid #eee;padding-top:12px;">
    Generated by renewals-digest. Rerun: <code>npx tsx --env-file=.env.local scripts/renewals-digest.ts ${escHtml(label.toLowerCase().split(' ')[0])}${workflowFilter ? ` --workflow ${escHtml(workflowFilter)}` : ''} --email ...</code>
  </div>
</body></html>`.trim();
}

async function sendRenewalsEmail(opts: {
  to: string[];
  subject: string;
  html: string;
  attachment?: { filename: string; content: string };
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
    attachments: opts.attachment
      ? [{
          filename: opts.attachment.filename,
          content: Buffer.from(opts.attachment.content, 'utf8').toString('base64'),
        }]
      : undefined,
  });
  if (result.error) throw new Error(`Resend error: ${result.error.message}`);
  return result.data;
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
