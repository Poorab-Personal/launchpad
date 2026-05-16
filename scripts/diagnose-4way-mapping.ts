/**
 * 4-way mapping diagnostic — Rejig × HubSpot Contact × HubSpot CJ Ticket × Stripe × LaunchPad.
 *
 * Read-only. Produces an audit CSV at scripts/data/backfill-audit-{date}.csv
 * with one row per Rejig account, fully annotated with proposed backfill
 * actions and human-review flags.
 *
 * Spec: docs/plans/rejig-hs-stripe-backfill-plan.md §4-§8.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/diagnose-4way-mapping.ts
 *   npx tsx --env-file=.env.local scripts/diagnose-4way-mapping.ts --limit=50
 *
 * Required env: REJIG_API_KEY, HUBSPOT_STATIC_TOKEN, STRIPE_LIVE_SECRET_KEY,
 *               POSTGRES_URL_NON_POOLING.
 *
 * Total runtime ~5-7 minutes for 694 rows (rate-limited).
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { Client as HsClient } from '@hubspot/api-client';
import Stripe from 'stripe';
import { sql } from 'drizzle-orm';
import { db } from '@/db';
import { fetchAccountsSnapshot, type RejigAccount } from '@/lib/integrations/rejig/client';

// ─── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const limitArg = args.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;
const TODAY = new Date().toISOString().slice(0, 10); // 2026-05-15
const OUT_PATH = `scripts/data/backfill-audit-${TODAY}.csv`;

// ─── Constants ──────────────────────────────────────────────────────────────
const KEYES_COMPANY_ID = '53893652348';
const BW_COMPANY_ID = '51123896468';
const CJ_PIPELINE_ID = '0';

const PUBLIC_WEBMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'outlook.com', 'aol.com', 'hotmail.com',
  'icloud.com', 'me.com', 'comcast.net', 'att.net', 'verizon.net',
]);

// CSV column order — matches plan §5 + §18
const CSV_COLUMNS = [
  'rejig_user_id',
  'rejig_email',
  'rejig_account_name',
  'rejig_business_name',
  'rejig_domain_url',
  'rejig_plan_key',
  'rejig_subscription_status',
  'rejig_stripe_sub_id',
  'rejig_last_login',
  'rejig_plan_expiry_date',
  'rejig_post_count_total',
  'rejig_account_created_at',          // NEW (§18) — derived from Mongo _id
  'email_match_mode',
  'hs_contact_id',
  'hs_contact_company_ids',
  'hs_contact_company_match',
  'hs_ticket_id',
  'hs_ticket_current_stage_label',
  'hs_ticket_current_stage_id',
  'stripe_lookup_status',
  'stripe_customer_id',
  'stripe_customer_email',
  'stripe_sub_status',
  'stripe_current_period_start',       // NEW (§18) — Stripe sub.current_period_start
  'stripe_current_period_end',         // NEW (§18) — Stripe sub.current_period_end
  'stripe_metadata_existing_keys',
  'lp_customer_id',
  'lp_customer_id_existing',
  'proposed_workflow_key',
  'proposed_channel_code',
  'proposed_customer_type',
  'proposed_brokerage_id',
  'proposed_hubspot_company_id',
  'proposed_onboarding_state',
  'proposed_ticket_target_stage',
  'proposed_ticket_action',
  'proposed_subscription_status',
  'proposed_current_period_start',     // NEW (§18) — per-cohort computed
  'proposed_current_period_end',       // NEW (§18) — per-cohort computed
  'proposed_current_period_start_source', // NEW (§18) — stripe | mongo_id | rejig_expiry | unparseable
  'proposed_payment_source',           // NEW (§18) — stripe | invoice | (empty for NULL)
  'channel_detection_evidence',
  'channel_detection_score',
  'needs_review',
  'needs_review_reasons',
  'notes',
] as const;
type CsvColumn = typeof CSV_COLUMNS[number];

// ─── Types ──────────────────────────────────────────────────────────────────
type LpCustomerRow = {
  id: string;
  contactEmail: string | null;
  hubspotContactId: string | null;
  hubspotTicketId: string | null;
  rejigUserId: string | null; // schema column is currently rejig_account_id; we accept either
};

type HsContactRow = { id: string; email: string };
type HsTicketRow = {
  id: string;
  pipeline: string;
  stageId: string;
  stageLabel: string;
  contactIds: string[];
};

type ChannelDecision = {
  channel: 'Standard' | 'Keyes' | 'BW';
  evidence: string;
  score: number;
  signals: Record<1 | 2 | 3 | 4 | 5 | 6, 'keyes' | 'bw' | 'other' | 'standard' | 'public_webmail' | 'none'>;
};

type AuditRow = Record<CsvColumn, string>;

// ─── Helpers ────────────────────────────────────────────────────────────────
function normEmail(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

function csvEscape(v: string | number | null | undefined): string {
  const s = v === null || v === undefined ? '' : String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function writeCsv(path: string, rows: AuditRow[]): void {
  const header = CSV_COLUMNS.join(',');
  const body = rows
    .map((r) => CSV_COLUMNS.map((c) => csvEscape(r[c])).join(','))
    .join('\n');
  mkdirSync('scripts/data', { recursive: true });
  writeFileSync(path, header + '\n' + body + '\n', 'utf8');
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Mongo _id timestamp parser (§18 Round 1) ───────────────────────────────
// First 4 bytes of an ObjectId encode Unix epoch seconds. Defensive parsing
// with length + charset + sanity-range checks per architect spec.
const MONGO_ID_MIN_DATE = Date.UTC(2020, 0, 1);   // Rejig founding floor
const MONGO_ID_MAX_DATE_OFFSET_MS = 86_400_000;   // today + 1 day max

function parseMongoIdTimestamp(id: string): Date | null {
  if (typeof id !== 'string' || id.length !== 24) return null;
  if (!/^[0-9a-f]{24}$/i.test(id)) return null;
  const seconds = parseInt(id.substring(0, 8), 16);
  if (!Number.isFinite(seconds)) return null;
  const ms = seconds * 1000;
  if (ms < MONGO_ID_MIN_DATE) return null;
  if (ms > Date.now() + MONGO_ID_MAX_DATE_OFFSET_MS) return null;
  return new Date(ms);
}

// ─── addMonths with last-day clamping (matches Stripe billing semantics) ────
// e.g. Aug 31 + 6 months → Feb 28 (or Feb 29 in leap year)
function addMonthsClamped(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const targetMonth = month + months;
  const targetYear = year + Math.floor(targetMonth / 12);
  const wrappedMonth = ((targetMonth % 12) + 12) % 12;
  // Days in target month
  const daysInTarget = new Date(Date.UTC(targetYear, wrappedMonth + 1, 0)).getUTCDate();
  const targetDay = Math.min(day, daysInTarget);
  return new Date(Date.UTC(
    targetYear, wrappedMonth, targetDay,
    date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds(),
  ));
}

// ─── Phase loaders ──────────────────────────────────────────────────────────
async function loadLpCustomers(): Promise<LpCustomerRow[]> {
  const r = await db.execute(sql`
    SELECT id, contact_email, hubspot_contact_id, hubspot_ticket_id, rejig_user_id
    FROM customers
  `);
  const rows = (Array.isArray(r) ? r : (r as { rows: unknown[] }).rows) as Array<{
    id: string;
    contact_email: string | null;
    hubspot_contact_id: string | null;
    hubspot_ticket_id: string | null;
    rejig_user_id: string | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    contactEmail: row.contact_email,
    hubspotContactId: row.hubspot_contact_id,
    hubspotTicketId: row.hubspot_ticket_id,
    rejigUserId: row.rejig_user_id,
  }));
}

async function loadBrokerages(): Promise<{
  keyesId: string | null;
  bwId: string | null;
}> {
  const r = await db.execute(sql`
    SELECT id, name FROM brokerages WHERE name ILIKE 'Keyes%' OR name ILIKE 'Baird%'
  `);
  const rows = (Array.isArray(r) ? r : (r as { rows: unknown[] }).rows) as Array<{ id: string; name: string }>;
  let keyesId: string | null = null;
  let bwId: string | null = null;
  for (const row of rows) {
    if (/keyes/i.test(row.name)) keyesId = row.id;
    if (/baird/i.test(row.name)) bwId = row.id;
  }
  return { keyesId, bwId };
}

async function searchHsContactsByEmails(
  hs: HsClient,
  emails: string[],
): Promise<Map<string, HsContactRow>> {
  // Return: lowercased email → contact row (only first match per email).
  const out = new Map<string, HsContactRow>();
  for (let i = 0; i < emails.length; i += 100) {
    const batch = emails.slice(i, i + 100);
    try {
      const res = await hs.crm.contacts.searchApi.doSearch({
        filterGroups: [
          {
            filters: [
              { propertyName: 'email', operator: 'IN' as never, values: batch } as never,
            ],
          },
        ],
        properties: ['email'],
        limit: 100,
        sorts: [],
        after: undefined as unknown as string,
      });
      for (const r of res.results) {
        const e = normEmail(r.properties?.email);
        if (e && !out.has(e)) {
          out.set(e, { id: r.id, email: r.properties?.email ?? '' });
        }
      }
    } catch (err) {
      console.warn(`[diag] HS contact-search batch ${i / 100} failed:`, err instanceof Error ? err.message : err);
    }
    process.stdout.write(`\r[diag] HS contact lookups: ${Math.min(i + 100, emails.length)} / ${emails.length}`);
    await sleep(150);
  }
  process.stdout.write('\n');
  return out;
}

async function fetchContactCompanyAssociations(
  hs: HsClient,
  contactIds: string[],
): Promise<Map<string, string[]>> {
  // Per HubSpot v4 batch associations API.
  const out = new Map<string, string[]>();
  for (let i = 0; i < contactIds.length; i += 100) {
    const batch = contactIds.slice(i, i + 100);
    try {
      const res = await hs.crm.associations.v4.batchApi.getPage(
        'contacts',
        'companies',
        { inputs: batch.map((id) => ({ id })) },
      );
      for (const row of res.results) {
        const cid = row._from?.id ?? '';
        const companyIds = (row.to ?? []).map((t) => String(t.toObjectId));
        if (cid) out.set(cid, companyIds);
      }
    } catch (err) {
      console.warn(`[diag] HS associations batch ${i / 100} failed:`, err instanceof Error ? err.message : err);
    }
    process.stdout.write(`\r[diag] HS company associations: ${Math.min(i + 100, contactIds.length)} / ${contactIds.length}`);
    await sleep(150);
  }
  process.stdout.write('\n');
  return out;
}

async function fetchContactTicketAssociations(
  hs: HsClient,
  contactIds: string[],
): Promise<Map<string, string[]>> {
  // Per HubSpot v4 batch associations API: contacts → tickets.
  const out = new Map<string, string[]>();
  for (let i = 0; i < contactIds.length; i += 100) {
    const batch = contactIds.slice(i, i + 100);
    try {
      const res = await hs.crm.associations.v4.batchApi.getPage(
        'contacts',
        'tickets',
        { inputs: batch.map((id) => ({ id })) },
      );
      for (const row of res.results) {
        const cid = row._from?.id ?? '';
        const ticketIds = (row.to ?? []).map((t) => String(t.toObjectId));
        if (cid) out.set(cid, ticketIds);
      }
    } catch (err) {
      console.warn(`[diag] HS ticket-assoc batch ${i / 100} failed:`, err instanceof Error ? err.message : err);
    }
    process.stdout.write(`\r[diag] HS ticket associations: ${Math.min(i + 100, contactIds.length)} / ${contactIds.length}`);
    await sleep(150);
  }
  process.stdout.write('\n');
  return out;
}

async function fetchTicketsByIds(
  hs: HsClient,
  ticketIds: string[],
  // pipeline cache: stage_id → stage_label
  stageCache: Map<string, string>,
): Promise<Map<string, HsTicketRow>> {
  const out = new Map<string, HsTicketRow>();
  for (let i = 0; i < ticketIds.length; i += 100) {
    const batch = ticketIds.slice(i, i + 100);
    try {
      const res = await hs.crm.tickets.batchApi.read({
        inputs: batch.map((id) => ({ id })),
        properties: ['subject', 'hs_pipeline', 'hs_pipeline_stage'],
        propertiesWithHistory: [],
      });
      for (const t of res.results) {
        const stageId = t.properties?.hs_pipeline_stage ?? '';
        out.set(t.id, {
          id: t.id,
          pipeline: t.properties?.hs_pipeline ?? '',
          stageId,
          stageLabel: stageCache.get(stageId) ?? '',
          contactIds: [],
        });
      }
    } catch (err) {
      console.warn(`[diag] HS ticket batch-read ${i / 100} failed:`, err instanceof Error ? err.message : err);
    }
    process.stdout.write(`\r[diag] HS ticket fetch: ${Math.min(i + 100, ticketIds.length)} / ${ticketIds.length}`);
    await sleep(150);
  }
  process.stdout.write('\n');
  return out;
}

async function buildStageCache(hs: HsClient): Promise<Map<string, string>> {
  const cache = new Map<string, string>();
  const pipeline = await hs.crm.pipelines.pipelinesApi.getById('tickets', CJ_PIPELINE_ID);
  for (const stage of pipeline.stages) {
    cache.set(stage.id, stage.label);
  }
  return cache;
}

async function lookupStripeForRejig(
  stripe: Stripe,
  subId: string,
): Promise<{
  status: 'ok' | 'not_found' | 'auth_error';
  customerId?: string;
  customerEmail?: string;
  subStatus?: string;
  currentPeriodStart?: Date | null;   // §18
  currentPeriodEnd?: Date | null;     // §18
  metadataKeys?: string[];
}> {
  try {
    const sub = await stripe.subscriptions.retrieve(subId, { expand: ['customer'] });
    const cus = sub.customer;
    const cusId = typeof cus === 'string' ? cus : (cus as Stripe.Customer)?.id ?? '';
    const cusEmail =
      typeof cus === 'string' ? '' : ((cus as Stripe.Customer)?.email ?? '');
    const subMdKeys = Object.keys(sub.metadata ?? {});
    const cusMdKeys = typeof cus === 'string' ? [] : Object.keys((cus as Stripe.Customer)?.metadata ?? {});
    // Stripe API v2024-04-10+: current_period_* moved from subscription → subscription.items.data[0]
    // Fall back to top-level if older API surface (some accounts may still serve those)
    const subAny = sub as unknown as {
      current_period_start?: number;
      current_period_end?: number;
      items?: { data?: Array<{ current_period_start?: number; current_period_end?: number }> };
    };
    const firstItem = subAny.items?.data?.[0];
    const cpsSec = firstItem?.current_period_start ?? subAny.current_period_start;
    const cpeSec = firstItem?.current_period_end ?? subAny.current_period_end;
    const cps = cpsSec ? new Date(cpsSec * 1000) : null;
    const cpe = cpeSec ? new Date(cpeSec * 1000) : null;
    return {
      status: 'ok',
      customerId: cusId,
      customerEmail: cusEmail,
      subStatus: sub.status,
      currentPeriodStart: cps,
      currentPeriodEnd: cpe,
      metadataKeys: Array.from(new Set([...subMdKeys, ...cusMdKeys])),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('No such subscription')) return { status: 'not_found' };
    if (msg.includes('Invalid API Key') || msg.includes('authentication')) {
      return { status: 'auth_error' };
    }
    console.warn(`[diag] Stripe sub ${subId} lookup error: ${msg}`);
    return { status: 'not_found' };
  }
}

// ─── Channel detection ──────────────────────────────────────────────────────
// B&W brokerage master-agreement sentinel expiry date (extracted from data).
// Rejig sets every B&W direct-invoice agent's plan_expiry_date to 2027-12-31.
// Strong (but heuristic) signal for B&W classification when other signals miss.
const BW_SENTINEL_EXPIRY_PREFIX = '2027-12-31';

function detectChannel(
  acct: RejigAccount,
  hsCompanyMatch: 'keyes' | 'bw' | 'other' | 'none',
): ChannelDecision {
  const signals: ChannelDecision['signals'] = {
    1: 'none', 2: 'none', 3: 'none', 4: 'none', 5: 'none', 6: 'none',
  };

  // Signal 1: HS Company association
  if (hsCompanyMatch === 'keyes') signals[1] = 'keyes';
  else if (hsCompanyMatch === 'bw') signals[1] = 'bw';
  else if (hsCompanyMatch === 'other') signals[1] = 'other';

  // Signal 2: email domain
  const email = normEmail(acct.email);
  const atIdx = email.lastIndexOf('@');
  const domain = atIdx >= 0 ? email.slice(atIdx + 1) : '';
  if (domain === 'keyes.com') signals[2] = 'keyes';
  else if (domain === 'bairdwarner.com') signals[2] = 'bw';
  else if (PUBLIC_WEBMAIL_DOMAINS.has(domain)) signals[2] = 'public_webmail';
  else if (domain.length > 0) signals[2] = 'other';

  // Signal 3: Rejig domain_url
  const url = (acct.domain_url ?? '').toLowerCase();
  if (url.includes('keyes.com')) signals[3] = 'keyes';
  else if (url.includes('bairdwarner.com')) signals[3] = 'bw';

  // Signal 4: Rejig plan_key
  const pk = (acct.plan_key ?? '').toLowerCase();
  if (pk.includes('keyes')) signals[4] = 'keyes';
  else if (pk.includes('baird') || pk.includes('bairdwarner') || pk.startsWith('bw_')) signals[4] = 'bw';
  else if (/standard|d2c|monthly|annual/.test(pk)) signals[4] = 'standard';

  // Signal 5: Rejig business_name contains brokerage
  const biz = (acct.business_name ?? acct.display_business_name ?? '').toLowerCase();
  if (biz.includes('keyes')) signals[5] = 'keyes';
  else if (biz.includes('baird & warner') || biz.includes('baird warner') || biz.includes('bairdwarner')) signals[5] = 'bw';

  // Signal 6: B&W master-agreement sentinel expiry date
  if ((acct.plan_expiry_date ?? '').startsWith(BW_SENTINEL_EXPIRY_PREFIX)) signals[6] = 'bw';

  // Cascade order:
  //   Pass 1: scan all 6 signals; any B2B vote (keyes or bw) wins. First B2B
  //           signal in 1→6 order takes the channel; later signals only boost
  //           the score.
  //   Pass 2: if no B2B vote, check signal 4 for explicit 'standard' → use it.
  //   Pass 3: otherwise fall through to Standard with 'default:none' evidence.
  //
  // Why B2B always wins: signal 4 = plan_key matches `standard|d2c|monthly|annual`
  // is a heuristic — many B&W agents have generic `standard_*` plan_keys. If
  // business_name says "Baird & Warner" or plan_expiry is the B&W sentinel,
  // that's stronger evidence than the plan_key heuristic.
  let channel: ChannelDecision['channel'] = 'Standard';
  let evidence = 'default:none';

  for (const s of [1, 2, 3, 4, 5, 6] as const) {
    const v = signals[s];
    if (v === 'keyes' || v === 'bw') {
      channel = v === 'keyes' ? 'Keyes' : 'BW';
      evidence = `signal_${s}:${v}`;
      break;
    }
  }

  if (channel === 'Standard' && signals[4] === 'standard') {
    evidence = `signal_4:standard`;
  }

  // Score: count signals that agree with the chosen channel
  let score = 0;
  const chosenLower = channel === 'Keyes' ? 'keyes' : channel === 'BW' ? 'bw' : 'standard';
  for (const s of [1, 2, 3, 4, 5, 6] as const) {
    if (signals[s] === chosenLower) score++;
  }

  return { channel, evidence, score, signals };
}

// ─── Per-cohort decision ────────────────────────────────────────────────────
type CohortDecision = {
  onboardingState: 'Active' | 'Churned';
  ticketTargetStage: 'Active' | 'Churned';
  ticketAction: 'create_new' | 'move_stage' | 'noop';
  subscriptionStatus: 'Active' | 'Trial' | 'Past Due' | 'Cancelled' | '';
};

function decideCohort(args: {
  rejigStatus: string;
  stripeSubStatus: string | undefined;
  hsTicketStageLabel: string;
  hasTicket: boolean;
}): CohortDecision {
  const { rejigStatus, stripeSubStatus, hsTicketStageLabel, hasTicket } = args;

  // Onboarding state
  const isChurned = rejigStatus === 'canceled' || rejigStatus === 'deactivated';
  const onboardingState: 'Active' | 'Churned' = isChurned ? 'Churned' : 'Active';
  const ticketTargetStage = onboardingState;

  // Subscription status — Stripe authoritative if available, fall through to
  // Rejig status when no Stripe sub (B&W). Use || not ?? because stripeSubStatus
  // is '' (empty string) for non-Stripe customers, not null/undefined.
  let subscriptionStatus: CohortDecision['subscriptionStatus'] = '';
  const ss = (stripeSubStatus || rejigStatus || '').toLowerCase();
  if (ss === 'active') subscriptionStatus = 'Active';
  else if (ss === 'trialing') subscriptionStatus = 'Trial';
  else if (ss === 'past_due' || ss === 'unpaid') subscriptionStatus = 'Past Due';
  else if (ss === 'canceled' || ss === 'incomplete' || ss === 'incomplete_expired' || ss === 'paused' || ss === 'deactivated') {
    subscriptionStatus = 'Cancelled';
  }

  // Ticket action
  let ticketAction: CohortDecision['ticketAction'];
  if (!hasTicket) ticketAction = 'create_new';
  else if (hsTicketStageLabel === ticketTargetStage) ticketAction = 'noop';
  else ticketAction = 'move_stage';

  return { onboardingState, ticketTargetStage, ticketAction, subscriptionStatus };
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`[diag] Starting 4-way mapping diagnostic. Date stamp: ${TODAY}`);
  console.log(`[diag] Output: ${OUT_PATH}`);
  console.log(`[diag] Limit: ${LIMIT === Infinity ? 'unlimited' : LIMIT}\n`);

  // Step 1: Rejig snapshot
  console.log('[diag] Fetching Rejig accounts…');
  const allAccounts = await fetchAccountsSnapshot();
  const accounts = LIMIT < Infinity ? allAccounts.slice(0, LIMIT) : allAccounts;
  console.log(`[diag] Rejig: ${accounts.length} accounts (of ${allAccounts.length} total)\n`);

  // Step 2: LP customers + brokerages
  console.log('[diag] Loading LP customers + brokerages…');
  const [lpRows, brokerages] = await Promise.all([loadLpCustomers(), loadBrokerages()]);
  console.log(`[diag] LP: ${lpRows.length} customers; brokerages: Keyes=${brokerages.keyesId ?? 'MISSING'}, BW=${brokerages.bwId ?? 'MISSING'}\n`);

  const lpByEmail = new Map<string, LpCustomerRow>();
  const lpByRejigUserId = new Map<string, LpCustomerRow>();
  for (const row of lpRows) {
    if (row.contactEmail) lpByEmail.set(normEmail(row.contactEmail), row);
    if (row.rejigUserId) lpByRejigUserId.set(row.rejigUserId, row);
  }

  // Step 3: HS clients
  const hs = new HsClient({ accessToken: process.env.HUBSPOT_STATIC_TOKEN! });
  const stripeKey = process.env.STRIPE_LIVE_SECRET_KEY ?? process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) throw new Error('STRIPE_LIVE_SECRET_KEY (or STRIPE_SECRET_KEY) not set');
  // Stripe SDK pins API version; let the SDK default to its own current version
  const stripe = new Stripe(stripeKey);

  // Step 4: HS Contact search
  console.log('[diag] Searching HubSpot Contacts by email…');
  const allEmails = Array.from(new Set(accounts.map((a) => normEmail(a.email)).filter((e) => e.includes('@'))));
  const hsContactsByEmail = await searchHsContactsByEmails(hs, allEmails);
  console.log(`[diag] HS contacts matched: ${hsContactsByEmail.size}\n`);

  // Step 5: HS pipeline stage cache (for resolving stage IDs → labels)
  console.log('[diag] Loading HS CJ pipeline stages…');
  const stageCache = await buildStageCache(hs);
  console.log(`[diag] CJ pipeline stages: ${stageCache.size}\n`);

  // Step 6: HS Contact → Company + Ticket associations
  const matchedContactIds = Array.from(new Set(Array.from(hsContactsByEmail.values()).map((c) => c.id)));
  console.log(`[diag] Fetching company + ticket associations for ${matchedContactIds.length} contacts…`);
  const [contactCompanyMap, contactTicketMap] = await Promise.all([
    fetchContactCompanyAssociations(hs, matchedContactIds),
    fetchContactTicketAssociations(hs, matchedContactIds),
  ]);

  // Step 7: HS Ticket bulk-read for all associated tickets
  const allTicketIds = Array.from(new Set([...contactTicketMap.values()].flat()));
  console.log(`[diag] Fetching ${allTicketIds.length} HS ticket details…`);
  const ticketDetails = await fetchTicketsByIds(hs, allTicketIds, stageCache);

  // Step 8: Per-Rejig-account, do Stripe lookups + build CSV rows
  console.log(`\n[diag] Stripe lookups + final classification…`);
  const auditRows: AuditRow[] = [];
  let stripeChecked = 0;
  for (const acct of accounts) {
    const rejigEmail = normEmail(acct.email);
    const rejigEmailOriginal = (acct.email ?? '').trim();

    // Email match
    const hsContact = hsContactsByEmail.get(rejigEmail);
    const emailMatchMode: 'exact' | 'case_normalized' | 'none' = !hsContact
      ? 'none'
      : (hsContact.email === rejigEmailOriginal ? 'exact' : 'case_normalized');

    // Company association
    const companyIds = hsContact ? (contactCompanyMap.get(hsContact.id) ?? []) : [];
    let companyMatch: 'keyes' | 'bw' | 'other' | 'none';
    if (companyIds.includes(KEYES_COMPANY_ID)) companyMatch = 'keyes';
    else if (companyIds.includes(BW_COMPANY_ID)) companyMatch = 'bw';
    else if (companyIds.length > 0) companyMatch = 'other';
    else companyMatch = 'none';

    // CJ Ticket lookup (one per contact, pick first ticket in CJ pipeline)
    const associatedTicketIds = hsContact ? (contactTicketMap.get(hsContact.id) ?? []) : [];
    let cjTicket: HsTicketRow | undefined;
    for (const tId of associatedTicketIds) {
      const t = ticketDetails.get(tId);
      if (t && t.pipeline === CJ_PIPELINE_ID) {
        cjTicket = t;
        break;
      }
    }

    // Stripe lookup
    let stripeStatus: 'ok' | 'not_found' | 'auth_error' | 'skip_no_sub_id' = 'skip_no_sub_id';
    let stripeCustomerId = '';
    let stripeCustomerEmail = '';
    let stripeSubStatus = '';
    let stripeMetadataKeys: string[] = [];
    let stripeCurrentPeriodStart: Date | null = null;
    let stripeCurrentPeriodEnd: Date | null = null;
    if (acct.stripe_subscription_id) {
      const r = await lookupStripeForRejig(stripe, acct.stripe_subscription_id);
      stripeStatus = r.status;
      stripeCustomerId = r.customerId ?? '';
      stripeCustomerEmail = r.customerEmail ?? '';
      stripeSubStatus = r.subStatus ?? '';
      stripeMetadataKeys = r.metadataKeys ?? [];
      stripeCurrentPeriodStart = r.currentPeriodStart ?? null;
      stripeCurrentPeriodEnd = r.currentPeriodEnd ?? null;
      await sleep(50);
    }

    // Mongo _id → account creation date (§18)
    const rejigAccountCreatedAt = parseMongoIdTimestamp(acct._id);
    stripeChecked++;
    if (stripeChecked % 100 === 0) {
      process.stdout.write(`\r[diag] Stripe lookups: ${stripeChecked} / ${accounts.length}`);
    }

    // Channel detection
    const decision = detectChannel(acct, companyMatch);
    const channelCode = decision.channel;
    const customerType: 'D2C' | 'B2B' = channelCode === 'Standard' ? 'D2C' : 'B2B';
    const workflowKey =
      channelCode === 'Standard' ? 'D2C-Standard'
      : channelCode === 'Keyes' ? 'B2B-Keyes'
      : 'B2B-BW';
    const brokerageId =
      channelCode === 'Keyes' ? (brokerages.keyesId ?? '')
      : channelCode === 'BW' ? (brokerages.bwId ?? '')
      : '';
    const hsCompanyId =
      channelCode === 'Keyes' ? KEYES_COMPANY_ID
      : channelCode === 'BW' ? BW_COMPANY_ID
      : '';

    // Cohort decision
    const cohort = decideCohort({
      rejigStatus: acct.subscription_status,
      stripeSubStatus,
      hsTicketStageLabel: cjTicket?.stageLabel ?? '',
      hasTicket: Boolean(cjTicket),
    });

    // ─── Period dates + payment_source per cohort (§18) ───────────────────
    let proposedPeriodStart: Date | null = null;
    let proposedPeriodEnd: Date | null = null;
    let proposedPeriodStartSource: 'stripe' | 'mongo_id' | 'rejig_expiry' | 'unparseable' = 'unparseable';
    let proposedPaymentSource: 'stripe' | 'invoice' | '' = '';

    const hasStripeOk = acct.stripe_subscription_id && stripeStatus === 'ok';
    const rejigExpiry = acct.plan_expiry_date ? new Date(acct.plan_expiry_date) : null;

    if (hasStripeOk && stripeCurrentPeriodStart && stripeCurrentPeriodEnd) {
      // Stripe customers (Keyes active+trial, D2C-with-Stripe active+trial)
      proposedPeriodStart = stripeCurrentPeriodStart;
      proposedPeriodEnd = stripeCurrentPeriodEnd;
      proposedPeriodStartSource = 'stripe';
      proposedPaymentSource = 'stripe';
    } else if (channelCode === 'BW') {
      // B&W invoice: _id timestamp + 6 months
      if (rejigAccountCreatedAt) {
        proposedPeriodStart = rejigAccountCreatedAt;
        proposedPeriodEnd = addMonthsClamped(rejigAccountCreatedAt, 6);
        proposedPeriodStartSource = 'mongo_id';
        proposedPaymentSource = 'invoice';
      } else {
        proposedPeriodStartSource = 'unparseable';
        proposedPaymentSource = 'invoice'; // still B&W, just missing anchor
      }
    } else if (!acct.stripe_subscription_id) {
      // D2C-no-Stripe — two sub-cohorts (§18 Round 2)
      const isCancelled = acct.subscription_status === 'canceled' || acct.subscription_status === 'deactivated';
      if (rejigAccountCreatedAt) {
        proposedPeriodStart = rejigAccountCreatedAt;
        proposedPeriodEnd = rejigExpiry;
        proposedPeriodStartSource = 'mongo_id';
      } else if (rejigExpiry) {
        proposedPeriodStart = null;
        proposedPeriodEnd = rejigExpiry;
        proposedPeriodStartSource = 'rejig_expiry';
      } else {
        proposedPeriodStartSource = 'unparseable';
      }
      // Sub-cohort 1: was Stripe historically (cancelled) → payment_source='stripe'
      // Sub-cohort 2: active demos / data anomalies → payment_source=NULL
      proposedPaymentSource = isCancelled ? 'stripe' : '';
    } else {
      // Stripe sub exists but lookup failed (404 / auth error)
      // Don't propose period dates — backfill creates row with NULLs
      proposedPeriodStartSource = 'unparseable';
      proposedPaymentSource = 'stripe'; // historical truth
    }

    // LP existing-row check
    const lpExisting = lpByRejigUserId.get(acct._id) ?? (rejigEmail ? lpByEmail.get(rejigEmail) : undefined);

    // ─── needs_review reasons ───
    const reviewReasons: string[] = [];
    // Channel ambiguity rules:
    // - B2B: need ≥2 signals to agree (signal_1 + email_domain + url + plan_key can each vote)
    // - Standard: need ≥1 positive signal (only signal_4=plan_key can vote 'standard')
    //   → flag only if 'default:none' fallback fired with no positive evidence
    if (channelCode === 'Standard') {
      if (decision.evidence === 'default:none') reviewReasons.push('channel_ambiguous');
    } else {
      if (decision.score < 2) reviewReasons.push('channel_ambiguous');
    }
    if (emailMatchMode === 'case_normalized') reviewReasons.push('email_fuzzy_match');
    if (!hsContact) reviewReasons.push('email_no_match_in_hs');
    if (cjTicket && cjTicket.pipeline !== CJ_PIPELINE_ID) {
      reviewReasons.push('hs_ticket_exists_no_pipeline_match');
    }
    if (associatedTicketIds.length > 1) {
      // Count tickets in CJ pipeline
      const cjTickets = associatedTicketIds.filter((id) => ticketDetails.get(id)?.pipeline === CJ_PIPELINE_ID);
      if (cjTickets.length > 1) reviewReasons.push('hs_multiple_open_tickets');
    }
    if (acct.stripe_subscription_id && stripeStatus === 'not_found') reviewReasons.push('stripe_sub_not_found');
    if (acct.stripe_subscription_id && stripeStatus === 'ok' && stripeSubStatus && stripeSubStatus !== acct.subscription_status) {
      reviewReasons.push('stripe_status_mismatch');
    }
    if (stripeStatus === 'ok' && stripeCustomerEmail && normEmail(stripeCustomerEmail) !== rejigEmail) {
      reviewReasons.push('stripe_customer_mismatch_email');
    }
    if (channelCode !== 'Standard' && !hsCompanyId) {
      reviewReasons.push('b2b_no_brokerage_company_id');
    }
    if (companyMatch !== 'none' && companyMatch !== 'keyes' && companyMatch !== 'bw' && channelCode !== 'Standard') {
      reviewReasons.push('b2b_company_id_mismatch');
    }
    if (companyMatch === 'keyes' && channelCode !== 'Keyes') reviewReasons.push('b2b_company_id_mismatch');
    if (companyMatch === 'bw' && channelCode !== 'BW') reviewReasons.push('b2b_company_id_mismatch');
    if (lpExisting && lpExisting.rejigUserId === acct._id) {
      reviewReasons.push('lp_rejig_user_id_already_exists');
    } else if (lpExisting) {
      reviewReasons.push('lp_email_already_exists');
    }
    if (!acct.stripe_subscription_id) reviewReasons.push('stripe_no_sub_id');
    if (!rejigEmail || !rejigEmail.includes('@')) reviewReasons.push('rejig_no_email');
    // Trial exceptions only (per founder)
    if (acct.subscription_status === 'trialing' && channelCode !== 'Keyes') {
      reviewReasons.push('trial_non_keyes');
    }
    // §18: payment_source_unknown — active D2C with no sub (demos / data anomalies)
    if (proposedPaymentSource === '' && cohort.onboardingState === 'Active') {
      reviewReasons.push('payment_source_unknown');
    }
    // §18: unparseable Mongo _id (BLOCKING)
    if (proposedPeriodStartSource === 'unparseable' && !hasStripeOk) {
      reviewReasons.push('mongo_id_unparseable');
    }

    // Action-required vs informational split:
    // needs_review=Y only when the founder must actually decide something.
    // Other reasons are kept in needs_review_reasons (so they show in CSV) but
    // don't trigger the human-eyeball flag. The backfill script handles
    // informational reasons by following the auto-rules in the plan §6.
    const ACTION_REQUIRED_REASONS = new Set([
      'channel_ambiguous',
      'trial_non_keyes',
      'hs_multiple_open_tickets',
      'b2b_no_brokerage_company_id',
      'b2b_company_id_mismatch',
      'lp_email_already_exists',
      'rejig_no_email',
      'mongo_id_unparseable',          // §18 — blocking
    ]);
    const needsReview = reviewReasons.some((r) => ACTION_REQUIRED_REASONS.has(r));

    // Notes — short summary
    const notesParts: string[] = [];
    if (cjTicket && cohort.ticketAction === 'move_stage') {
      notesParts.push(`move ${cjTicket.stageLabel} → ${cohort.ticketTargetStage}`);
    }
    if (companyMatch !== 'none' && channelCode !== 'Standard') {
      notesParts.push(`company_match:${companyMatch}`);
    }
    if (stripeMetadataKeys.length > 0) {
      notesParts.push(`stripe_md:${stripeMetadataKeys.join('+')}`);
    }

    const row: AuditRow = {
      rejig_user_id: acct._id,
      rejig_email: rejigEmailOriginal,
      rejig_account_name: acct.account_name ?? '',
      rejig_business_name: acct.business_name ?? acct.display_business_name ?? '',
      rejig_domain_url: acct.domain_url ?? '',
      rejig_plan_key: acct.plan_key ?? '',
      rejig_subscription_status: acct.subscription_status ?? '',
      rejig_stripe_sub_id: acct.stripe_subscription_id ?? '',
      rejig_last_login: acct.last_login ?? '',
      rejig_plan_expiry_date: acct.plan_expiry_date ?? '',
      rejig_post_count_total: String(acct.post_metrics?.total_published ?? ''),
      rejig_account_created_at: rejigAccountCreatedAt ? rejigAccountCreatedAt.toISOString() : '',
      email_match_mode: emailMatchMode,
      hs_contact_id: hsContact?.id ?? '',
      hs_contact_company_ids: companyIds.join(','),
      hs_contact_company_match: companyMatch,
      hs_ticket_id: cjTicket?.id ?? '',
      hs_ticket_current_stage_label: cjTicket?.stageLabel ?? '',
      hs_ticket_current_stage_id: cjTicket?.stageId ?? '',
      stripe_lookup_status: stripeStatus,
      stripe_customer_id: stripeCustomerId,
      stripe_customer_email: stripeCustomerEmail,
      stripe_sub_status: stripeSubStatus,
      stripe_current_period_start: stripeCurrentPeriodStart ? stripeCurrentPeriodStart.toISOString() : '',
      stripe_current_period_end: stripeCurrentPeriodEnd ? stripeCurrentPeriodEnd.toISOString() : '',
      stripe_metadata_existing_keys: stripeMetadataKeys.join(','),
      lp_customer_id: randomUUID(),
      lp_customer_id_existing: lpExisting?.id ?? '',
      proposed_workflow_key: workflowKey,
      proposed_channel_code: channelCode,
      proposed_customer_type: customerType,
      proposed_brokerage_id: brokerageId,
      proposed_hubspot_company_id: hsCompanyId,
      proposed_onboarding_state: cohort.onboardingState,
      proposed_ticket_target_stage: cohort.ticketTargetStage,
      proposed_ticket_action: cohort.ticketAction,
      proposed_subscription_status: cohort.subscriptionStatus,
      proposed_current_period_start: proposedPeriodStart ? proposedPeriodStart.toISOString() : '',
      proposed_current_period_end: proposedPeriodEnd ? proposedPeriodEnd.toISOString() : '',
      proposed_current_period_start_source: proposedPeriodStartSource,
      proposed_payment_source: proposedPaymentSource,
      channel_detection_evidence: decision.evidence,
      channel_detection_score: String(decision.score),
      needs_review: needsReview ? 'Y' : 'N',
      needs_review_reasons: reviewReasons.join(';'),
      notes: notesParts.join('; '),
    };
    auditRows.push(row);
  }
  process.stdout.write('\n');

  // Step 9: Sort and write
  // needs_review=Y first, then by proposed_workflow_key, then by rejig_email
  auditRows.sort((a, b) => {
    if (a.needs_review !== b.needs_review) return a.needs_review === 'Y' ? -1 : 1;
    if (a.proposed_workflow_key !== b.proposed_workflow_key) {
      return a.proposed_workflow_key.localeCompare(b.proposed_workflow_key);
    }
    return a.rejig_email.localeCompare(b.rejig_email);
  });

  writeCsv(OUT_PATH, auditRows);

  // Step 10: Summary
  console.log('\n============================================');
  console.log('   DIAGNOSTIC SUMMARY');
  console.log('============================================');
  console.log(`Rows: ${auditRows.length}`);

  const byChannel: Record<string, number> = {};
  const byState: Record<string, number> = {};
  const byReviewReasonActionReq: Record<string, number> = {};
  const byReviewReasonTotal: Record<string, number> = {};
  const byTicketAction: Record<string, number> = {};
  let reviewCount = 0;
  for (const r of auditRows) {
    byChannel[r.proposed_channel_code] = (byChannel[r.proposed_channel_code] ?? 0) + 1;
    byState[r.proposed_onboarding_state] = (byState[r.proposed_onboarding_state] ?? 0) + 1;
    byTicketAction[r.proposed_ticket_action] = (byTicketAction[r.proposed_ticket_action] ?? 0) + 1;
    const reasons = r.needs_review_reasons.split(';').filter(Boolean);
    for (const reason of reasons) {
      byReviewReasonTotal[reason] = (byReviewReasonTotal[reason] ?? 0) + 1;
    }
    if (r.needs_review === 'Y') {
      reviewCount++;
      for (const reason of reasons) {
        byReviewReasonActionReq[reason] = (byReviewReasonActionReq[reason] ?? 0) + 1;
      }
    }
  }

  console.log(`\n— Channel distribution —`);
  for (const [k, v] of Object.entries(byChannel).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(20)} ${v}`);
  console.log(`\n— Onboarding state target —`);
  for (const [k, v] of Object.entries(byState).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(20)} ${v}`);
  console.log(`\n— Ticket action —`);
  for (const [k, v] of Object.entries(byTicketAction).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(20)} ${v}`);
  console.log(`\n— Flag counts (all rows; action-required count in parens) —`);
  for (const [k, v] of Object.entries(byReviewReasonTotal).sort((a, b) => b[1] - a[1])) {
    const ar = byReviewReasonActionReq[k] ?? 0;
    console.log(`  ${k.padEnd(40)} total=${String(v).padEnd(4)} (action-req: ${ar})`);
  }
  console.log(`\n— needs_review=Y total: ${reviewCount} rows —`);

  console.log(`\n[diag] Written: ${OUT_PATH}`);
  console.log(`[diag] Next: open the CSV in Excel/Sheets; review the top needs_review=Y rows.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[diag] FATAL:', err);
  process.exit(1);
});
