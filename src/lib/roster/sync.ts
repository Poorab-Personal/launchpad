/**
 * Roster sync engine.
 *
 * `syncBrokerage(brokerage)` runs one brokerage's full sync inside a single
 * `db.transaction` — UPSERT every fetched agent into `brokerage_roster`,
 * soft-delete agents missing from this fetch, bump `brokerages.last_roster_sync`,
 * and write one 'Roster Synced' row into `events`.
 *
 * `runAllActiveSyncs()` fans out to every active brokerage via
 * `Promise.allSettled` so one source outage never blocks another. Failures
 * are recorded as 'Roster Sync Failed' event rows (and a Resend alert is
 * the cron's job to send post-aggregation in Phase 2).
 *
 * Per docs/integrations/dmg-roster-plan.md §3.1 (UPSERT race rules) and §4.1
 * (sync flow).
 */
import { and, eq, isNotNull, lt, sql } from 'drizzle-orm';
import { db } from '@/db';
import * as schema from '@/db/schema';
import type { Brokerage } from '@/db/schema/brokerages';
import { dmgAdapter } from './sources/dmg';
import type {
  NormalizedRosterRow,
  RosterSourceAdapter,
  SourceConfig,
} from './types';

export interface SyncResult {
  brokerageId: string;
  brokerageSlug: string;
  sourceType: string;
  agentsTotal: number;        // agents returned by source (after agent+active filter)
  agentsUpserted: number;     // rows actually written via UPSERT
  agentsSoftDeleted: number;  // rows newly marked deleted_at this run
  durationMs: number;
}

export interface SyncFailure {
  brokerageId: string;
  brokerageSlug: string;
  sourceType: string;
  error: string;
  durationMs: number;
}

export interface SyncSummary {
  results: SyncResult[];
  failures: SyncFailure[];
}

// Adapter dispatch. One file per source under src/lib/roster/sources/.
// Adding a non-DMG source = add a case here + an enum value in
// src/db/schema/enums.ts (sourceTypeEnum).
function adapterFor(sourceType: string): RosterSourceAdapter {
  switch (sourceType) {
    case 'dmg':
      return dmgAdapter;
    default:
      throw new Error(`[roster sync] No adapter registered for source_type='${sourceType}'`);
  }
}

/**
 * Permissive "is this agent active?" check. The legacy GAS-era data was
 * lower-case 'active' / 'inactive', but we don't fully trust source-side
 * casing across brokerages. Treat anything that case-insensitively starts
 * with 'active' as active. Empty/null status passes (defensive — better to
 * import than to silently drop).
 */
function isActiveStatus(status: string | null | undefined): boolean {
  if (status == null) return true;
  return status.toLowerCase().startsWith('active');
}

function isAgentAccountType(accountType: string): boolean {
  // DMG returns 'agent' (lower-case); be permissive for cross-source safety.
  return accountType.toLowerCase() === 'agent';
}

/**
 * Bucket and log distinct statuses + account types we observed, so we have
 * a paper trail when a new brokerage joins and its statuses are unfamiliar.
 */
function logObservedShapes(
  brokerageSlug: string,
  rows: NormalizedRosterRow[],
): void {
  const accountTypeCounts = new Map<string, number>();
  const statusCounts = new Map<string, number>();
  for (const r of rows) {
    accountTypeCounts.set(r.accountType, (accountTypeCounts.get(r.accountType) ?? 0) + 1);
    const s = r.status ?? '(null)';
    statusCounts.set(s, (statusCounts.get(s) ?? 0) + 1);
  }
  console.log(
    `[roster sync] ${brokerageSlug}: observed account_types=${JSON.stringify(
      Object.fromEntries(accountTypeCounts),
    )} statuses=${JSON.stringify(Object.fromEntries(statusCounts))}`,
  );
}

export async function syncBrokerage(brokerage: Brokerage): Promise<SyncResult> {
  const t0 = Date.now();
  const brokerageSlug = brokerage.landingPageSlug;
  const sourceType = brokerage.sourceType;

  if (!brokerage.sourceConfig) {
    throw new Error(
      `[roster sync] brokerage ${brokerageSlug} (${brokerage.id}) has no source_config`,
    );
  }

  const adapter = adapterFor(sourceType);
  const config = brokerage.sourceConfig as SourceConfig;

  // ── Fetch (outside the tx — long-running, retries handled by adapter) ──
  const allRows = await adapter.fetchAll(config);
  logObservedShapes(brokerageSlug, allRows);

  // ── Filter to active agents (sync owns this, not the adapter — §4.1) ──
  const agents = allRows.filter(
    (r) => isAgentAccountType(r.accountType) && isActiveStatus(r.status),
  );

  // Capture sync start time AFTER the fetch but BEFORE any writes, so the
  // soft-delete sweep below correctly identifies "rows not touched this run"
  // even if a concurrent lookup-driven write lands mid-transaction.
  const syncStartedAt = new Date();

  let agentsUpserted = 0;
  let agentsSoftDeleted = 0;

  await db.transaction(async (tx) => {
    // ── UPSERT every agent (preserves customer_id, first_seen_at; clears
    //    deleted_at on re-appearance; never moves last_synced_at backwards).
    for (const row of agents) {
      const updated = await tx
        .insert(schema.brokerageRoster)
        .values({
          brokerageId: brokerage.id,
          sourceUserId: row.sourceUserId,
          accountType: row.accountType,
          status: row.status,
          displayName: row.displayName,
          firstName: row.firstName,
          lastName: row.lastName,
          publicEmail: row.publicEmail,
          privateEmail: row.privateEmail,
          cellPhone: row.cellPhone,
          website: row.website,
          license: row.license,
          photoUrl: row.photoUrl,
          bio: row.bio,
          mlsIds: row.mlsIds,
          primaryOfficeId: row.primaryOfficeId,
          officeName: row.officeName,
          sourceData: row.sourceData,
          sourceSchemaVersion: row.sourceSchemaVersion,
          lastSyncedAt: syncStartedAt,
          // `firstSeenAt` defaults to now() on INSERT and is preserved on
          // UPDATE (see DO UPDATE SET clause below — not touched).
          // `customerId` and `deletedAt` similarly handled in DO UPDATE.
        })
        .onConflictDoUpdate({
          target: [
            schema.brokerageRoster.brokerageId,
            schema.brokerageRoster.sourceUserId,
          ],
          set: {
            // Refresh all source-driven columns from the incoming row.
            accountType: sql`EXCLUDED.account_type`,
            status: sql`EXCLUDED.status`,
            displayName: sql`EXCLUDED.display_name`,
            firstName: sql`EXCLUDED.first_name`,
            lastName: sql`EXCLUDED.last_name`,
            publicEmail: sql`EXCLUDED.public_email`,
            privateEmail: sql`EXCLUDED.private_email`,
            cellPhone: sql`EXCLUDED.cell_phone`,
            website: sql`EXCLUDED.website`,
            license: sql`EXCLUDED.license`,
            photoUrl: sql`EXCLUDED.photo_url`,
            bio: sql`EXCLUDED.bio`,
            mlsIds: sql`EXCLUDED.mls_ids`,
            primaryOfficeId: sql`EXCLUDED.primary_office_id`,
            officeName: sql`EXCLUDED.office_name`,
            sourceData: sql`EXCLUDED.source_data`,
            sourceSchemaVersion: sql`EXCLUDED.source_schema_version`,
            // Never move last_synced_at backwards — protects against a
            // concurrent lookup write that already touched this row with a
            // later timestamp.
            lastSyncedAt: sql`GREATEST(${schema.brokerageRoster.lastSyncedAt}, EXCLUDED.last_synced_at)`,
            // Clear soft-delete tombstone — agent re-appeared in the roster.
            deletedAt: sql`NULL`,
            // customer_id and first_seen_at deliberately NOT in the SET
            // clause — preserved on UPDATE per plan §3.1.
          },
        })
        .returning({ id: schema.brokerageRoster.id });

      if (updated.length > 0) agentsUpserted++;
    }

    // ── Soft-delete sweep: anything not touched this run.
    //    `last_synced_at < syncStartedAt` is the "stale" predicate. Rows
    //    touched in the loop above have last_synced_at = syncStartedAt
    //    (or later, thanks to GREATEST), so they're excluded.
    const softDeleted = await tx
      .update(schema.brokerageRoster)
      .set({ deletedAt: sql`now()` })
      .where(
        and(
          eq(schema.brokerageRoster.brokerageId, brokerage.id),
          lt(schema.brokerageRoster.lastSyncedAt, syncStartedAt),
          sql`${schema.brokerageRoster.deletedAt} IS NULL`,
        ),
      )
      .returning({ id: schema.brokerageRoster.id });
    agentsSoftDeleted = softDeleted.length;

    // ── Stamp the brokerage row's last_roster_sync.
    await tx
      .update(schema.brokerages)
      .set({ lastRosterSync: sql`now()` })
      .where(eq(schema.brokerages.id, brokerage.id));

    // ── Audit event (one row per brokerage per run).
    const durationMs = Date.now() - t0;
    await tx.insert(schema.events).values({
      customerId: null,
      eventType: 'Roster Synced',
      actorType: 'System',
      details: {
        brokerageId: brokerage.id,
        brokerageSlug,
        sourceType,
        agentsTotal: agents.length,
        agentsUpserted,
        agentsSoftDeleted,
        durationMs,
      },
    });
  });

  return {
    brokerageId: brokerage.id,
    brokerageSlug,
    sourceType,
    agentsTotal: agents.length,
    agentsUpserted,
    agentsSoftDeleted,
    durationMs: Date.now() - t0,
  };
}

/**
 * Fan out to every active brokerage with a source_type configured.
 *
 * `Promise.allSettled` so one brokerage's outage doesn't block another. Each
 * rejection is recorded as a 'Roster Sync Failed' event row (BEST-EFFORT —
 * if THAT insert fails too, we still surface the failure in the returned
 * summary so the cron handler / CLI can email alerts).
 *
 * Does NOT throw. The caller (Phase 2 cron route) decides what to do with a
 * non-empty `failures` list.
 */
export async function runAllActiveSyncs(): Promise<SyncSummary> {
  const brokeragesToSync = await db
    .select()
    .from(schema.brokerages)
    .where(
      and(
        eq(schema.brokerages.active, true),
        isNotNull(schema.brokerages.sourceType),
      ),
    );

  const settled = await Promise.allSettled(
    brokeragesToSync.map((b) => syncBrokerage(b)),
  );

  const results: SyncResult[] = [];
  const failures: SyncFailure[] = [];

  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    const b = brokeragesToSync[i];

    if (outcome.status === 'fulfilled') {
      results.push(outcome.value);
      continue;
    }

    const errMsg =
      outcome.reason instanceof Error
        ? outcome.reason.stack ?? outcome.reason.message
        : String(outcome.reason);

    const failure: SyncFailure = {
      brokerageId: b.id,
      brokerageSlug: b.landingPageSlug,
      sourceType: b.sourceType,
      error: errMsg,
      // We don't have per-failure t0 here; the rejected promise already
      // tracked its own duration in syncBrokerage's catch path if it got
      // far enough. Report 0 to signal "unknown" rather than mislead.
      durationMs: 0,
    };
    failures.push(failure);

    // Best-effort failure event. Wrapped in try/catch so a DB-level outage
    // doesn't escape this aggregator — the failure is already surfaced in
    // the returned `failures` array.
    try {
      await db.insert(schema.events).values({
        customerId: null,
        eventType: 'Roster Sync Failed',
        actorType: 'System',
        details: {
          brokerageId: b.id,
          brokerageSlug: b.landingPageSlug,
          sourceType: b.sourceType,
          error: errMsg,
        },
      });
    } catch (logErr) {
      console.error(
        '[roster sync] failed to write Roster Sync Failed event',
        { brokerageId: b.id, originalError: errMsg, logErr },
      );
    }
  }

  return { results, failures };
}
