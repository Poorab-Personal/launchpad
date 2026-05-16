/**
 * Backfill apply — Rejig × HubSpot Contact × HubSpot CJ Ticket × Stripe × LP.
 *
 * Reads the diagnostic CSV (with founder's manual_action overrides) and
 * per-row creates: LP customer + HS Contact upsert (Company-associated for B2B)
 * + HS CJ Ticket (create or move-stage) + customer_subscriptions row + Stripe
 * metadata MERGE + customer_state_transitions synthetic row + orphan-signal rebind.
 *
 * Idempotency: every step keys on `rejig_user_id`. Re-running the script
 * resumes partial work without duplicating; the LP UNIQUE index on
 * customers.rejig_user_id is the canonical "have I done this row?" check.
 *
 * Spec: docs/plans/rejig-hs-stripe-backfill-plan.md §10 + §18.
 *
 * Usage:
 *   # Dry-run (default; no writes)
 *   npx tsx --env-file=.env.local scripts/backfill-rejig-4way.ts
 *
 *   # Apply (writes to LP DB + HS + Stripe)
 *   LAUNCHPAD_BACKFILL_CONFIRM=2026-05-15 \
 *     npx tsx --env-file=.env.local scripts/backfill-rejig-4way.ts --apply
 *
 *   # Limited apply (testing): N rows
 *   ... --apply --limit=10
 *
 *   # Replay a specific row (after fixing an error)
 *   ... --apply --only-rejig-user-id=68dff15b914846ecfbf60275
 *
 *   # Include rows where needs_review=Y (default skips them)
 *   ... --include-review
 *
 * Required env: HUBSPOT_STATIC_TOKEN, STRIPE_LIVE_SECRET_KEY,
 *               POSTGRES_URL_NON_POOLING, REJIG_API_KEY.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { Client as HsClient } from '@hubspot/api-client';
import Stripe from 'stripe';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import { customers } from '@/db/schema/customers';
import { customerSubscriptions } from '@/db/schema/customerSubscriptions';
import { customerStateTransitions } from '@/db/schema/customerStateTransitions';
import { customerUsageSignals } from '@/db/schema/customerUsageSignals';
import { channels } from '@/db/schema/channels';
import {
  createContact,
  createCustomerJourneyTicket,
  ensureContactCompanyAssociation,
  pushTicketStage,
  updateContactProperties,
} from '@/lib/integrations/hubspot/client';

// ─── CLI ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const INCLUDE_REVIEW = args.includes('--include-review');
const LIMIT = (() => {
  const a = args.find((x) => x.startsWith('--limit='));
  return a ? parseInt(a.split('=')[1], 10) : Infinity;
})();
const ONLY_IDS = args
  .filter((x) => x.startsWith('--only-rejig-user-id='))
  .map((x) => x.split('=')[1]);
const TODAY = new Date().toISOString().slice(0, 10);
const csvArg = args.find((x) => x.startsWith('--csv='));
const CSV_PATH = csvArg ? csvArg.split('=')[1] : `scripts/data/backfill-audit-${TODAY}.csv`;
const LOG_PATH = `scripts/data/backfill-apply-log-${TODAY}.jsonl`;

if (APPLY && process.env.LAUNCHPAD_BACKFILL_CONFIRM !== TODAY) {
  console.error(
    `[backfill] REFUSING TO APPLY without confirmation.\n` +
    `  Set: LAUNCHPAD_BACKFILL_CONFIRM=${TODAY} npx tsx ... --apply\n`,
  );
  process.exit(2);
}

// ─── Types ──────────────────────────────────────────────────────────────────
type Row = Record<string, string>;

type LogEntry = {
  ts: string;
  rejig_user_id: string;
  lp_customer_id?: string;
  hubspot_contact_id?: string;
  hubspot_ticket_id?: string;
  stripe_customer_id?: string;
  status: 'applied' | 'resumed' | 'skipped' | 'error' | 'would-apply';
  manual_action?: string;
  steps_done: string[];
  error?: string;
};

// ─── CSV ────────────────────────────────────────────────────────────────────
function parseCsv(path: string): Row[] {
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n').filter((l) => l.length > 0);
  const header = lines[0].split(',');
  const rows: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells: string[] = [];
    let cur = '', inQ = false;
    for (let j = 0; j < lines[i].length; j++) {
      const ch = lines[i][j];
      if (ch === '"' && lines[i][j + 1] === '"') { cur += '"'; j++; continue; }
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === ',' && !inQ) { cells.push(cur); cur = ''; continue; }
      cur += ch;
    }
    cells.push(cur);
    const r: Row = {};
    header.forEach((h, k) => (r[h] = cells[k] ?? ''));
    rows.push(r);
  }
  return rows;
}

function ts(): string { return new Date().toISOString(); }
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

function appendLog(entry: LogEntry): void {
  if (!APPLY) return; // dry-run doesn't write log
  mkdirSync('scripts/data', { recursive: true });
  appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n');
}

// ─── Channel → HS enum INTERNAL value for rejig_brokerage_channel property ──
// HS portal has: d2c, b2b_keyes, b2b_bw, b2b_ipre. These are the internal
// option values (not display labels).
const HS_CHANNEL_ENUM: Record<string, string> = {
  Standard: 'd2c',
  Keyes: 'b2b_keyes',
  BW: 'b2b_bw',
};

// ─── Brokerage business_name patterns to NOT use as customer/ticket name ──
// Rejig's `business_name` for B2B agents is often the brokerage's master name
// (e.g. "The Keyes Company"), not the agent's. Falling back to email-local
// gives a more identifiable name in those cases.
const BROKERAGE_BUSINESS_NAMES = new Set([
  'the keyes company',
  'the keyes co',
  'keyes',
  'baird & warner',
  'baird and warner',
  'bairdwarner',
]);

function pickDisplayName(row: Row): string {
  const biz = (row.rejig_business_name || '').trim();
  const localPart = row.rejig_email.split('@')[0];
  if (biz && !BROKERAGE_BUSINESS_NAMES.has(biz.toLowerCase())) return biz;
  return localPart;
}

// ─── Determine payment_mode per cohort ──────────────────────────────────────
function paymentModeFor(channelCode: string, subStatus: string): string {
  if (channelCode === 'Keyes' && subStatus === 'trialing') return 'setup-intent-at-intake';
  if (channelCode === 'BW') return 'invoice';
  return 'pre-paid';
}

// ─── Resolve channel_id from channels table (cached) ────────────────────────
let _channelCache: Map<string, string> | null = null;
async function getChannelId(code: string): Promise<string> {
  if (!_channelCache) {
    const rows = await db.select({ id: channels.id, code: channels.code }).from(channels);
    _channelCache = new Map(rows.map((r) => [r.code, r.id]));
  }
  const id = _channelCache.get(code);
  if (!id) throw new Error(`Channel code ${code} not found in channels table`);
  return id;
}

// ─── Per-row processor ──────────────────────────────────────────────────────
type ProcessResult = {
  status: LogEntry['status'];
  log: LogEntry;
};

async function processRow(
  row: Row,
  hs: HsClient,
  stripe: Stripe,
): Promise<ProcessResult> {
  const rejigUserId = row.rejig_user_id;
  const manualAction = row.manual_action || '';
  const steps: string[] = [];
  const log: LogEntry = {
    ts: ts(),
    rejig_user_id: rejigUserId,
    status: 'would-apply',
    manual_action: manualAction || undefined,
    steps_done: steps,
  };

  // ── Skip rows by manual_action ──────────────────────────────────────────
  if (manualAction === 'skip' || manualAction === 'stripe_pending' || manualAction === 'tbd') {
    return { status: 'skipped', log: { ...log, status: 'skipped', steps_done: [`skip:${manualAction}`] } };
  }

  // ── needs_review gate ──
  if (row.needs_review === 'Y' && !INCLUDE_REVIEW && !manualAction) {
    return { status: 'skipped', log: { ...log, status: 'skipped', steps_done: ['skip:needs_review'] } };
  }

  // ── Resolve overrides ────────────────────────────────────────────────────
  const channelCode = (row.manual_channel_code_override || row.proposed_channel_code) as
    'Standard' | 'Keyes' | 'BW';
  const customerType = channelCode === 'Standard' ? 'D2C' : 'B2B';
  const workflowKey =
    channelCode === 'Standard' ? 'D2C-Standard'
    : channelCode === 'Keyes' ? 'B2B-Keyes'
    : 'B2B-BW';
  const brokerageId = row.proposed_brokerage_id || null;
  const hsCompanyId = row.proposed_hubspot_company_id || null;

  // Apply churn override
  let onboardingState = row.proposed_onboarding_state as 'Active' | 'Churned';
  let ticketTargetStage = row.proposed_ticket_target_stage as 'Active' | 'Churned';
  let subscriptionStatus = row.proposed_subscription_status || null;
  if (manualAction === 'churn') {
    onboardingState = 'Churned';
    ticketTargetStage = 'Churned';
    subscriptionStatus = 'Cancelled';
  }

  // Ticket action — honor override if provided
  const hsTicketIdOverride = row.manual_hs_ticket_id_override || '';
  const effectiveHsTicketId = hsTicketIdOverride || row.hs_ticket_id;
  const ticketAction = (row.proposed_ticket_action as 'create_new' | 'move_stage' | 'noop') ?? 'noop';

  // Payment source
  let paymentSource = (row.proposed_payment_source as 'stripe' | 'invoice' | '') || '';
  if (manualAction === 'demo' || manualAction === 'leave_alone') paymentSource = '';
  const paymentSourceForDb: 'stripe' | 'invoice' | null = paymentSource === '' ? null : paymentSource as 'stripe' | 'invoice';

  // Period dates
  const periodStart = row.proposed_current_period_start ? new Date(row.proposed_current_period_start) : null;
  const periodEnd = row.proposed_current_period_end ? new Date(row.proposed_current_period_end) : null;
  const periodSource = row.proposed_current_period_start_source || null;
  const rejigAccountCreatedAt = row.rejig_account_created_at ? new Date(row.rejig_account_created_at) : null;

  // ── Idempotency check: LP customer already exists for this rejig_user_id? ──
  const existing = await db.query.customers.findFirst({
    where: eq(customers.rejigUserId, rejigUserId),
  });
  let lpCustomerId: string;
  let isResume = false;
  if (existing) {
    lpCustomerId = existing.id;
    isResume = true;
    log.status = 'resumed';
    steps.push('lp:exists');
  } else {
    lpCustomerId = row.lp_customer_id || randomUUID();
    log.status = 'applied';
    steps.push('lp:new-uuid');
  }
  log.lp_customer_id = lpCustomerId;

  // Display name for customer.name + HS Ticket subject
  const displayName = pickDisplayName(row);

  // ── HS Contact upsert ────────────────────────────────────────────────────
  let hsContactId = row.hs_contact_id || existing?.hubspotContactId || '';

  if (APPLY) {
    if (!hsContactId) {
      // Create new HS Contact (cohort D — Rejig only, no existing HS row)
      const [firstName, ...rest] = displayName.split(' ');
      const lastName = rest.join(' ');
      try {
        const created = await createContact({
          email: row.rejig_email,
          firstName: firstName || null,
          lastName: lastName || null,
          phone: null,
          companyId: hsCompanyId || undefined,
          customProperties: {
            launchpad_customer_id: lpCustomerId,
            stripe_customer_id: row.stripe_customer_id || '',
            rejig_user_id: rejigUserId,
            rejig_brokerage_channel: HS_CHANNEL_ENUM[channelCode],
            rejig_payment_mode: paymentModeFor(channelCode, row.rejig_subscription_status),
            company: row.rejig_business_name || '',
          },
        });
        hsContactId = created.contactId;
        steps.push('hs:contact-created');
        await sleep(100);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.status = 'error';
        log.error = `hs:contact-create failed: ${msg}`;
        return { status: 'error', log };
      }
    } else {
      // Update existing HS Contact properties
      try {
        await updateContactProperties(hsContactId, {
          launchpad_customer_id: lpCustomerId,
          stripe_customer_id: row.stripe_customer_id || '',
          rejig_user_id: rejigUserId,
          rejig_brokerage_channel: HS_CHANNEL_ENUM[channelCode],
          rejig_payment_mode: paymentModeFor(channelCode, row.rejig_subscription_status),
        });
        steps.push('hs:contact-updated');
        await sleep(100);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[backfill] HS contact update failed for ${rejigUserId}: ${msg}`);
        // Non-blocking — proceed
      }
    }
  } else {
    steps.push(hsContactId ? 'hs:contact-would-update' : 'hs:contact-would-create');
  }
  log.hubspot_contact_id = hsContactId;

  // ── HS Contact ↔ Company association (B2B only) ─────────────────────────
  if (hsCompanyId && hsContactId && APPLY) {
    try {
      await ensureContactCompanyAssociation(hsContactId, hsCompanyId);
      steps.push('hs:company-associated');
      await sleep(100);
    } catch (err) {
      console.warn(`[backfill] HS company assoc failed for ${rejigUserId}:`, err);
    }
  } else if (hsCompanyId && hsContactId) {
    steps.push('hs:company-would-associate');
  }

  // ── HS Ticket upsert ─────────────────────────────────────────────────────
  // Resume safety: if LP customer already has hubspot_ticket_id stored, the
  // ticket was created/moved in a prior run. Don't re-run the ticket op or
  // we get duplicate tickets (the bug that surfaced in the 2026-05-16 smoke).
  let hsTicketId = effectiveHsTicketId;
  if (isResume && existing?.hubspotTicketId) {
    hsTicketId = existing.hubspotTicketId;
    steps.push('hs:ticket-skip-resume');
  } else if (APPLY) {
    try {
      if (ticketAction === 'create_new') {
        const created = await createCustomerJourneyTicket({
          subject: `${displayName} - LP`,
          stageLabel: ticketTargetStage,
          contactId: hsContactId,
          companyId: hsCompanyId || undefined,
        });
        hsTicketId = created.ticketId;
        steps.push('hs:ticket-created');
        await sleep(100);
      } else if (ticketAction === 'move_stage' && hsTicketId) {
        await pushTicketStage(hsTicketId, ticketTargetStage);
        steps.push('hs:ticket-moved');
        await sleep(100);
      } else {
        steps.push('hs:ticket-noop');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[backfill] HS ticket op failed for ${rejigUserId}: ${msg}`);
      // Non-blocking — proceed with LP write even if HS ticket failed
    }
  } else {
    steps.push(`hs:ticket-would-${ticketAction}`);
  }
  log.hubspot_ticket_id = hsTicketId;

  // ── LP INSERT (only if not resuming) ─────────────────────────────────────
  if (!isResume) {
    if (APPLY) {
      try {
        const channelId = await getChannelId(channelCode);
        await db.transaction(async (tx) => {
          await tx.insert(customers).values({
            id: lpCustomerId,
            name: displayName,
            contactEmail: row.rejig_email,
            platformEmail: row.rejig_email,
            phone: null,
            businessName: row.rejig_business_name || null,
            website: row.rejig_domain_url || null,
            type: customerType,
            channelId,
            workflowKey,
            brokerageId,
            hubspotContactId: hsContactId || null,
            hubspotTicketId: hsTicketId || null,
            stripeCustomerId: row.stripe_customer_id || null,
            stripeSubscriptionId: row.rejig_stripe_sub_id || null,
            rejigUserId,
            subscriptionStatus: subscriptionStatus as
              'Active' | 'Trial' | 'Past Due' | 'Cancelled' | null,
            currentStage: 'Backfilled',
            onboardingState: onboardingState as
              'Pre-Onboarding' | 'Onboarding Scheduled' | 'Active' | 'Watch' | 'At-Risk' | 'Critical' | 'On Hold' | 'Churned',
            accountCreated: true,
            credentialsSent: true,
            callBooked: false,
            callCompleted: false,
            createdVia: 'backfill',
            environment: ['prod'],
          });

          await tx.insert(customerStateTransitions).values({
            customerId: lpCustomerId,
            fromState: null,
            toState: onboardingState as
              'Pre-Onboarding' | 'Onboarding Scheduled' | 'Active' | 'Watch' | 'At-Risk' | 'Critical' | 'On Hold' | 'Churned',
            changeSource: 'lp_admin',
            sourceDetail: `backfill_${TODAY}:rejig=${rejigUserId}`,
            changedAt: new Date(),
            payload: {
              kind: 'backfill',
              evidence: row.channel_detection_evidence,
              channel_detection_score: Number(row.channel_detection_score || '0'),
              manual_action: manualAction || null,
            },
          });

          // customer_subscriptions row — always (even non-Stripe)
          await tx.insert(customerSubscriptions).values({
            customerId: lpCustomerId,
            product: 'Core',
            stripeSubscriptionId: row.rejig_stripe_sub_id || null,
            hubspotDealId: null,
            status: subscriptionStatus as
              'Active' | 'Trial' | 'Past Due' | 'Cancelled' | null,
            startedAt: rejigAccountCreatedAt,
            endedAt: null,
            mrr: null,
            currentPeriodStart: periodStart,
            currentPeriodEnd: periodEnd,
            currentPeriodStartSource: periodSource,
            lastInvoiceStatus: null,
            lastInvoiceUrl: null,
            paymentSource: paymentSourceForDb,
          });
        });
        steps.push('lp:inserted');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.status = 'error';
        log.error = `lp:insert failed: ${msg}`;
        return { status: 'error', log };
      }
    } else {
      steps.push('lp:would-insert');
    }
  }

  // ── Stripe metadata MERGE ────────────────────────────────────────────────
  if (row.stripe_customer_id && row.rejig_stripe_sub_id) {
    log.stripe_customer_id = row.stripe_customer_id;
    if (APPLY) {
      try {
        // Re-fetch fresh metadata
        const [cusFresh, subFresh] = await Promise.all([
          stripe.customers.retrieve(row.stripe_customer_id),
          stripe.subscriptions.retrieve(row.rejig_stripe_sub_id),
        ]);
        const cusMd = (cusFresh as Stripe.Customer).metadata ?? {};
        const subMd = subFresh.metadata ?? {};
        const newKeys = {
          launchpad_customer_id: lpCustomerId,
          rejig_user_id: rejigUserId,
          hubspot_contact_id: hsContactId,
        };
        await stripe.customers.update(row.stripe_customer_id, {
          metadata: { ...cusMd, ...newKeys },
        });
        await stripe.subscriptions.update(row.rejig_stripe_sub_id, {
          metadata: { ...subMd, ...newKeys },
        });
        steps.push('stripe:metadata-merged');
        await sleep(50);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[backfill] Stripe metadata merge failed for ${rejigUserId}: ${msg}`);
        // Non-blocking
      }
    } else {
      steps.push('stripe:metadata-would-merge');
    }
  }

  // ── Rebind orphan signals (UPDATE customer_usage_signals) ───────────────
  if (APPLY) {
    try {
      const result = await db
        .update(customerUsageSignals)
        .set({ customerId: lpCustomerId })
        .where(
          and(
            eq(customerUsageSignals.rejigUserId, rejigUserId),
            isNull(customerUsageSignals.customerId),
          ),
        );
      // Drizzle's pg returns rowCount via result.rowCount in some adapters; not strictly needed for log
      steps.push(`signals:rebound`);
    } catch (err) {
      console.warn(`[backfill] signal rebind failed for ${rejigUserId}:`, err);
    }
  } else {
    steps.push('signals:would-rebind');
  }

  log.steps_done = steps;
  if (!APPLY) log.status = 'would-apply';
  return { status: log.status, log };
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`[backfill] mode=${APPLY ? 'APPLY' : 'DRY-RUN'} limit=${LIMIT === Infinity ? 'unlimited' : LIMIT}`);
  console.log(`[backfill] csv=${CSV_PATH}`);
  console.log(`[backfill] log=${APPLY ? LOG_PATH : '(dry-run; not written)'}`);
  if (ONLY_IDS.length > 0) console.log(`[backfill] only=${ONLY_IDS.join(',')}`);
  console.log();

  const rows = parseCsv(CSV_PATH);
  console.log(`[backfill] loaded ${rows.length} CSV rows`);

  const filtered = ONLY_IDS.length > 0
    ? rows.filter((r) => ONLY_IDS.includes(r.rejig_user_id))
    : rows;
  const slice = LIMIT < Infinity ? filtered.slice(0, LIMIT) : filtered;
  console.log(`[backfill] processing ${slice.length} rows\n`);

  if (!process.env.HUBSPOT_STATIC_TOKEN) throw new Error('HUBSPOT_STATIC_TOKEN missing');
  const stripeKey = process.env.STRIPE_LIVE_SECRET_KEY ?? process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) throw new Error('STRIPE_LIVE_SECRET_KEY (or STRIPE_SECRET_KEY) missing');

  const hs = new HsClient({ accessToken: process.env.HUBSPOT_STATIC_TOKEN });
  const stripe = new Stripe(stripeKey);

  const tally: Record<LogEntry['status'], number> = {
    applied: 0,
    resumed: 0,
    skipped: 0,
    error: 0,
    'would-apply': 0,
  };
  const errors: Array<{ rejig_user_id: string; error: string }> = [];

  for (let i = 0; i < slice.length; i++) {
    const row = slice[i];
    try {
      const { status, log } = await processRow(row, hs, stripe);
      tally[status]++;
      appendLog(log);
      if (status === 'error') errors.push({ rejig_user_id: row.rejig_user_id, error: log.error ?? '' });
      if ((i + 1) % 25 === 0 || i + 1 === slice.length) {
        process.stdout.write(
          `\r[backfill] ${i + 1}/${slice.length} | applied=${tally.applied} resumed=${tally.resumed} skipped=${tally.skipped} would=${tally['would-apply']} errors=${tally.error}`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n[backfill] FATAL on rejig_user_id=${row.rejig_user_id}: ${msg}`);
      errors.push({ rejig_user_id: row.rejig_user_id, error: msg });
      tally.error++;
    }
  }
  process.stdout.write('\n\n');

  console.log('============================================');
  console.log('   BACKFILL SUMMARY');
  console.log('============================================');
  for (const [k, v] of Object.entries(tally)) console.log(`  ${k.padEnd(12)} ${v}`);
  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors.slice(0, 20)) console.log(`  ${e.rejig_user_id}: ${e.error.slice(0, 200)}`);
    if (errors.length > 20) console.log(`  … and ${errors.length - 20} more (see log)`);
  }
  if (APPLY) console.log(`\nLog: ${LOG_PATH}`);
  else console.log(`\nRe-run with --apply (and LAUNCHPAD_BACKFILL_CONFIRM=${TODAY}) to execute.`);
  process.exit(errors.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[backfill] unrecoverable:', err);
  process.exit(1);
});
