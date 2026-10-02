/**
 * Renewals digest — upcoming charges for a given month.
 *
 * ============================================================================
 * STRIPE IS THE SOURCE OF TRUTH. LaunchPad is an enrichment lookup, never the
 * spine of this report.
 * ============================================================================
 *
 * The report is built by walking live Stripe subscriptions and asking Stripe
 * which ones charge in the target month and for how much. Only then do we go
 * to LaunchPad to decorate each row with health/publishing signals. A Stripe
 * subscription we cannot match to an LP customer is NEVER dropped — it lands
 * in the "Unclear" bucket with its money still counted.
 *
 * This inversion exists because the old version read LP's
 * `customer_subscriptions.current_period_end` mirror, which is written by
 * backfills and by one webhook path and goes stale silently. In the November
 * 2026 run that mirror silently omitted 4 paying customers ($3,000) and
 * counted 2 subs that had already cancelled in Stripe ($1,800). See
 * `docs/plans/renewals-digest-stripe-truth.md`.
 *
 * Three tiers of row, kept visually distinct because they carry different
 * certainty:
 *
 *   CONFIRMED  Stripe says this sub's next charge (or trial end) is in the
 *              month. This is fact.
 *   PROJECTED  Stripe's next-charge date is BEFORE the month, but the
 *              subscription's own cadence lands another charge inside it.
 *              Stripe only advances `current_period_end` after a successful
 *              charge, so without this a monthly sub billing on the 26th is
 *              invisible in next month's report. Derived arithmetic, labelled.
 *   PIPELINE   LP has a captured card for a Keyes/IPRE agent but no Stripe
 *              subscription yet (the trial sub is created when the HubSpot
 *              ticket hits Active, post onboarding call). Projected from the
 *              scheduled call date + the workflow's trial length. Not in
 *              Stripe at all, so reported separately and never in the totals.
 *
 * Trials are first-class: a `trialing` sub's `trial_end` IS its first charge
 * date, and the amount is read off whichever plan the agent actually picked
 * (Keyes/IPRE each offer monthly / quarterly / annual), never assumed.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/renewals-digest.ts                 # next month
 *   npx tsx --env-file=.env.local scripts/renewals-digest.ts 2026-11
 *   npx tsx --env-file=.env.local scripts/renewals-digest.ts november
 *   npx tsx --env-file=.env.local scripts/renewals-digest.ts 2026-11 --workflow B2B-IPRE
 *   npx tsx --env-file=.env.local scripts/renewals-digest.ts 2026-11 --no-projected
 *   npx tsx --env-file=.env.local scripts/renewals-digest.ts 2026-11 --exclude @rejig.ai
 *   npx tsx --env-file=.env.local scripts/renewals-digest.ts 2026-11 --csv
 *   npx tsx --env-file=.env.local scripts/renewals-digest.ts 2026-11 --email a@b.com --note "..."
 *
 * `--note` renders a red caveat banner at the top of the email body. Use it
 * whenever something upstream makes part of the report untrustworthy — most
 * commonly a failed Rejig ingest, which leaves the Engagement column and the
 * BI attention flags stale while the Stripe-derived dates and dollars stay live.
 */
import dotenv from 'dotenv';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import Stripe from 'stripe';
import { db } from '@/db';
import { customers } from '@/db/schema/customers';
import { customerSubscriptions } from '@/db/schema/customerSubscriptions';
import { customerUsageSignals } from '@/db/schema/customerUsageSignals';

dotenv.config({ path: '.env.local' });

// ---------- arg parsing ----------

type Args = {
  monthInput: string | null;
  workflow: string | null;
  includeTest: boolean;
  noProjected: boolean;
  noPipeline: boolean;
  exclude: string[];
  email: string[];
  subject: string | null;
  csv: boolean;
  note: string | null;
};

function parseArgs(argv: string[]): Args {
  const out: Args = {
    monthInput: null, workflow: null, includeTest: false, noProjected: false,
    noPipeline: false, exclude: [], email: [], subject: null, csv: false, note: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--workflow') out.workflow = argv[++i] ?? null;
    else if (a === '--include-test') out.includeTest = true;
    else if (a === '--no-projected') out.noProjected = true;
    else if (a === '--no-pipeline') out.noPipeline = true;
    else if (a === '--exclude') out.exclude = (argv[++i] ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    else if (a === '--email') out.email = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--subject') out.subject = argv[++i] ?? null;
    else if (a === '--csv') out.csv = true;
    else if (a === '--note') out.note = argv[++i] ?? null;
    else if (!a.startsWith('--') && !out.monthInput) out.monthInput = a;
    else throw new Error(`Unrecognised argument: ${a}`);
  }
  return out;
}

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

function parseMonth(input: string | null): { start: Date; end: Date; label: string } {
  const now = new Date();
  let year = now.getUTCFullYear();
  let monthIdx: number;

  if (!input || input === 'next-month') {
    monthIdx = now.getUTCMonth() + 1;
    if (monthIdx > 11) { monthIdx = 0; year++; }
  } else if (input === 'this-month') {
    monthIdx = now.getUTCMonth();
  } else if (/^\d{4}-\d{1,2}$/.test(input)) {
    const [y, m] = input.split('-').map(Number);
    year = y; monthIdx = m - 1;
  } else {
    const parts = input.toLowerCase().split(/\s+/);
    const nameIdx = MONTH_NAMES.indexOf(parts[0]);
    if (nameIdx < 0) throw new Error(`Can't parse month: "${input}" (try 2026-11, november, or next-month)`);
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
  const key = process.env.STRIPE_LIVE_SECRET_KEY ?? process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('Neither STRIPE_LIVE_SECRET_KEY nor STRIPE_SECRET_KEY is set');
  if (!key.startsWith('sk_live_')) {
    console.warn(`⚠  Using non-live Stripe key (${key.slice(0, 8)}...) — this report will not reflect production billing`);
  }
  return new Stripe(key);
}

/** Statuses that represent a subscription which can still bill us money. */
const BILLABLE_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid', 'paused']);

/**
 * Core Rejig's Keller Williams self-serve tiers ($20 Starter / $50 Pro /
 * $90 Elite). These agents buy directly in the product and never pass through
 * LaunchPad onboarding, so they have no LP customer by design — they are NOT
 * unmatched data to chase. They get their own bucket.
 *
 * Keyed on product id rather than plan name so a D2C customer who happens to
 * work at a KW brokerage is never swept in. The name regex below is only a
 * safety net for a newly added tier, and warns so the id can be added here.
 */
const KW_SELF_SERVE_PRODUCT_IDS = new Set([
  'prod_UjC0vQ41wyWTV7', // Rejig.ai - Starter Plan for Keller Williams
  'prod_UjC3qGGvqTajgn', // Rejig.ai - Pro plan for Keller Williams
  'prod_UjC6xw0ZDNvCPK', // Rejig.ai - Elite plan for Keller Williams
]);
const KW_SELF_SERVE_NAME_RE = /plan for keller williams/i;
const kwFallbackHits = new Set<string>();

function isKwSelfServe(sub: StripeSub, productNames: Map<string, string>): boolean {
  if (sub.productId && KW_SELF_SERVE_PRODUCT_IDS.has(sub.productId)) return true;
  const label = `${sub.nickname ?? ''} ${sub.productId ? productNames.get(sub.productId) ?? '' : ''}`;
  if (KW_SELF_SERVE_NAME_RE.test(label)) {
    if (sub.productId) kwFallbackHits.add(`${sub.productId} (${productNames.get(sub.productId) ?? label.trim()})`);
    return true;
  }
  return false;
}

type StripeSub = {
  subId: string;
  stripeCustomerId: string | null;
  status: string;
  cancelAtPeriodEnd: boolean;
  /** Stripe's own next-charge instant: trial_end while trialing, else the item period end. */
  nextChargeMs: number | null;
  interval: string | null;
  intervalCount: number | null;
  /** Sum of unit_amount x quantity across all items — handles seat-based group plans. */
  amountCents: number;
  /** Seat count when > 1 (group/team plan). */
  quantity: number;
  priceId: string | null;
  productId: string | null;
  nickname: string | null;
  mixedCadence: boolean;
  /** True when no item carried a unit_amount (metered/tiered) — amount unreliable. */
  amountUnresolved: boolean;
};

/**
 * Pull every billable subscription in the live account.
 *
 * `current_period_end` moved off the subscription root onto the items in
 * Stripe API 2024-04-10+, so read the item first and fall back to the root
 * for older API versions. `trial_end` is preferred ONLY while the sub is
 * actually trialing — on a converted sub it is a historical date, and
 * trusting it there is what produced the stale dates this rewrite replaces.
 */
async function fetchAllBillableSubs(stripe: Stripe): Promise<StripeSub[]> {
  const out: StripeSub[] = [];
  for await (const sub of stripe.subscriptions.list({
    status: 'all',
    limit: 100,
    expand: ['data.items.data.price'],
  })) {
    if (!BILLABLE_STATUSES.has(sub.status)) continue;

    const anySub = sub as unknown as {
      current_period_end?: number;
      items?: { data?: Array<{ current_period_end?: number }> };
    };
    const items = sub.items?.data ?? [];
    const first = items[0];
    const itemPeriodEnd = anySub.items?.data?.[0]?.current_period_end;
    const periodEnd = itemPeriodEnd ?? anySub.current_period_end ?? null;
    const nextChargeSec = sub.status === 'trialing' ? (sub.trial_end ?? periodEnd) : periodEnd;

    let amountCents = 0;
    let anyAmount = false;
    for (const it of items) {
      const ua = it.price?.unit_amount;
      if (ua != null) { amountCents += ua * (it.quantity ?? 1); anyAmount = true; }
    }

    const intervals = new Set(items.map((it) => `${it.price?.recurring?.interval_count ?? 1}${it.price?.recurring?.interval ?? '?'}`));

    const stripeCustomerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id ?? null;
    const price = first?.price;
    const productId = typeof price?.product === 'string' ? price.product : (price?.product as Stripe.Product | undefined)?.id ?? null;

    out.push({
      subId: sub.id,
      stripeCustomerId,
      status: sub.status,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      nextChargeMs: nextChargeSec ? nextChargeSec * 1000 : null,
      interval: price?.recurring?.interval ?? null,
      intervalCount: price?.recurring?.interval_count ?? null,
      amountCents,
      quantity: first?.quantity ?? 1,
      priceId: price?.id ?? null,
      productId,
      nickname: price?.nickname ?? null,
      mixedCadence: intervals.size > 1,
      amountUnresolved: !anyAmount,
    });
  }
  return out;
}

/** Product names for plan labels. Retrieved once per distinct product. */
async function fetchProductNames(stripe: Stripe, productIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const id of [...new Set(productIds)]) {
    try {
      const p = await stripe.products.retrieve(id);
      out.set(id, p.name);
    } catch {
      /* label falls back to nickname / price id */
    }
  }
  return out;
}

// ---------- date arithmetic for projections ----------

/** Add n intervals to a UTC instant, clamping the day for short months. */
function addInterval(ms: number, interval: string, count: number): number {
  const d = new Date(ms);
  if (interval === 'day') return ms + count * 86400000;
  if (interval === 'week') return ms + count * 7 * 86400000;
  const monthsToAdd = interval === 'year' ? count * 12 : count;
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + monthsToAdd, 1,
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
  const daysInTarget = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, daysInTarget));
  return target.getTime();
}

/**
 * Roll a sub's next-charge date forward by its own cadence until it reaches
 * the window. Returns the in-window charge date, or null if the cadence
 * steps straight over the month (a quarterly sub charging in October next
 * charges in January — correctly absent from a November report).
 */
function projectIntoWindow(
  nextChargeMs: number, interval: string, intervalCount: number,
  startMs: number, endMs: number,
): number | null {
  let t = nextChargeMs;
  let guard = 0;
  while (t < startMs && guard++ < 400) t = addInterval(t, interval, intervalCount);
  return t >= startMs && t < endMs ? t : null;
}

// ---------- LaunchPad enrichment (decoration only, never authoritative) ----------

type Engagement = {
  daysSinceLogin: number | null;
  totalPosts: number | null;
  loginIso: string | null;
  daysSinceLastPost: number | null;
  neverPosted: boolean;
  hasPostSignal: boolean;
};

const EMPTY_ENGAGEMENT: Engagement = {
  daysSinceLogin: null, totalPosts: null, loginIso: null,
  daysSinceLastPost: null, neverPosted: false, hasPostSignal: false,
};

type LpCustomer = {
  customerId: string;
  name: string;
  workflowKey: string | null;
  contactEmail: string | null;
  attentionReason: string | null;
  atRisk: boolean;
  atRiskReason: string | null;
  billingRelationship: string | null;
  isTest: boolean;
  lpSubStatus: string | null;
  engagement: Engagement;
};

/** Normalised name key for last-resort matching across billing-identity drift. */
function nameKey(s: string | null | undefined): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/\b(llc|inc|pa|p\.a\.|pllc|realtor|realtors|real estate|team|group|the)\b/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

type LpIndex = {
  bySubId: Map<string, LpCustomer[]>;
  byStripeCustomerId: Map<string, LpCustomer[]>;
  byEmail: Map<string, LpCustomer[]>;
  byNameKey: Map<string, LpCustomer[]>;
  /** Token sets for last-resort subset matching across billing-identity drift. */
  tokenSets: Array<{ customer: LpCustomer; tokens: Set<string> }>;
  all: LpCustomer[];
};

/**
 * Significant word tokens of a name, for matching a personal billing identity
 * against a business-styled LP record ("George Oberdorster" vs "George
 * Oberdorster - Real Broker LLC."). Boilerplate and initials are dropped.
 */
const NAME_STOPWORDS = new Set([
  'llc', 'inc', 'pa', 'pllc', 'pc', 'ltd', 'co', 'corp',
  'realtor', 'realtors', 'realty', 'real', 'estate', 'team', 'group', 'the', 'and',
  'properties', 'property', 'homes', 'home', 'broker', 'brokered', 'associates',
  'keller', 'williams', 'compass', 'exp', 'remax', 'coldwell', 'banker', 'by', 'at', 'of',
]);

function nameTokens(s: string | null | undefined): Set<string> {
  return new Set(
    String(s ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2 && !NAME_STOPWORDS.has(t)),
  );
}

/**
 * Unique LP customer whose significant name tokens fully contain, or are
 * contained by, the Stripe billing name's — requiring at least two shared
 * tokens so a bare first name can never match. Ambiguity means no match:
 * attaching the wrong person's health data is worse than leaving a row
 * Unclear.
 */
function matchByNameSubset(idx: LpIndex, stripeName: string | null): LpCustomer[] {
  if (!stripeName) return [];
  const want = nameTokens(stripeName);
  if (want.size < 2) return [];
  const hits: LpCustomer[] = [];
  for (const { customer, tokens } of idx.tokenSets) {
    if (tokens.size < 2) continue;
    const shared = [...want].filter((t) => tokens.has(t)).length;
    if (shared < 2) continue;
    const subset = shared === want.size || shared === tokens.size;
    if (subset) hits.push(customer);
  }
  const distinct = [...new Map(hits.map((h) => [h.customerId, h])).values()];
  return distinct.length === 1 ? distinct : [];
}

async function buildLpIndex(): Promise<LpIndex> {
  const rows = await db
    .select({
      customerId: customers.id,
      name: customers.name,
      businessName: customers.businessName,
      workflowKey: customers.workflowKey,
      contactEmail: customers.contactEmail,
      stripeCustomerId: customers.stripeCustomerId,
      attentionReason: customers.attentionReason,
      atRisk: customers.atRisk,
      atRiskReason: customers.atRiskReason,
      billingRelationship: customers.billingRelationship,
      environment: customers.environment,
      subId: customerSubscriptions.stripeSubscriptionId,
      lpSubStatus: customerSubscriptions.status,
      legacySubId: customers.stripeSubscriptionId,
      legacyVoiceId: customers.voiceStripeId,
      legacyAvatarId: customers.avatarStripeId,
    })
    .from(customers)
    // Every product, not just Core: an Avatar or Voice subscription still has
    // to resolve to its LP customer, or it lands in Unclear for no reason.
    .leftJoin(customerSubscriptions, eq(customerSubscriptions.customerId, customers.id));

  const engagement = await fetchEngagement([...new Set(rows.map((r) => r.customerId))]);

  const idx: LpIndex = {
    bySubId: new Map(), byStripeCustomerId: new Map(), byEmail: new Map(), byNameKey: new Map(),
    tokenSets: [], all: [],
  };
  const seenCustomerIds = new Set<string>();
  // The all-products join fans out one row per (customer, product), so every
  // index is de-duplicated by customerId to keep "shared by N customers"
  // meaning N distinct customers rather than N subscription rows.
  const push = (m: Map<string, LpCustomer[]>, k: string | null | undefined, v: LpCustomer) => {
    if (!k) return;
    const arr = m.get(k) ?? [];
    if (!arr.some((x) => x.customerId === v.customerId)) arr.push(v);
    m.set(k, arr);
  };

  for (const r of rows) {
    const c: LpCustomer = {
      customerId: r.customerId,
      name: r.businessName ?? r.name,
      workflowKey: r.workflowKey,
      contactEmail: r.contactEmail,
      attentionReason: r.attentionReason,
      atRisk: r.atRisk,
      atRiskReason: r.atRiskReason,
      billingRelationship: r.billingRelationship,
      isTest: ((r.environment ?? []) as string[]).includes('test'),
      lpSubStatus: r.lpSubStatus,
      engagement: engagement.get(r.customerId) ?? EMPTY_ENGAGEMENT,
    };
    if (!seenCustomerIds.has(r.customerId)) {
      seenCustomerIds.add(r.customerId);
      idx.all.push(c);
      idx.tokenSets.push({ customer: c, tokens: nameTokens(r.businessName ?? r.name) });
    }
    push(idx.bySubId, r.subId, c);
    // Legacy single-value columns still point at subs for pre-table rows.
    for (const legacy of [r.legacySubId, r.legacyVoiceId, r.legacyAvatarId]) {
      if (legacy && legacy !== r.subId) push(idx.bySubId, legacy, c);
    }
    push(idx.byStripeCustomerId, r.stripeCustomerId, c);
    push(idx.byEmail, r.contactEmail?.toLowerCase() ?? null, c);
    push(idx.byNameKey, nameKey(r.businessName ?? r.name) || null, c);
  }
  return idx;
}

async function fetchEngagement(customerIds: string[]): Promise<Map<string, Engagement>> {
  const out = new Map<string, Engagement>();
  if (customerIds.length === 0) return out;
  for (const id of customerIds) out.set(id, { ...EMPTY_ENGAGEMENT });

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
          'rejig.last_login', 'rejig.total_published_posts', 'rejig.days_since_last_post',
        ]),
      ),
    )
    .orderBy(desc(customerUsageSignals.observedAt));

  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.customerId) continue;
    const key = `${r.customerId}|${r.signalType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const e = out.get(r.customerId);
    if (!e) continue;
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

/** How freshly LP's Rejig engagement signals were pulled. Shown as a caveat. */
async function fetchEngagementAsOf(): Promise<string | null> {
  const r = await db
    .select({ latest: sql<string | null>`max(${customerUsageSignals.observedAt})::text` })
    .from(customerUsageSignals)
    .where(eq(customerUsageSignals.signalType, 'rejig.total_published_posts'));
  const v = r[0]?.latest;
  return v ? String(v).slice(0, 10) : null;
}

// ---------- row assembly ----------

type MatchMethod = 'sub_id' | 'stripe_customer_id' | 'email' | 'name' | 'name_subset' | 'same_stripe_customer' | null;

type Row = {
  tier: 'confirmed' | 'projected';
  chargeMs: number;
  sub: StripeSub;
  planLabel: string;
  /** Stripe-side identity, always present — the report never depends on LP for this. */
  stripeName: string | null;
  stripeEmail: string | null;
  lp: LpCustomer | null;
  lpGroup: LpCustomer[];
  matchMethod: MatchMethod;
  /** Billable subs in this report sharing the same Stripe customer. */
  siblingSubCount: number;
  /** Billable subs in this report sharing the same billing email. */
  sameEmailSubCount: number;
  bucket: 'trial' | 'renew' | 'risk' | 'unclear' | 'kw_selfserve';
  cadence: 'monthly' | 'non-monthly';
};

/**
 * BI auto-stamps these on every customer with an approaching renewal — which
 * is every row in this report — so they are not a risk signal here.
 */
const CALENDAR_NOISE_REASONS = new Set(['renewal_approaching_2w', 'renewal_approaching_6w']);

function classify(sub: StripeSub, lp: LpCustomer | null, isKw: boolean): Row['bucket'] {
  // KW self-serve first: having no LP customer is expected for this line, so
  // it must never be reported as an unmatched row needing investigation.
  if (isKw) return 'kw_selfserve';
  if (!lp) return 'unclear';
  const reasonIsRisk = lp.attentionReason
    && lp.attentionReason.trim() !== ''
    && !CALENDAR_NOISE_REASONS.has(lp.attentionReason);
  // Stripe status is authoritative for payment health.
  if (sub.status === 'past_due' || sub.status === 'unpaid' || sub.status === 'paused') return 'risk';
  if (sub.cancelAtPeriodEnd) return 'risk';
  if (lp.atRisk || reasonIsRisk) return 'risk';
  if (sub.status === 'trialing') return 'trial';
  return 'renew';
}

function cadenceOf(sub: StripeSub): 'monthly' | 'non-monthly' {
  if (sub.interval == null || sub.intervalCount == null) return 'non-monthly';
  return sub.interval === 'month' && sub.intervalCount === 1 ? 'monthly' : 'non-monthly';
}

function formatPlan(sub: StripeSub, productNames: Map<string, string>): string {
  const label = sub.nickname || (sub.productId ? productNames.get(sub.productId) : null) || sub.priceId || 'Plan';
  if (sub.amountUnresolved) return `?? ${label}`;
  const dollars = (sub.amountCents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const cadence = sub.interval == null ? '?'
    : sub.intervalCount && sub.intervalCount > 1 ? `${sub.intervalCount}${sub.interval[0]}`
    : sub.interval === 'month' ? 'mo' : sub.interval === 'year' ? 'yr' : sub.interval;
  const seats = sub.quantity > 1 ? ` ×${sub.quantity} seats` : '';
  return `$${dollars}/${cadence} ${label}${seats}`;
}

/**
 * Display name. When LP was matched by a fuzzy tier and Stripe bills under a
 * different name, show both — otherwise two subscriptions that resolve to the
 * same LP customer render identically. Travous Dever bills two real
 * subscriptions from one email across two Stripe customers, one of them
 * display-named "jennifer lux"; collapsing them would hide a genuine second
 * business and look like a duplicate.
 */
const FUZZY_METHODS = new Set<MatchMethod>(['email', 'name', 'name_subset', 'same_stripe_customer']);

function displayName(r: Row): string {
  const lpName = r.lp?.name ?? null;
  if (!lpName) return r.stripeName ?? '(unknown in LP)';
  if (!r.stripeName || !FUZZY_METHODS.has(r.matchMethod)) return lpName;
  if (nameKey(r.stripeName) === nameKey(lpName)) return lpName;
  return `${lpName} (billed as: ${r.stripeName})`;
}

function formatEngagement(lp: LpCustomer | null): string {
  if (!lp) return 'no LP match — unknown';
  const e = lp.engagement;
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

function flagsFor(r: Row): string[] {
  const f: string[] = [];
  if (r.tier === 'projected') f.push('projected');
  // Only a CONFIRMED row on a trialing sub is the first charge; a projected
  // row is a later cycle, after the trial has already converted.
  if (r.sub.status === 'trialing' && r.tier === 'confirmed') f.push('Trial→1st charge');
  if (r.sub.cancelAtPeriodEnd) f.push('⚠ cancel');
  if (r.sub.status === 'past_due') f.push('past-due');
  if (r.sub.status === 'unpaid') f.push('unpaid');
  if (r.sub.status === 'paused') f.push('paused');
  if (r.bucket === 'kw_selfserve') f.push('KW self-serve');
  // Several billable subs on one Stripe customer, or across several Stripe
  // customers sharing one billing email: sometimes a genuine second business,
  // sometimes a duplicate worth cancelling. Surfaced, never merged.
  if (r.siblingSubCount > 1) f.push(`${r.siblingSubCount} subs on this Stripe customer`);
  if (r.sameEmailSubCount > 1) f.push(`${r.sameEmailSubCount} subs on this billing email`);
  if (r.sub.quantity > 1) f.push(`group:${r.sub.quantity} seats`);
  if (r.lpGroup.length > 1) f.push(`shared by ${r.lpGroup.length} LP customers`);
  if (r.lp?.atRiskReason) f.push(`at-risk:${r.lp.atRiskReason}`);
  if (r.lp?.attentionReason && !CALENDAR_NOISE_REASONS.has(r.lp.attentionReason)) f.push(`attn:${r.lp.attentionReason}`);
  if (r.lp?.billingRelationship && r.lp.billingRelationship !== 'paying') f.push(`bill:${r.lp.billingRelationship}`);
  if (r.matchMethod && r.matchMethod !== 'sub_id') f.push(`matched-by:${r.matchMethod}`);
  if (r.sub.mixedCadence) f.push('mixed-cadence');
  return f;
}

// ---------- pipeline: LP pending trials with no Stripe sub yet ----------

type PipelineRow = {
  customerId: string;
  name: string;
  workflowKey: string | null;
  contactEmail: string | null;
  callDate: Date;
  projectedFirstChargeMs: number;
  trialDays: number;
  selectedPlanName: string | null;
};

/**
 * Keyes/IPRE agents who captured a card but have no Stripe subscription yet —
 * the trial sub is only created when the HubSpot ticket reaches Active, after
 * the onboarding call. Their first charge is therefore projected from the
 * scheduled call date plus the workflow's trial length. Entirely LP-derived
 * and not in Stripe, so it is reported apart from every total.
 */
async function fetchPipeline(startMs: number, endMs: number): Promise<PipelineRow[]> {
  const rows = await db.execute(sql`
    SELECT c.id, c.name, c.business_name, c.workflow_key, c.contact_email,
           c.selected_plan_name,
           cl.scheduled_date,
           COALESCE(wt.trial_days, 30) AS trial_days
    FROM customers c
    LEFT JOIN customer_subscriptions cs
      ON cs.customer_id = c.id AND cs.product = 'Core'
    JOIN calls cl
      ON cl.customer_id = c.id AND cl.type = 'Onboarding' AND cl.status = 'Scheduled'
    LEFT JOIN (
      SELECT workflow_key, max(trial_days) AS trial_days
      FROM workflow_templates WHERE trial_days IS NOT NULL GROUP BY workflow_key
    ) wt ON wt.workflow_key = c.workflow_key
    WHERE cs.id IS NULL
      AND c.stripe_customer_id IS NOT NULL
      AND (c.onboarding_state IS NULL OR c.onboarding_state::text <> 'Churned')
      AND (c.environment IS NULL OR NOT (c.environment @> ARRAY['test']::text[]))
      -- A call still marked Scheduled well after its date is an unmarked
      -- outcome, not an upcoming meeting; projecting a charge off it invents
      -- revenue. 14 days is the grace period before we stop trusting it.
      AND cl.scheduled_date >= now() - interval '14 days'
  `);

  const out: PipelineRow[] = [];
  for (const r of rows.rows as Array<Record<string, unknown>>) {
    const call = r.scheduled_date ? new Date(String(r.scheduled_date)) : null;
    if (!call || Number.isNaN(call.getTime())) continue;
    const trialDays = Number(r.trial_days ?? 30);
    const firstCharge = call.getTime() + trialDays * 86400000;
    if (firstCharge < startMs || firstCharge >= endMs) continue;
    out.push({
      customerId: String(r.id),
      name: String(r.business_name ?? r.name ?? '(no name)'),
      workflowKey: r.workflow_key ? String(r.workflow_key) : null,
      contactEmail: r.contact_email ? String(r.contact_email) : null,
      callDate: call,
      projectedFirstChargeMs: firstCharge,
      trialDays,
      selectedPlanName: r.selected_plan_name ? String(r.selected_plan_name) : null,
    });
  }
  return out.sort((a, b) => a.projectedFirstChargeMs - b.projectedFirstChargeMs);
}

// ---------- terminal rendering ----------

function colorize(text: string, code: string): string { return `\x1b[${code}m${text}\x1b[0m`; }

function pad(s: string, w: number): string {
  const visible = s.replace(/\x1b\[[0-9;]*m/g, '');
  return s + ' '.repeat(Math.max(0, w - visible.length));
}

const isoDay = (ms: number | null) => (ms == null ? '?' : new Date(ms).toISOString().slice(0, 10));
const usd = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function renderBucket(label: string, rows: Row[], subtotalCents: number, productNames: Map<string, string>): void {
  if (rows.length === 0) {
    console.log(`\n── ${label} (0) ──`);
    console.log('  (none)');
    return;
  }
  console.log(`\n── ${label} (${rows.length}) — subtotal ${usd(subtotalCents)} ──\n`);
  const cols = [
    { key: 'charge', head: 'Charges' },
    { key: 'name', head: 'Customer' },
    { key: 'workflow', head: 'Workflow' },
    { key: 'plan', head: 'Plan' },
    { key: 'flags', head: 'Flags' },
    { key: 'eng', head: 'Engagement' },
    { key: 'email', head: 'Email' },
  ] as const;

  const cells = rows.map((r) => ({
    charge: isoDay(r.chargeMs),
    name: displayName(r),
    workflow: r.lp?.workflowKey ?? '—',
    plan: formatPlan(r.sub, productNames),
    flags: flagsFor(r).join(' · ') || '—',
    eng: formatEngagement(r.lp),
    email: r.lp?.contactEmail ?? r.stripeEmail ?? '—',
  }));

  const widths = cols.map((c) => Math.max(c.head.length, ...cells.map((x) => x[c.key].length)));
  const sep = '+' + widths.map((w) => '-'.repeat(w + 2)).join('+') + '+';
  console.log(sep);
  console.log('| ' + cols.map((c, i) => pad(c.head, widths[i])).join(' | ') + ' |');
  console.log(sep);
  for (let i = 0; i < cells.length; i++) {
    const line = '| ' + cols.map((c, j) => pad(cells[i][c.key], widths[j])).join(' | ') + ' |';
    const r = rows[i];
    const highlight = r.bucket === 'risk' || r.sub.cancelAtPeriodEnd;
    console.log(highlight ? colorize(line, '31') : r.bucket === 'unclear' ? colorize(line, '33') : line);
  }
  console.log(sep);
}

// ---------- main ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { start, end, label } = parseMonth(args.monthInput);
  const startMs = start.getTime();
  const endMs = end.getTime();

  console.log(`\nRenewals digest — ${label}`);
  console.log(`Window: ${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)}`);
  console.log('Source of truth: live Stripe. LaunchPad is used only to decorate rows with health signals.\n');

  const stripe = getStripe();
  console.log('Pulling all billable subscriptions from Stripe...');
  const allSubs = await fetchAllBillableSubs(stripe);
  console.log(`  ${allSubs.length} billable subs in the live account (active / trialing / past_due / unpaid / paused)`);

  // ---------- pick the subs that charge in the window ----------

  type Picked = { sub: StripeSub; tier: 'confirmed' | 'projected'; chargeMs: number };
  const picked: Picked[] = [];
  for (const sub of allSubs) {
    if (sub.nextChargeMs == null) continue;
    if (sub.nextChargeMs >= startMs && sub.nextChargeMs < endMs) {
      picked.push({ sub, tier: 'confirmed', chargeMs: sub.nextChargeMs });
      continue;
    }
    if (args.noProjected) continue;
    // Only roll forward subs that will actually keep billing.
    if (sub.nextChargeMs >= endMs) continue;
    if (sub.cancelAtPeriodEnd) continue;
    if (sub.status !== 'active' && sub.status !== 'trialing') continue;
    if (!sub.interval || !sub.intervalCount) continue;
    const projectedMs = projectIntoWindow(sub.nextChargeMs, sub.interval, sub.intervalCount, startMs, endMs);
    if (projectedMs != null) picked.push({ sub, tier: 'projected', chargeMs: projectedMs });
  }
  console.log(`  ${picked.filter((p) => p.tier === 'confirmed').length} confirmed in-window, ${picked.filter((p) => p.tier === 'projected').length} projected into window`);

  // ---------- resolve identity + LP enrichment ----------

  const productNames = await fetchProductNames(stripe, picked.map((p) => p.sub.productId).filter((x): x is string => !!x));
  console.log('Building LaunchPad enrichment index...');
  const lpIndex = await buildLpIndex();
  const engagementAsOf = await fetchEngagementAsOf();

  // Stripe customer objects: needed for identity on every row (so an unmatched
  // row is still actionable) and for email/name fallback matching.
  const custIds = [...new Set(picked.map((p) => p.sub.stripeCustomerId).filter((x): x is string => !!x))];
  console.log(`Fetching ${custIds.length} Stripe customer record(s) for identity...`);
  const stripeCustomers = new Map<string, { name: string | null; email: string | null }>();
  for (const id of custIds) {
    try {
      const c = await stripe.customers.retrieve(id);
      if (!('deleted' in c && c.deleted)) {
        stripeCustomers.set(id, { name: (c as Stripe.Customer).name ?? null, email: (c as Stripe.Customer).email ?? null });
      }
    } catch {
      /* identity falls back to the sub id */
    }
  }

  const rows: Row[] = [];
  for (const p of picked) {
    const sub = p.sub;
    const ident = sub.stripeCustomerId ? stripeCustomers.get(sub.stripeCustomerId) : undefined;
    const stripeName = ident?.name ?? null;
    const stripeEmail = ident?.email ?? null;

    // Match LP in descending order of reliability. Never let a miss drop a row.
    let group: LpCustomer[] = [];
    let method: MatchMethod = null;
    const tryMatch = (arr: LpCustomer[] | undefined, m: MatchMethod) => {
      if (group.length === 0 && arr && arr.length > 0) { group = arr; method = m; }
    };
    tryMatch(lpIndex.bySubId.get(sub.subId), 'sub_id');
    if (sub.stripeCustomerId) tryMatch(lpIndex.byStripeCustomerId.get(sub.stripeCustomerId), 'stripe_customer_id');
    if (stripeEmail) tryMatch(lpIndex.byEmail.get(stripeEmail.toLowerCase()), 'email');
    if (stripeName) tryMatch(lpIndex.byNameKey.get(nameKey(stripeName)), 'name');
    if (stripeName) tryMatch(matchByNameSubset(lpIndex, stripeName), 'name_subset');

    const lp = group[0] ?? null;

    if (lp?.isTest && !args.includeTest) continue;
    if (args.workflow && lp?.workflowKey !== args.workflow) continue;
    if (args.exclude.length > 0) {
      const hay = `${lp?.contactEmail ?? ''} ${stripeEmail ?? ''} ${lp?.name ?? ''} ${stripeName ?? ''}`.toLowerCase();
      if (args.exclude.some((x) => hay.includes(x))) continue;
    }

    rows.push({
      tier: p.tier,
      chargeMs: p.chargeMs,
      sub,
      planLabel: formatPlan(sub, productNames),
      stripeName,
      stripeEmail,
      lp,
      lpGroup: group,
      matchMethod: method,
      siblingSubCount: 1,
      sameEmailSubCount: 1,
      bucket: classify(sub, lp, isKwSelfServe(sub, productNames)),
      cadence: cadenceOf(sub),
    });
  }
  rows.sort((a, b) => a.chargeMs - b.chargeMs);

  // Count billable subs per Stripe customer so duplicates and genuine
  // second businesses are both visible without being merged.
  const subsPerStripeCustomer = new Map<string, number>();
  for (const r of rows) {
    if (!r.sub.stripeCustomerId) continue;
    subsPerStripeCustomer.set(r.sub.stripeCustomerId, (subsPerStripeCustomer.get(r.sub.stripeCustomerId) ?? 0) + 1);
  }
  const subsPerEmail = new Map<string, number>();
  for (const r of rows) {
    const key = (r.stripeEmail ?? r.lp?.contactEmail ?? '').toLowerCase();
    if (!key) continue;
    subsPerEmail.set(key, (subsPerEmail.get(key) ?? 0) + 1);
  }
  for (const r of rows) {
    r.siblingSubCount = r.sub.stripeCustomerId ? subsPerStripeCustomer.get(r.sub.stripeCustomerId) ?? 1 : 1;
    const ekey = (r.stripeEmail ?? r.lp?.contactEmail ?? '').toLowerCase();
    r.sameEmailSubCount = ekey ? subsPerEmail.get(ekey) ?? 1 : 1;
  }

  // One Stripe customer is one human. If any of their subscriptions resolved
  // to an LP customer, an add-on subscription billed to the same Stripe
  // customer belongs to that same person — so inherit the match rather than
  // stranding a Voice/Avatar row in Unclear.
  const lpByStripeCustomer = new Map<string, Row>();
  for (const r of rows) {
    if (r.lp && r.sub.stripeCustomerId && !lpByStripeCustomer.has(r.sub.stripeCustomerId)) {
      lpByStripeCustomer.set(r.sub.stripeCustomerId, r);
    }
  }
  for (const r of rows) {
    if (r.lp || !r.sub.stripeCustomerId) continue;
    const sibling = lpByStripeCustomer.get(r.sub.stripeCustomerId);
    if (!sibling?.lp) continue;
    r.lp = sibling.lp;
    r.lpGroup = sibling.lpGroup;
    r.matchMethod = 'same_stripe_customer';
    r.bucket = classify(r.sub, r.lp, isKwSelfServe(r.sub, productNames));
  }

  // ---------- partition ----------

  const confirmed = rows.filter((r) => r.tier === 'confirmed');
  const projected = rows.filter((r) => r.tier === 'projected');
  const kwSelfServe = confirmed.filter((r) => r.bucket === 'kw_selfserve');
  const unclear = confirmed.filter((r) => r.bucket === 'unclear');
  const known = confirmed.filter((r) => r.bucket !== 'unclear' && r.bucket !== 'kw_selfserve');

  const isSafe = (r: Row) => r.bucket !== 'risk';
  const nonMonthlySafe = known.filter((r) => r.cadence === 'non-monthly' && isSafe(r));
  const nonMonthlyRisk = known.filter((r) => r.cadence === 'non-monthly' && !isSafe(r));
  const monthlySafe = known.filter((r) => r.cadence === 'monthly' && isSafe(r));
  const monthlyRisk = known.filter((r) => r.cadence === 'monthly' && !isSafe(r));
  // A first charge, not any charge: confirmed rows on a still-trialing sub.
  const trials = confirmed.filter((r) => r.sub.status === 'trialing');

  const sum = (rs: Row[]) => rs.reduce((a, r) => a + r.sub.amountCents, 0);
  const nmsTotal = sum(nonMonthlySafe), nmrTotal = sum(nonMonthlyRisk);
  const msTotal = sum(monthlySafe), mrTotal = sum(monthlyRisk);
  const unclearTotal = sum(unclear), projectedTotal = sum(projected), kwTotal = sum(kwSelfServe);
  const confirmedTotal = sum(confirmed);
  const expectedTotal = confirmedTotal + projectedTotal;

  const pipeline = args.noPipeline ? [] : await fetchPipeline(startMs, endMs);

  // ---------- summary ----------

  console.log('\nSummary — Stripe-confirmed charges');
  console.log('  NON-MONTHLY (quarterly / 6-mo / yearly) — primary focus');
  console.log(`    Safe (renewing + trial→1st charge) : ${String(nonMonthlySafe.length).padStart(3)}   ${usd(nmsTotal)}`);
  console.log(`    At-risk                            : ${String(nonMonthlyRisk.length).padStart(3)}   ${usd(nmrTotal)}`);
  console.log('  MONTHLY');
  console.log(`    Safe                               : ${String(monthlySafe.length).padStart(3)}   ${usd(msTotal)}`);
  console.log(`    At-risk                            : ${String(monthlyRisk.length).padStart(3)}   ${usd(mrTotal)}`);
  console.log(`  KW SELF-SERVE (core Rejig, not LP)   : ${String(kwSelfServe.length).padStart(3)}   ${usd(kwTotal)}`);
  console.log(`  UNCLEAR (in Stripe, no LP match)     : ${String(unclear.length).padStart(3)}   ${usd(unclearTotal)}`);
  console.log('  ─────────────────────────────────────────────────────');
  console.log(`  CONFIRMED BY STRIPE                  : ${String(confirmed.length).padStart(3)}   ${usd(confirmedTotal)}`);
  console.log(`  + PROJECTED (cadence rolls into month): ${String(projected.length).padStart(3)}   ${usd(projectedTotal)}`);
  console.log(`  = TOTAL EXPECTED                     : ${String(confirmed.length + projected.length).padStart(3)}   ${usd(expectedTotal)}`);
  if (pipeline.length > 0) {
    console.log(`  (pipeline, not yet in Stripe         : ${String(pipeline.length).padStart(3)}   amount depends on plan picked)`);
  }
  console.log(`\n  of which trials converting to a first charge: ${trials.length}`);

  // ---------- detail ----------

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  NON-MONTHLY — CONFIRMED BY STRIPE (primary focus)');
  console.log('══════════════════════════════════════════════════════════');
  renderBucket('Safe — renewing + trial→1st charge', nonMonthlySafe, nmsTotal, productNames);
  renderBucket('At-risk', nonMonthlyRisk, nmrTotal, productNames);

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  MONTHLY — CONFIRMED BY STRIPE');
  console.log('══════════════════════════════════════════════════════════');
  renderBucket('Safe', monthlySafe, msTotal, productNames);
  renderBucket('At-risk', monthlyRisk, mrTotal, productNames);

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  KELLER WILLIAMS SELF-SERVE — core Rejig product line');
  console.log('  (bought in-product, never onboarded through LaunchPad,');
  console.log('   so no LP customer is expected — not data to chase)');
  console.log('══════════════════════════════════════════════════════════');
  renderBucket('KW self-serve', kwSelfServe, kwTotal, productNames);

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  UNCLEAR — billing in Stripe, no LaunchPad match');
  console.log('  (money is real; health signals unavailable — worth linking)');
  console.log('══════════════════════════════════════════════════════════');
  renderBucket('Unclear', unclear, unclearTotal, productNames);

  if (!args.noProjected) {
    console.log('\n══════════════════════════════════════════════════════════');
    console.log('  PROJECTED — Stripe\'s next-charge date precedes the window,');
    console.log('  but the subscription\'s own cadence bills again inside it.');
    console.log('  (Stripe only advances the period after a successful charge.)');
    console.log('══════════════════════════════════════════════════════════');
    renderBucket('Projected', projected, projectedTotal, productNames);
  }

  if (pipeline.length > 0) {
    console.log('\n══════════════════════════════════════════════════════════');
    console.log('  PIPELINE — card captured, no Stripe subscription yet');
    console.log('  First charge projected from scheduled onboarding call + trial.');
    console.log('  LP-derived; excluded from every total above.');
    console.log('══════════════════════════════════════════════════════════\n');
    for (const p of pipeline) {
      console.log(`  ~${isoDay(p.projectedFirstChargeMs)} | ${p.name} | ${p.workflowKey} | call ${isoDay(p.callDate.getTime())} + ${p.trialDays}d | plan: ${p.selectedPlanName ?? 'not recorded'} | ${p.contactEmail ?? '—'}`);
    }
  }

  const unresolvedAmounts = rows.filter((r) => r.sub.amountUnresolved);
  if (unresolvedAmounts.length > 0) {
    console.log(`\n⚠  ${unresolvedAmounts.length} sub(s) had no resolvable unit_amount (metered/tiered) — shown as "??" and counted as $0.`);
  }
  if (kwFallbackHits.size > 0) {
    console.log(`\n⚠  KW self-serve matched by plan name, not id — add to KW_SELF_SERVE_PRODUCT_IDS:\n   ${[...kwFallbackHits].join('\n   ')}`);
  }
  if (engagementAsOf) console.log(`\nEngagement signals as of ${engagementAsOf} (Rejig weekly pull).`);
  console.log('');

  // ---------- CSV ----------

  const ordered = [...nonMonthlySafe, ...nonMonthlyRisk, ...monthlySafe, ...monthlyRisk, ...kwSelfServe, ...unclear, ...projected];
  const csvBody = buildCsv(ordered, pipeline, productNames);
  const monthSlug = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`;
  const csvName = `renewals-${monthSlug}-${new Date().toISOString().slice(0, 10)}.csv`;

  if (args.csv) {
    const csvPath = resolve('scripts/data', csvName);
    writeFileSync(csvPath, csvBody);
    console.log(`CSV written: ${csvPath}`);
  }

  // ---------- email ----------

  if (args.email.length > 0) {
    const subject = args.subject
      ?? `Renewals digest — ${label} (confirmed $${(confirmedTotal / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })} · expected $${(expectedTotal / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })})`;
    const html = buildEmailHtml({
      label,
      windowStart: start.toISOString().slice(0, 10),
      windowEnd: end.toISOString().slice(0, 10),
      nonMonthlySafe, nonMonthlyRisk, monthlySafe, monthlyRisk, kwSelfServe, unclear, projected, pipeline,
      nmsTotal, nmrTotal, msTotal, mrTotal, kwTotal, unclearTotal, projectedTotal, confirmedTotal, expectedTotal,
      trialsCount: trials.length,
      workflowFilter: args.workflow,
      note: args.note,
      engagementAsOf,
      productNames,
    });
    await sendRenewalsEmail({ to: args.email, subject, html, attachment: { filename: csvName, content: csvBody } });
    console.log(`Email sent to: ${args.email.join(', ')} (CSV attached: ${csvName})`);
  }
}

// ---------- CSV ----------

function csvEsc(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_COLS = [
  'tier', 'bucket', 'cadence', 'chargeDate',
  'name', 'workflowKey', 'email',
  'planLabel', 'amountUsd', 'interval', 'intervalCount', 'seats',
  'stripeStatus', 'cancelAtPeriodEnd',
  'matchMethod', 'lpMatched', 'sharedByLpCustomers',
  'attentionReason', 'atRisk', 'atRiskReason', 'billingRelationship',
  'daysSinceLogin', 'lastLoginISO', 'totalPosts', 'daysSinceLastPost', 'neverPosted',
  'stripeSubscriptionId', 'stripeCustomerId', 'lpCustomerId',
] as const;

function buildCsv(rows: Row[], pipeline: PipelineRow[], productNames: Map<string, string>): string {
  const lines = [CSV_COLS.join(',')];
  for (const r of rows) {
    const e = r.lp?.engagement;
    const row: Record<typeof CSV_COLS[number], unknown> = {
      tier: r.tier,
      bucket: r.bucket,
      cadence: r.cadence,
      chargeDate: isoDay(r.chargeMs),
      name: displayName(r),
      workflowKey: r.lp?.workflowKey ?? '',
      email: r.lp?.contactEmail ?? r.stripeEmail ?? '',
      planLabel: formatPlan(r.sub, productNames),
      amountUsd: (r.sub.amountCents / 100).toFixed(2),
      interval: r.sub.interval,
      intervalCount: r.sub.intervalCount,
      seats: r.sub.quantity,
      stripeStatus: r.sub.status,
      cancelAtPeriodEnd: r.sub.cancelAtPeriodEnd,
      matchMethod: r.matchMethod ?? 'NONE',
      lpMatched: r.lp ? 'yes' : 'no',
      sharedByLpCustomers: r.lpGroup.length,
      attentionReason: r.lp?.attentionReason ?? '',
      atRisk: r.lp?.atRisk ?? '',
      atRiskReason: r.lp?.atRiskReason ?? '',
      billingRelationship: r.lp?.billingRelationship ?? '',
      daysSinceLogin: e?.daysSinceLogin ?? '',
      lastLoginISO: e?.loginIso ?? '',
      totalPosts: e?.totalPosts ?? '',
      daysSinceLastPost: e?.daysSinceLastPost ?? '',
      neverPosted: e?.neverPosted ?? '',
      stripeSubscriptionId: r.sub.subId,
      stripeCustomerId: r.sub.stripeCustomerId ?? '',
      lpCustomerId: r.lp?.customerId ?? '',
    };
    lines.push(CSV_COLS.map((c) => csvEsc(row[c])).join(','));
  }
  // Pipeline rows ride in the same CSV so nothing is invisible to a spreadsheet.
  for (const p of pipeline) {
    const row: Partial<Record<typeof CSV_COLS[number], unknown>> = {
      tier: 'pipeline', bucket: 'pipeline', cadence: '', chargeDate: isoDay(p.projectedFirstChargeMs),
      name: p.name, workflowKey: p.workflowKey ?? '', email: p.contactEmail ?? '',
      planLabel: p.selectedPlanName ?? 'not recorded', amountUsd: '',
      matchMethod: 'lp_only', lpMatched: 'yes', lpCustomerId: p.customerId,
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
  nonMonthlySafe: Row[]; nonMonthlyRisk: Row[];
  monthlySafe: Row[]; monthlyRisk: Row[];
  kwSelfServe: Row[]; unclear: Row[]; projected: Row[];
  pipeline: PipelineRow[];
  nmsTotal: number; nmrTotal: number; msTotal: number; mrTotal: number;
  kwTotal: number; unclearTotal: number; projectedTotal: number; confirmedTotal: number; expectedTotal: number;
  trialsCount: number;
  workflowFilter: string | null;
  note?: string | null;
  engagementAsOf: string | null;
  productNames: Map<string, string>;
}): string {
  const {
    label, windowStart, windowEnd,
    nonMonthlySafe, nonMonthlyRisk, monthlySafe, monthlyRisk, kwSelfServe, unclear, projected, pipeline,
    nmsTotal, nmrTotal, msTotal, mrTotal, kwTotal, unclearTotal, projectedTotal, confirmedTotal, expectedTotal,
    trialsCount, workflowFilter, note, engagementAsOf, productNames,
  } = opts;

  const fmt = (c: number) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const td = 'padding:6px 10px;border-bottom:1px solid #eee;font-size:13px;vertical-align:top;';
  const tdRisk = `${td}background:#fff5f5;color:#a00;`;
  const tdCancel = `${td}background:#fff8e6;`;
  const tdUnclear = `${td}background:#fffbe6;`;
  const th = 'padding:6px 10px;border-bottom:2px solid #444;background:#f6f6f6;font-size:13px;text-align:left;';
  const tdGroup = `${td}background:#eef3ff;font-weight:600;`;
  const tdSub = `${td}background:#f6f6f6;font-weight:600;border-top:1px solid #ccc;`;

  const confirmedCount = nonMonthlySafe.length + nonMonthlyRisk.length + monthlySafe.length + monthlyRisk.length + kwSelfServe.length + unclear.length;

  const summaryTable = `
    <table style="border-collapse:collapse;margin:0 0 24px 0;">
      <tr><th style="${th}">Bucket</th><th style="${th};text-align:right;">Count</th><th style="${th};text-align:right;">Subtotal</th></tr>
      <tr><td colspan="3" style="${tdGroup}">NON-MONTHLY (quarterly / 6-mo / yearly) — primary focus</td></tr>
      <tr><td style="${td}">&nbsp;&nbsp;Safe (renewing + trial→1st charge)</td><td style="${td};text-align:right;">${nonMonthlySafe.length}</td><td style="${td};text-align:right;">${fmt(nmsTotal)}</td></tr>
      <tr><td style="${td}">&nbsp;&nbsp;At-risk</td><td style="${td};text-align:right;">${nonMonthlyRisk.length}</td><td style="${td};text-align:right;">${fmt(nmrTotal)}</td></tr>
      <tr><td colspan="3" style="${tdGroup}">MONTHLY</td></tr>
      <tr><td style="${td}">&nbsp;&nbsp;Safe</td><td style="${td};text-align:right;">${monthlySafe.length}</td><td style="${td};text-align:right;">${fmt(msTotal)}</td></tr>
      <tr><td style="${td}">&nbsp;&nbsp;At-risk</td><td style="${td};text-align:right;">${monthlyRisk.length}</td><td style="${td};text-align:right;">${fmt(mrTotal)}</td></tr>
      <tr><td colspan="3" style="${tdGroup}">KELLER WILLIAMS SELF-SERVE — core Rejig, not a LaunchPad cohort</td></tr>
      <tr><td style="${td}">&nbsp;&nbsp;KW self-serve</td><td style="${td};text-align:right;">${kwSelfServe.length}</td><td style="${td};text-align:right;">${fmt(kwTotal)}</td></tr>
      <tr><td colspan="3" style="${tdGroup}">UNCLEAR — billing in Stripe, no LaunchPad match</td></tr>
      <tr><td style="${td}">&nbsp;&nbsp;Unclear</td><td style="${td};text-align:right;">${unclear.length}</td><td style="${td};text-align:right;">${fmt(unclearTotal)}</td></tr>
      <tr><td style="${tdSub}">CONFIRMED BY STRIPE</td><td style="${tdSub};text-align:right;">${confirmedCount}</td><td style="${tdSub};text-align:right;">${fmt(confirmedTotal)}</td></tr>
      <tr><td style="${td}">+ Projected (cadence rolls into month)</td><td style="${td};text-align:right;">${projected.length}</td><td style="${td};text-align:right;">${fmt(projectedTotal)}</td></tr>
      <tr><td style="${td};font-weight:700;border-top:2px solid #444;">= TOTAL EXPECTED</td><td style="${td};text-align:right;font-weight:700;border-top:2px solid #444;">${confirmedCount + projected.length}</td><td style="${td};text-align:right;font-weight:700;border-top:2px solid #444;">${fmt(expectedTotal)}</td></tr>
    </table>
    <div style="font-size:12px;color:#555;margin:-14px 0 22px 0;">Of these, <strong>${trialsCount}</strong> ${trialsCount === 1 ? 'is a trial converting' : 'are trials converting'} to a first charge.${pipeline.length > 0 ? ` A further <strong>${pipeline.length}</strong> ${pipeline.length === 1 ? 'agent has' : 'agents have'} a card on file but no Stripe subscription yet — listed at the bottom, excluded from all totals.` : ''}</div>
  `;

  const tdKw = `${td}background:#f4f1fb;`;
  const renderTable = (rows: Row[]) => {
    if (rows.length === 0) return '<div style="font-size:13px;color:#888;margin:0 0 20px 0;">(none)</div>';
    const headers = ['Charges', 'Customer', 'Workflow', 'Plan', 'Flags', 'Engagement', 'Email'];
    const rowsHtml = rows.map((r) => {
      const cell = r.bucket === 'risk' ? tdRisk
        : r.bucket === 'unclear' ? tdUnclear
        : r.bucket === 'kw_selfserve' ? tdKw
        : r.sub.cancelAtPeriodEnd ? tdCancel : td;
      return `<tr>
        <td style="${cell}">${escHtml(isoDay(r.chargeMs))}</td>
        <td style="${cell}">${escHtml(displayName(r))}</td>
        <td style="${cell}">${escHtml(r.lp?.workflowKey ?? '—')}</td>
        <td style="${cell}">${escHtml(formatPlan(r.sub, productNames))}</td>
        <td style="${cell}">${escHtml(flagsFor(r).join(' · ') || '—')}</td>
        <td style="${cell}">${escHtml(formatEngagement(r.lp))}</td>
        <td style="${cell}">${escHtml(r.lp?.contactEmail ?? r.stripeEmail ?? '—')}</td>
      </tr>`;
    }).join('');
    return `<table style="border-collapse:collapse;margin:0 0 24px 0;width:100%;">
      <tr>${headers.map((h) => `<th style="${th}">${h}</th>`).join('')}</tr>
      ${rowsHtml}
    </table>`;
  };

  const pipelineTable = pipeline.length === 0 ? '' : `
    <h2 style="margin:28px 0 4px 0;font-size:17px;border-bottom:2px solid #444;padding-bottom:4px;">Pipeline — card captured, no Stripe subscription yet (${pipeline.length})</h2>
    <div style="font-size:12px;color:#666;margin:0 0 10px 0;">The trial subscription is created when the HubSpot ticket reaches Active, after the onboarding call. First charge below is projected from the scheduled call date plus the workflow's trial length — LaunchPad-derived, not in Stripe, and excluded from every total above.</div>
    <table style="border-collapse:collapse;margin:0 0 24px 0;width:100%;">
      <tr>${['~First charge', 'Customer', 'Workflow', 'Onboarding call', 'Plan picked', 'Email'].map((h) => `<th style="${th}">${h}</th>`).join('')}</tr>
      ${pipeline.map((p) => `<tr>
        <td style="${td}">~${escHtml(isoDay(p.projectedFirstChargeMs))}</td>
        <td style="${td}">${escHtml(p.name)}</td>
        <td style="${td}">${escHtml(p.workflowKey)}</td>
        <td style="${td}">${escHtml(isoDay(p.callDate.getTime()))} + ${p.trialDays}d</td>
        <td style="${td}">${escHtml(p.selectedPlanName ?? 'not recorded')}</td>
        <td style="${td}">${escHtml(p.contactEmail ?? '—')}</td>
      </tr>`).join('')}
    </table>`;

  const noteBanner = note ? `
    <div style="background:#fdecea;border:1px solid #e0928a;border-left:4px solid #c0392b;padding:12px 14px;margin:0 0 18px 0;font-size:13px;color:#7f1d1d;line-height:1.5;">
      ${escHtml(note)}
    </div>` : '';

  const filterNote = workflowFilter ? ` (filtered to ${escHtml(workflowFilter)})` : '';

  const methodBanner = `
    <div style="background:#eef7ee;border:1px solid #a8cfa8;padding:10px 14px;margin:0 0 18px 0;font-size:12px;color:#2c5f2c;line-height:1.5;">
      <strong>Source of truth: live Stripe.</strong> Rows come from Stripe subscriptions and their real next-charge dates and prices. LaunchPad is used only to attach health signals (engagement, at-risk flags) — a subscription LaunchPad can't match still appears, under <em>Unclear</em>, with its money counted.${workflowFilter ? ' Note that a workflow filter can only apply to LaunchPad-matched rows, so Unclear rows are suppressed in this view.' : ''}
      ${engagementAsOf ? `<br>Engagement signals reflect the Rejig pull of ${escHtml(engagementAsOf)}; dates and dollars are live.` : ''}
      <br>Brokerages billed outside Stripe (Baird &amp; Warner's master agreement, Ruhl's pilot, Coach's invoicing) have no subscription object and so are absent by nature, not by exclusion.
    </div>`;

  return `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111;background:#fff;padding:24px;max-width:1200px;margin:0 auto;">
  <h2 style="margin:0 0 6px 0;font-size:18px;">Renewals digest — ${escHtml(label)}${filterNote}</h2>
  <div style="font-size:12px;color:#666;margin:0 0 18px 0;">Charges landing ${escHtml(windowStart)} → ${escHtml(windowEnd)}. Cancelled subscriptions excluded.</div>
  ${noteBanner}
  ${methodBanner}
  <h3 style="margin:0 0 8px 0;font-size:14px;">Summary</h3>
  ${summaryTable}

  <h2 style="margin:28px 0 4px 0;font-size:17px;border-bottom:2px solid #444;padding-bottom:4px;">Non-monthly — confirmed by Stripe</h2>
  <h3 style="margin:14px 0 8px 0;font-size:14px;">Safe — renewing + trial→1st charge (${nonMonthlySafe.length}) — ${fmt(nmsTotal)}</h3>
  ${renderTable(nonMonthlySafe)}
  <h3 style="margin:14px 0 8px 0;font-size:14px;">At-risk (${nonMonthlyRisk.length}) — ${fmt(nmrTotal)}</h3>
  ${renderTable(nonMonthlyRisk)}

  <h2 style="margin:28px 0 4px 0;font-size:17px;border-bottom:2px solid #444;padding-bottom:4px;">Monthly — confirmed by Stripe</h2>
  <h3 style="margin:14px 0 8px 0;font-size:14px;">Safe (${monthlySafe.length}) — ${fmt(msTotal)}</h3>
  ${renderTable(monthlySafe)}
  <h3 style="margin:14px 0 8px 0;font-size:14px;">At-risk (${monthlyRisk.length}) — ${fmt(mrTotal)}</h3>
  ${renderTable(monthlyRisk)}

  <h2 style="margin:28px 0 4px 0;font-size:17px;border-bottom:2px solid #444;padding-bottom:4px;">Keller Williams self-serve (${kwSelfServe.length}) — ${fmt(kwTotal)}</h2>
  <div style="font-size:12px;color:#666;margin:0 0 10px 0;">Core Rejig's own $20 / $50 / $90 KW tiers. These agents buy inside the product and never go through LaunchPad onboarding, so having no LaunchPad customer is expected — this is revenue, not a data gap to chase.</div>
  ${renderTable(kwSelfServe)}

  <h2 style="margin:28px 0 4px 0;font-size:17px;border-bottom:2px solid #444;padding-bottom:4px;">Unclear — billing in Stripe, no LaunchPad match (${unclear.length}) — ${fmt(unclearTotal)}</h2>
  <div style="font-size:12px;color:#666;margin:0 0 10px 0;">The money is real. Only the health signals are missing, because these subscriptions can't be tied to a LaunchPad customer by subscription id, Stripe customer id, email, or normalised name. Each one is worth linking. Note that two rows sharing a billing email are not assumed to be the same person — separate subscriptions stay separate, and a shared Stripe customer is flagged rather than merged.</div>
  ${renderTable(unclear)}

  <h2 style="margin:28px 0 4px 0;font-size:17px;border-bottom:2px solid #444;padding-bottom:4px;">Projected — cadence rolls into the month (${projected.length}) — ${fmt(projectedTotal)}</h2>
  <div style="font-size:12px;color:#666;margin:0 0 10px 0;">Stripe only advances a subscription's period after a successful charge, so a monthly plan billing on the 26th still shows last month's date. These rows are derived from each subscription's own cadence rather than read directly from Stripe — treat them as expected, not confirmed.</div>
  ${renderTable(projected)}

  ${pipelineTable}

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
      ? [{ filename: opts.attachment.filename, content: Buffer.from(opts.attachment.content, 'utf8').toString('base64') }]
      : undefined,
  });
  if (result.error) throw new Error(`Resend error: ${result.error.message}`);
  return result.data;
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
