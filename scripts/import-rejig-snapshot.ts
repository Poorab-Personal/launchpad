/**
 * Import a Rejig accounts snapshot into customer_usage_signals.
 *
 * API-only (no file mode per Pass 2.7 §29.1). Calls
 * src/lib/integrations/rejig/client.ts fetchAccountsSnapshot() which
 * hits the live API at ${REJIG_API_URL}/dashboard/admin/account-list
 * using the X-Service-API-Key header.
 *
 * Idempotent: re-running the script doesn't duplicate signals. Uniqueness
 * is checked pre-insert via (customer_id OR rejig_user_id, signal_type,
 * observed_at) — there is no UNIQUE constraint on the table, so we pre-query.
 *
 * Identity mapping (Pass 2 §6.2 + Pass 2.7 §29.1):
 *   - Rejig.email → LP customer via case-insensitive contactEmail (then
 *     platformEmail fallback) match. LP customers don't have rejigAccountId
 *     yet — that's Phase 6 backfill.
 *   - Unmatched Rejig rows insert with customer_id=NULL + rejig_user_id=_id
 *     (orphan signals; Phase 6 mapping will associate later).
 *   - Multiple LP customers with the same email → logged to a conflicts
 *     array printed in the summary; rows are NOT silently picked.
 *
 * Data-quality detector: for each customer matched against a prior snapshot,
 * detect post-count regressions (lifetime posts only grow). Pass 2.7 §29.4
 * makes this observability-only — NO BI gating. The data_quality_events
 * table doesn't exist yet (Phase 4c setup); for v1 of this importer, log
 * to console and skip the DB insert with a TODO.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/import-rejig-snapshot.ts [--apply] [--limit N]
 *
 * Default: dry-run (no DB writes). Prints summary of what would be inserted.
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../src/db';
import { customers } from '../src/db/schema/customers';
import { customerUsageSignals } from '../src/db/schema/customerUsageSignals';
import { SIGNAL_SOURCES, SIGNAL_TYPES } from '../src/lib/bi/signal-types';
import type { RejigAccount } from '../src/lib/integrations/rejig/client';

// ──────────────────────────────────────────────────────────────────────────
// CLI args
// ──────────────────────────────────────────────────────────────────────────
function parseArgs(argv: string[]): { apply: boolean; limit: number | null } {
  let apply = false;
  let limit: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') apply = true;
    else if (arg === '--limit') {
      const next = argv[i + 1];
      if (next && /^\d+$/.test(next)) {
        limit = Number(next);
        i++;
      }
    } else if (arg.startsWith('--limit=')) {
      const v = arg.split('=')[1];
      if (/^\d+$/.test(v)) limit = Number(v);
    }
  }
  return { apply, limit };
}

// ──────────────────────────────────────────────────────────────────────────
// Signal row builder
// ──────────────────────────────────────────────────────────────────────────
type SignalRow = {
  customerId: string | null;
  rejigUserId: string | null;
  signalType: string;
  signalValueNumeric: string | null;
  signalValueJsonb: Record<string, unknown>;
  observedAt: Date;
  source: string;
};

/**
 * For a single Rejig account, build the 6 signal rows it produces.
 *
 * Per Pass 2.6 §21.3:
 *  - `observed_at = snapshotDate` for all derived signals EXCEPT
 *    `rejig.last_login` which uses the actual `lastLogin` timestamp (or
 *    snapshotDate as fallback when the customer has never logged in).
 *  - Every signal_value_jsonb carries `_id` so cross-snapshot joins can
 *    dedupe on the Mongo authoritative id.
 */
function buildSignalsForAccount(args: {
  account: RejigAccount;
  customerId: string | null;
  snapshotDate: Date;
}): SignalRow[] {
  const { account, customerId, snapshotDate } = args;
  const rejigUserId = account._id;
  const source = SIGNAL_SOURCES.REJIG_API;
  const snapshotIso = snapshotDate.toISOString().slice(0, 10); // YYYY-MM-DD

  const rows: SignalRow[] = [];

  // (a) rejig.last_login
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

  // (b) rejig.days_since_last_post
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

  // (c) rejig.total_published_posts
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

  // (d) rejig.listing_count
  rows.push({
    customerId,
    rejigUserId,
    signalType: SIGNAL_TYPES.REJIG_LISTING_COUNT,
    signalValueNumeric: String(account.listing_count ?? 0),
    signalValueJsonb: { _id: rejigUserId, snapshotDate: snapshotIso },
    observedAt: snapshotDate,
    source,
  });

  // (e) rejig.days_until_expiry
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

  // (f) rejig.account_active
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

// ──────────────────────────────────────────────────────────────────────────
// main
// ──────────────────────────────────────────────────────────────────────────
async function main() {
  const { apply, limit } = parseArgs(process.argv.slice(2));
  console.log(`[import-rejig-snapshot] mode=${apply ? 'APPLY' : 'DRY-RUN'} limit=${limit ?? 'none'}`);

  // 1. Fetch snapshot from live API
  const { fetchAccountsSnapshot } = await import('../src/lib/integrations/rejig/client');
  const allAccounts = await fetchAccountsSnapshot();
  console.log(`[fetch] Fetched ${allAccounts.length} accounts from Rejig API`);

  // 2. Apply --limit
  const accounts = limit != null ? allAccounts.slice(0, limit) : allAccounts;
  if (limit != null) console.log(`[fetch] Limited to first ${accounts.length} accounts`);

  // 3. Build LP customer email → id map (case-insensitive). Track dupes.
  const lpCustomers = await db
    .select({
      id: customers.id,
      contactEmail: customers.contactEmail,
      platformEmail: customers.platformEmail,
    })
    .from(customers);
  console.log(`[identity] Loaded ${lpCustomers.length} LP customers`);

  const emailToIds = new Map<string, string[]>(); // normalized email → [customer.id, ...]
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

  // 4. Identity match for each account
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
    if (!ids || ids.length === 0) {
      unmatched.push({ account });
    } else if (ids.length === 1) {
      matched.push({ account, customerId: ids[0] });
    } else {
      conflicts.push({ account, candidates: ids });
    }
  }

  console.log(
    `[identity] matched=${matched.length} unmatched=${unmatched.length} conflicts=${conflicts.length}`,
  );
  if (conflicts.length > 0) {
    console.log('[identity] conflicts (NOT auto-resolved):');
    for (const c of conflicts.slice(0, 20)) {
      console.log(
        `  - ${c.account.email} (_id=${c.account._id}) → ${c.candidates.length} LP customers: ${c.candidates.join(', ')}`,
      );
    }
    if (conflicts.length > 20) console.log(`  ... and ${conflicts.length - 20} more`);
  }

  // 5. Build signal rows.
  // Per Pass 2.6 §21.3: snapshot_date = today (UTC, day-only floor).
  const now = new Date();
  const snapshotDate = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  console.log(`[build] snapshotDate=${snapshotDate.toISOString()}`);

  const allRows: SignalRow[] = [];
  for (const m of matched) {
    allRows.push(
      ...buildSignalsForAccount({
        account: m.account,
        customerId: m.customerId,
        snapshotDate,
      }),
    );
  }
  for (const u of unmatched) {
    allRows.push(
      ...buildSignalsForAccount({
        account: u.account,
        customerId: null,
        snapshotDate,
      }),
    );
  }
  // Conflicts → orphan signal rows (rejig_user_id only, customer_id NULL)
  // so the data isn't lost; Phase 6 dedup can re-associate after admin
  // resolves the dupe LP rows.
  for (const c of conflicts) {
    allRows.push(
      ...buildSignalsForAccount({
        account: c.account,
        customerId: null,
        snapshotDate,
      }),
    );
  }

  // Tally per signal_type for the summary
  const perType: Record<string, { total: number; nullNumeric: number }> = {};
  for (const r of allRows) {
    const entry = perType[r.signalType] ?? { total: 0, nullNumeric: 0 };
    entry.total++;
    if (r.signalValueNumeric === null) entry.nullNumeric++;
    perType[r.signalType] = entry;
  }
  console.log('[build] signal rows per type:');
  for (const [t, c] of Object.entries(perType)) {
    console.log(`  ${t}: total=${c.total} nullNumeric=${c.nullNumeric}`);
  }
  console.log(`[build] total signal rows: ${allRows.length}`);

  // 6. Idempotency check — query existing rows per (key, signal_type, observed_at).
  // Cheaper to do per-signal-type in batch: for each type, fetch existing
  // (customer_id|rejig_user_id, observed_at) tuples that are referenced by
  // any of our incoming rows and the observed_at falls on the snapshot
  // window OR within 1 day of the row's observed_at. For simplicity we
  // fetch ALL rows for the matched customer ids + rejig_user_ids of
  // referenced accounts, then filter in JS by exact (key, type, observed_at).
  console.log('[idempotency] checking for existing rows…');
  const matchedCustomerIds = matched.map((m) => m.customerId);
  const orphanRejigIds = [
    ...unmatched.map((u) => u.account._id),
    ...conflicts.map((c) => c.account._id),
  ];

  // Build a set of "exists" keys: `${customer_id|rejig_user_id}|${type}|${observed_at_iso}`
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
    if (existsKeys.has(key)) {
      signalsSkipped++;
    } else {
      toInsert.push(r);
    }
  }
  console.log(
    `[idempotency] would skip ${signalsSkipped} existing rows; ${toInsert.length} new rows queued`,
  );

  // 7. Data-quality regression detector — for each matched customer,
  // compare incoming total_published_posts to the prior signal of that type.
  // Per Pass 2.7 §29.4: observability only. Log to console; data_quality_events
  // table is Phase 4c.
  let regressionsDetected = 0;
  if (matchedCustomerIds.length > 0) {
    // Fetch the latest prior total_published_posts for each matched customer.
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

    // Pick most recent per customer (skipping rows whose observed_at equals
    // the snapshot we're about to write — those are this-run rows in --apply
    // re-runs, irrelevant to regression detection).
    const latestPriorByCustomer = new Map<
      string,
      { value: number; observedAt: Date }
    >();
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
        console.log(
          `[DQ Anomaly] customer=${m.customerId} email=${m.account.email} _id=${m.account._id} ` +
            `posts ${prior.value} (${prior.observedAt.toISOString().slice(0, 10)}) → ${curr} ` +
            `(${snapshotDate.toISOString().slice(0, 10)}) Δ=${curr - prior.value}`,
        );
        // TODO: insert into data_quality_events table once it exists (Phase 4c).
      }
    }
  }

  // 8. --apply gate
  let signalsInserted = 0;
  const errors: Array<{ msg: string }> = [];
  if (!apply) {
    console.log('');
    console.log('[summary] DRY-RUN (no DB writes). Pass --apply to commit.');
    console.log(
      JSON.stringify(
        {
          accountsFetched: allAccounts.length,
          accountsProcessed: accounts.length,
          matched: matched.length,
          unmatched: unmatched.length,
          conflicts: conflicts.length,
          signalsToInsert: toInsert.length,
          signalsSkipped,
          regressionsDetected,
        },
        null,
        2,
      ),
    );
    return;
  }

  // Batch insert (100 rows per batch). Each batch is its own statement; we
  // don't wrap in one big transaction because partial progress is acceptable
  // for an idempotent re-runnable import.
  console.log(`[apply] inserting ${toInsert.length} rows in batches of 100…`);
  const BATCH_SIZE = 100;
  for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
    const batch = toInsert.slice(i, i + BATCH_SIZE);
    try {
      await db.insert(customerUsageSignals).values(batch);
      signalsInserted += batch.length;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[apply] batch ${i / BATCH_SIZE} failed: ${msg}`);
      errors.push({ msg });
    }
  }

  console.log('');
  console.log('[summary] APPLY complete.');
  console.log(
    JSON.stringify(
      {
        accountsFetched: allAccounts.length,
        accountsProcessed: accounts.length,
        matched: matched.length,
        unmatched: unmatched.length,
        conflicts: conflicts.length,
        signalsInserted,
        signalsSkipped,
        regressionsDetected,
        errors: errors.length,
      },
      null,
      2,
    ),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
