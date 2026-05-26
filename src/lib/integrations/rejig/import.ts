/**
 * Reusable Rejig snapshot importer.
 *
 * Pulls the live `${REJIG_API_URL}/dashboard/admin/account-list` snapshot
 * and writes 6 signal rows per account into `customer_usage_signals`.
 * Idempotent on (customer_id | rejig_user_id, signal_type, observed_at).
 *
 * Both the CLI script (`scripts/import-rejig-snapshot.ts`) and the
 * Sunday cron route (`/api/cron/import-rejig`) call this. Pass `apply:
 * false` for a dry-run summary, `true` to commit.
 *
 * Identity mapping per Pass 2.7 §29.1: case-insensitive contactEmail then
 * platformEmail. Multi-match accounts get conflict-logged + orphan-inserted
 * (customer_id = NULL, rejig_user_id set) so Phase 6 backfill can reconcile.
 *
 * Data-quality regressions (lifetime posts going down) are detected per
 * Pass 2.7 §29.4 — observability-only, logged via the optional logger; the
 * `data_quality_events` table doesn't exist yet (Phase 4c).
 */
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '@/db';
import { customers } from '@/db/schema/customers';
import { customerUsageSignals } from '@/db/schema/customerUsageSignals';
import { SIGNAL_SOURCES, SIGNAL_TYPES } from '@/lib/bi/signal-types';
import { fetchAccountsSnapshot, type RejigAccount } from './client';

type SignalRow = {
  customerId: string | null;
  rejigUserId: string | null;
  signalType: string;
  signalValueNumeric: string | null;
  signalValueJsonb: Record<string, unknown>;
  observedAt: Date;
  source: string;
};

export type RejigImportOptions = {
  apply: boolean;
  limit?: number | null;
  /**
   * Optional logger for progress messages. Cron routes pass console.log;
   * tests can capture into an array; pass () => {} to silence.
   */
  log?: (msg: string) => void;
};

export type RejigImportSummary = {
  durationMs: number;
  mode: 'apply' | 'dry-run';
  accountsFetched: number;
  accountsProcessed: number;
  matched: number;
  unmatched: number;
  conflicts: number;
  signalsBuilt: number;
  signalsToInsert: number;
  signalsInserted: number;
  signalsSkipped: number;
  regressionsDetected: number;
  errorBatches: number;
  conflictsSample: Array<{ email: string; rejigId: string; candidateCustomerIds: string[] }>;
};

function buildSignalsForAccount(args: {
  account: RejigAccount;
  customerId: string | null;
  snapshotDate: Date;
}): SignalRow[] {
  const { account, customerId, snapshotDate } = args;
  const rejigUserId = account._id;
  const source = SIGNAL_SOURCES.REJIG_API;
  const snapshotIso = snapshotDate.toISOString().slice(0, 10);

  const rows: SignalRow[] = [];

  let lastLoginAt: Date | null = null;
  if (account.last_login) {
    const parsed = new Date(account.last_login);
    if (!Number.isNaN(parsed.getTime())) lastLoginAt = parsed;
  }
  let daysSinceLogin: number | null = null;
  if (lastLoginAt) {
    daysSinceLogin = Math.max(
      0,
      Math.floor((snapshotDate.getTime() - lastLoginAt.getTime()) / 86400000),
    );
  }
  rows.push({
    customerId,
    rejigUserId,
    signalType: SIGNAL_TYPES.REJIG_LAST_LOGIN,
    signalValueNumeric: daysSinceLogin != null ? String(daysSinceLogin) : null,
    signalValueJsonb: {
      lastLoginISO: lastLoginAt ? lastLoginAt.toISOString() : null,
      never: lastLoginAt === null,
      _id: rejigUserId,
      snapshotDate: snapshotIso,
    },
    observedAt: lastLoginAt ?? snapshotDate,
    source,
  });

  const daysSinceLastPost = account.post_metrics?.days_since_last_post ?? null;
  rows.push({
    customerId,
    rejigUserId,
    signalType: SIGNAL_TYPES.REJIG_DAYS_SINCE_LAST_POST,
    signalValueNumeric: daysSinceLastPost != null ? String(daysSinceLastPost) : null,
    signalValueJsonb: {
      neverPosted: daysSinceLastPost === null,
      _id: rejigUserId,
      snapshotDate: snapshotIso,
    },
    observedAt: snapshotDate,
    source,
  });

  const totalPosts = account.post_metrics?.total_published ?? 0;
  rows.push({
    customerId,
    rejigUserId,
    signalType: SIGNAL_TYPES.REJIG_TOTAL_PUBLISHED_POSTS,
    signalValueNumeric: String(totalPosts),
    signalValueJsonb: {
      videoPosts: account.post_metrics?.video_posts ?? 0,
      imagePosts: account.post_metrics?.image_posts ?? 0,
      contentTypeBreakdown: account.post_metrics?.content_type_breakdown ?? {},
      _id: rejigUserId,
      snapshotDate: snapshotIso,
    },
    observedAt: snapshotDate,
    source,
  });

  rows.push({
    customerId,
    rejigUserId,
    signalType: SIGNAL_TYPES.REJIG_LISTING_COUNT,
    signalValueNumeric: String(account.listing_count ?? 0),
    signalValueJsonb: { _id: rejigUserId, snapshotDate: snapshotIso },
    observedAt: snapshotDate,
    source,
  });

  rows.push({
    customerId,
    rejigUserId,
    signalType: SIGNAL_TYPES.REJIG_DAYS_UNTIL_EXPIRY,
    signalValueNumeric: String(account.days_until_expiry ?? 0),
    signalValueJsonb: {
      planExpiryDate: account.plan_expiry_date ?? null,
      planKey: account.plan_key ?? null,
      subscriptionStatus: account.subscription_status ?? null,
      isManual: account.is_manual ?? false,
      _id: rejigUserId,
      snapshotDate: snapshotIso,
    },
    observedAt: snapshotDate,
    source,
  });

  const active = account.subscription_status === 'active' ? 1 : 0;
  rows.push({
    customerId,
    rejigUserId,
    signalType: SIGNAL_TYPES.REJIG_ACCOUNT_ACTIVE,
    signalValueNumeric: String(active),
    signalValueJsonb: {
      subscriptionStatus: account.subscription_status ?? null,
      isManual: account.is_manual ?? false,
      _id: rejigUserId,
      snapshotDate: snapshotIso,
    },
    observedAt: snapshotDate,
    source,
  });

  return rows;
}

export async function importRejigSnapshot(opts: RejigImportOptions): Promise<RejigImportSummary> {
  const t0 = Date.now();
  const { apply, limit = null } = opts;
  const log = opts.log ?? (() => {});

  log(`[import-rejig] mode=${apply ? 'APPLY' : 'DRY-RUN'} limit=${limit ?? 'none'}`);

  // 1. Fetch snapshot from live API
  const allAccounts = await fetchAccountsSnapshot();
  log(`[fetch] Fetched ${allAccounts.length} accounts from Rejig API`);

  // 2. Apply --limit
  const accounts = limit != null ? allAccounts.slice(0, limit) : allAccounts;
  if (limit != null) log(`[fetch] Limited to first ${accounts.length} accounts`);

  // 3. Build LP customer email → id map (case-insensitive, multi-id tracked)
  const lpCustomers = await db
    .select({
      id: customers.id,
      contactEmail: customers.contactEmail,
      platformEmail: customers.platformEmail,
    })
    .from(customers);
  log(`[identity] Loaded ${lpCustomers.length} LP customers`);

  const emailToIds = new Map<string, string[]>();
  function pushEmail(email: string | null | undefined, id: string) {
    if (!email) return;
    const key = email.trim().toLowerCase();
    if (!key) return;
    const arr = emailToIds.get(key) ?? [];
    if (!arr.includes(id)) arr.push(id);
    emailToIds.set(key, arr);
  }
  for (const c of lpCustomers) {
    pushEmail(c.contactEmail, c.id);
    pushEmail(c.platformEmail, c.id);
  }

  // 4. Identity match
  type Matched = { account: RejigAccount; customerId: string };
  type Unmatched = { account: RejigAccount };
  type Conflict = { account: RejigAccount; candidates: string[] };
  const matched: Matched[] = [];
  const unmatched: Unmatched[] = [];
  const conflicts: Conflict[] = [];

  for (const account of accounts) {
    const email = (account.email ?? '').trim().toLowerCase();
    if (!email) {
      unmatched.push({ account });
      continue;
    }
    const ids = emailToIds.get(email);
    if (!ids || ids.length === 0) unmatched.push({ account });
    else if (ids.length === 1) matched.push({ account, customerId: ids[0] });
    else conflicts.push({ account, candidates: ids });
  }
  log(
    `[identity] matched=${matched.length} unmatched=${unmatched.length} conflicts=${conflicts.length}`,
  );

  // 5. Build signal rows (snapshot_date = today, UTC day-floor)
  const now = new Date();
  const snapshotDate = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  log(`[build] snapshotDate=${snapshotDate.toISOString()}`);

  const allRows: SignalRow[] = [];
  for (const m of matched) {
    allRows.push(...buildSignalsForAccount({ account: m.account, customerId: m.customerId, snapshotDate }));
  }
  for (const u of unmatched) {
    allRows.push(...buildSignalsForAccount({ account: u.account, customerId: null, snapshotDate }));
  }
  for (const c of conflicts) {
    allRows.push(...buildSignalsForAccount({ account: c.account, customerId: null, snapshotDate }));
  }
  log(`[build] total signal rows: ${allRows.length}`);

  // 6. Idempotency check
  const matchedCustomerIds = matched.map((m) => m.customerId);
  const orphanRejigIds = [
    ...unmatched.map((u) => u.account._id),
    ...conflicts.map((c) => c.account._id),
  ];

  const existsKeys = new Set<string>();
  function existsKey(
    customerId: string | null,
    rejigUserId: string | null,
    signalType: string,
    observedAt: Date,
  ): string {
    const k = customerId ? `c:${customerId}` : `r:${rejigUserId ?? '_'}`;
    return `${k}|${signalType}|${observedAt.toISOString()}`;
  }

  if (matchedCustomerIds.length > 0) {
    const rows = await db
      .select({
        customerId: customerUsageSignals.customerId,
        rejigUserId: customerUsageSignals.rejigUserId,
        signalType: customerUsageSignals.signalType,
        observedAt: customerUsageSignals.observedAt,
      })
      .from(customerUsageSignals)
      .where(inArray(customerUsageSignals.customerId, matchedCustomerIds));
    for (const r of rows) {
      existsKeys.add(existsKey(r.customerId, r.rejigUserId, r.signalType, r.observedAt));
    }
  }
  if (orphanRejigIds.length > 0) {
    const rows = await db
      .select({
        customerId: customerUsageSignals.customerId,
        rejigUserId: customerUsageSignals.rejigUserId,
        signalType: customerUsageSignals.signalType,
        observedAt: customerUsageSignals.observedAt,
      })
      .from(customerUsageSignals)
      .where(
        and(
          isNull(customerUsageSignals.customerId),
          inArray(customerUsageSignals.rejigUserId, orphanRejigIds),
        ),
      );
    for (const r of rows) {
      existsKeys.add(existsKey(r.customerId, r.rejigUserId, r.signalType, r.observedAt));
    }
  }

  let signalsSkipped = 0;
  const toInsert: SignalRow[] = [];
  for (const r of allRows) {
    const key = existsKey(r.customerId, r.rejigUserId, r.signalType, r.observedAt);
    if (existsKeys.has(key)) signalsSkipped++;
    else toInsert.push(r);
  }
  log(`[idempotency] skipping ${signalsSkipped} existing rows; ${toInsert.length} new rows queued`);

  // 7. Data-quality regression detector (observability only)
  let regressionsDetected = 0;
  if (matchedCustomerIds.length > 0) {
    const priorPosts = await db
      .select({
        customerId: customerUsageSignals.customerId,
        signalValueNumeric: customerUsageSignals.signalValueNumeric,
        observedAt: customerUsageSignals.observedAt,
      })
      .from(customerUsageSignals)
      .where(
        and(
          eq(customerUsageSignals.signalType, SIGNAL_TYPES.REJIG_TOTAL_PUBLISHED_POSTS),
          inArray(customerUsageSignals.customerId, matchedCustomerIds),
        ),
      )
      .orderBy(desc(customerUsageSignals.observedAt));

    const latestPriorByCustomer = new Map<string, { value: number; observedAt: Date }>();
    for (const p of priorPosts) {
      if (!p.customerId) continue;
      if (p.observedAt.getTime() === snapshotDate.getTime()) continue;
      if (latestPriorByCustomer.has(p.customerId)) continue;
      const num = Number(p.signalValueNumeric ?? 0);
      latestPriorByCustomer.set(p.customerId, { value: num, observedAt: p.observedAt });
    }

    for (const m of matched) {
      const prior = latestPriorByCustomer.get(m.customerId);
      if (!prior) continue;
      const curr = m.account.post_metrics?.total_published ?? 0;
      if (curr < prior.value) {
        regressionsDetected++;
        log(
          `[DQ Anomaly] customer=${m.customerId} email=${m.account.email} _id=${m.account._id} ` +
            `posts ${prior.value} (${prior.observedAt.toISOString().slice(0, 10)}) → ${curr} ` +
            `(${snapshotDate.toISOString().slice(0, 10)}) Δ=${curr - prior.value}`,
        );
      }
    }
  }

  const conflictsSample = conflicts.slice(0, 20).map((c) => ({
    email: c.account.email,
    rejigId: c.account._id,
    candidateCustomerIds: c.candidates,
  }));

  // 8. Apply gate
  let signalsInserted = 0;
  let errorBatches = 0;
  if (apply) {
    log(`[apply] inserting ${toInsert.length} rows in batches of 100…`);
    const BATCH_SIZE = 100;
    for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
      const batch = toInsert.slice(i, i + BATCH_SIZE);
      try {
        await db.insert(customerUsageSignals).values(batch);
        signalsInserted += batch.length;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`[apply] batch ${i / BATCH_SIZE} failed: ${msg}`);
        errorBatches++;
      }
    }
  }

  return {
    durationMs: Date.now() - t0,
    mode: apply ? 'apply' : 'dry-run',
    accountsFetched: allAccounts.length,
    accountsProcessed: accounts.length,
    matched: matched.length,
    unmatched: unmatched.length,
    conflicts: conflicts.length,
    signalsBuilt: allRows.length,
    signalsToInsert: toInsert.length,
    signalsInserted,
    signalsSkipped,
    regressionsDetected,
    errorBatches,
    conflictsSample,
  };
}
