/**
 * Layer 2 — Posting trajectory job.
 *
 * Two exports:
 *   - detectTrajectoryPattern: pure function. Classifies a velocity-history
 *     series into one of 9 patterns via a cycle-counting state machine over
 *     ↓ → ↑ transitions. Confidence graduated by N (low / medium / high).
 *     NO snapshot-count gating per Pass 2.7 §29.2 — fires on whatever data
 *     exists, downgrades confidence rather than blocking.
 *
 *   - computeTrajectoriesForAllCustomers: top-level job, runs after each
 *     snapshot ingestion. For every non-Cancelled customer:
 *       1. Reads the last 6 `rejig.total_published_posts` signals.
 *       2. Computes post_velocity_7d = Δposts / Δdays between adjacent
 *          observed_at timestamps.
 *       3. Reads the last 6 `rejig.last_login` signals (same window) for
 *          loginHistory context inside the snapshot.
 *       4. Calls detectTrajectoryPattern → TrajectorySnapshot.
 *       5. Inserts a single `derived.posting_trajectory` row into
 *          `customer_usage_signals` with source='lp_trajectory_job'.
 *
 * Pass 2.5 §12.4 + Pass 2.7 §29.2.
 */
import { and, desc, eq, ne } from 'drizzle-orm';
import { db } from '@/db';
import { customers } from '@/db/schema/customers';
import { customerUsageSignals } from '@/db/schema/customerUsageSignals';
import { SIGNAL_SOURCES, SIGNAL_TYPES } from './signal-types';
import { TRAJECTORY_THRESHOLDS_V1 } from './thresholds';
import type {
  TrajectoryConfidence,
  TrajectoryPattern,
  TrajectorySnapshot,
} from './types';

type Transition = 'up' | 'down' | 'flat';

function countTrailingDeclines(transitions: Transition[]): number {
  let count = 0;
  for (let k = transitions.length - 1; k >= 0; k--) {
    if (transitions[k] === 'down') count++;
    else break;
  }
  return count;
}

/**
 * Pure pattern detector. Returns a TrajectorySnapshot for the caller to
 * either persist (snapshot-importer post-pass) or use directly (BiContext
 * builder).
 *
 * Per Pass 2.7 §29.2: NO snapshot-count gate. Pattern detection runs on
 * whatever data is available. Confidence is downgraded for low-N runs but
 * firing isn't blocked.
 *
 * Pure function — no DB I/O. Pass in the velocity + login history arrays
 * (most-recent LAST) and it returns the snapshot.
 */
export function detectTrajectoryPattern(args: {
  velocityHistory: number[];
  loginHistory: number[];
  observedAts: Date[];
}): TrajectorySnapshot {
  const { velocityHistory, loginHistory, observedAts } = args;
  const N = velocityHistory.length;

  // === N=0: nothing to classify ===
  if (N === 0) {
    return {
      pattern: 'insufficient_data',
      cyclesObserved: 0,
      currentPhase: 'flat',
      velocityHistory: [],
      loginHistory: [],
      snapshotsEvaluated: 0,
      firstDeclineObservedAt: null,
      lastRecoveryObservedAt: null,
      confidence: 'low',
    };
  }

  // === N=1: single point — no transitions exist ===
  if (N === 1) {
    return {
      pattern: 'insufficient_data',
      cyclesObserved: 0,
      currentPhase: 'flat',
      velocityHistory,
      loginHistory,
      snapshotsEvaluated: 1,
      firstDeclineObservedAt: null,
      lastRecoveryObservedAt: null,
      confidence: 'low',
    };
  }

  // === N>=2: classify each adjacent pair as ↑ / ↓ / = ===
  const T = TRAJECTORY_THRESHOLDS_V1;
  const transitions: Transition[] = [];
  for (let i = 1; i < N; i++) {
    const prev = velocityHistory[i - 1];
    const curr = velocityHistory[i];
    if (prev === 0) {
      // Zero baseline — any non-zero is "up"; zero-to-zero is flat.
      if (curr > 0) transitions.push('up');
      else transitions.push('flat');
    } else {
      const deltaPct = ((curr - prev) / Math.abs(prev)) * 100;
      if (deltaPct >= T.velocity_delta_up_pct) transitions.push('up');
      else if (deltaPct <= -T.velocity_delta_down_pct) transitions.push('down');
      else transitions.push('flat');
    }
  }

  // === Count ↓→↑ cycle pairs ("peter-out then return") ===
  let cycles = 0;
  let firstDeclineIdx = -1;
  let lastRecoveryIdx = -1;
  let i = 0;
  while (i < transitions.length) {
    if (transitions[i] === 'down') {
      if (firstDeclineIdx === -1) firstDeclineIdx = i;
      // Look ahead for the next 'up' transition.
      let j = i + 1;
      while (j < transitions.length && transitions[j] !== 'up') j++;
      if (j < transitions.length) {
        cycles++;
        lastRecoveryIdx = j;
        i = j + 1;
        continue;
      }
    }
    i++;
  }

  // === Current direction (last non-flat transition) ===
  let currentPhase: TrajectorySnapshot['currentPhase'] = 'flat';
  for (let k = transitions.length - 1; k >= 0; k--) {
    if (transitions[k] !== 'flat') {
      currentPhase = transitions[k] === 'up' ? 'rising' : 'declining';
      break;
    }
  }

  // === Classify pattern based on cycle count + current direction ===
  let pattern: TrajectoryPattern;
  if (cycles >= 4) {
    pattern = 'oscillating_4plus';
  } else if (cycles === 3) {
    pattern = 'oscillating_3';
  } else if (cycles === 2) {
    pattern = 'oscillating_2';
  } else if (cycles === 1 && currentPhase === 'rising') {
    pattern = 'recovering';
  } else if (cycles === 0) {
    if (currentPhase === 'rising') {
      pattern = 'ramping';
    } else if (currentPhase === 'declining') {
      const consecutiveDeclines = countTrailingDeclines(transitions);
      pattern = consecutiveDeclines >= 3 ? 'terminally_declining' : 'declining';
    } else {
      pattern = 'steady';
    }
  } else {
    // cycles===1 with non-rising current phase falls through to steady.
    pattern = 'steady';
  }

  // === Confidence (Pass 2.7 §26) ===
  //   N <= 1   -> low (handled above)
  //   N 2 or 3 -> medium
  //   N >= 4   -> high
  const confidence: TrajectoryConfidence = N >= 4 ? 'high' : N >= 2 ? 'medium' : 'low';

  // Observed-at indices map to transitions, which start at velocity index 1.
  // firstDeclineIdx/lastRecoveryIdx are positions inside `transitions` — we
  // anchor them to the "current" velocity sample (i+1 in the original series),
  // which corresponds to observedAts[transitionIdx + 1].
  const firstDeclineObservedAt =
    firstDeclineIdx >= 0 ? observedAts[firstDeclineIdx + 1]?.toISOString() ?? null : null;
  const lastRecoveryObservedAt =
    lastRecoveryIdx >= 0 ? observedAts[lastRecoveryIdx + 1]?.toISOString() ?? null : null;

  return {
    pattern,
    cyclesObserved: cycles,
    currentPhase,
    velocityHistory,
    loginHistory,
    snapshotsEvaluated: N,
    firstDeclineObservedAt,
    lastRecoveryObservedAt,
    confidence,
  };
}

const SNAPSHOT_HISTORY_LIMIT = 6;
const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * Read the last N rows of a given signal type for one customer in
 * chronological order (oldest first).
 */
async function readSignalHistory(args: {
  customerId: string;
  signalType: string;
  limit: number;
}) {
  const rows = await db
    .select({
      observedAt: customerUsageSignals.observedAt,
      signalValueNumeric: customerUsageSignals.signalValueNumeric,
    })
    .from(customerUsageSignals)
    .where(
      and(
        eq(customerUsageSignals.customerId, args.customerId),
        eq(customerUsageSignals.signalType, args.signalType),
      ),
    )
    .orderBy(desc(customerUsageSignals.observedAt))
    .limit(args.limit);

  // Reverse to chronological (oldest first / most-recent LAST).
  return rows.reverse();
}

/**
 * Top-level trajectory job — runs after each snapshot ingestion (Phase 5
 * file import OR Phase 9 live cron).
 *
 * For each active customer:
 *   1. Pull the last 6 snapshots of rejig.total_published_posts +
 *      rejig.last_login signals.
 *   2. Compute post_velocity_7d series: (posts[i] - posts[i-1]) /
 *      days_between(observed_at[i], observed_at[i-1]).
 *   3. Call detectTrajectoryPattern → TrajectorySnapshot.
 *   4. Insert into customer_usage_signals as type=`derived.posting_trajectory`
 *      with signal_value_jsonb = snapshot + signal_value_numeric = cycles_observed,
 *      source='lp_trajectory_job', observed_at=NOW().
 *
 * Idempotent in pattern + cycles (deterministic given the same source data);
 * observed_at uses NOW() so each run appends a fresh row.
 */
export async function computeTrajectoriesForAllCustomers(): Promise<{
  customersProcessed: number;
  trajectoriesWritten: number;
  errors: Array<{ customerId: string; error: string }>;
}> {
  // Active customers: anyone whose subscription isn't Cancelled. Pre-launch
  // customers (subscriptionStatus === null) are eligible because they may
  // still have historical signal rows worth classifying; the snapshot will
  // simply land as 'insufficient_data' if no posts signals exist yet.
  const activeCustomers = await db
    .select({
      id: customers.id,
      rejigUserId: customers.rejigUserId,
    })
    .from(customers)
    .where(ne(customers.subscriptionStatus, 'Cancelled'));

  let customersProcessed = 0;
  let trajectoriesWritten = 0;
  const errors: Array<{ customerId: string; error: string }> = [];

  for (const customer of activeCustomers) {
    customersProcessed++;
    try {
      // === Pull histories (chronological, oldest first) ===
      const postsRows = await readSignalHistory({
        customerId: customer.id,
        signalType: SIGNAL_TYPES.REJIG_TOTAL_PUBLISHED_POSTS,
        limit: SNAPSHOT_HISTORY_LIMIT,
      });
      const loginRows = await readSignalHistory({
        customerId: customer.id,
        signalType: SIGNAL_TYPES.REJIG_LAST_LOGIN,
        limit: SNAPSHOT_HISTORY_LIMIT,
      });

      // === Compute velocity series ===
      // velocity[i] corresponds to the transition from postsRows[i-1] to
      // postsRows[i]; we anchor it to observedAts[i] (the newer sample).
      const velocityHistory: number[] = [];
      const observedAts: Date[] = [];
      for (let i = 0; i < postsRows.length; i++) {
        const row = postsRows[i];
        if (i === 0) {
          // No prior point — emit a baseline 0 velocity anchored to this
          // observed_at so the snapshot has a synced (velocity, observedAt)
          // pair for downstream callers. Pattern detector skips the first
          // pair internally because N=1 → insufficient_data.
          velocityHistory.push(0);
          observedAts.push(row.observedAt);
          continue;
        }
        const prev = postsRows[i - 1];
        const currVal = Number(row.signalValueNumeric ?? 0);
        const prevVal = Number(prev.signalValueNumeric ?? 0);
        const deltaDays = Math.max(
          (row.observedAt.getTime() - prev.observedAt.getTime()) / MS_PER_DAY,
          1 / 24, // floor at 1 hour to avoid divide-by-zero on same-instant snapshots
        );
        const velocity = (currVal - prevVal) / deltaDays;
        velocityHistory.push(velocity);
        observedAts.push(row.observedAt);
      }

      // loginHistory is a parallel numeric series aligned by observed_at
      // index. For windows where login + posts snapshots aren't perfectly
      // 1:1, we just take the chronological login values; the BI callers
      // use loginHistory as context, not as a primary driver.
      const loginHistory = loginRows.map((r) => Number(r.signalValueNumeric ?? 0));

      // === Classify ===
      const snapshot = detectTrajectoryPattern({
        velocityHistory,
        loginHistory,
        observedAts,
      });

      // === Persist as derived.posting_trajectory ===
      await db.insert(customerUsageSignals).values({
        customerId: customer.id,
        rejigUserId: customer.rejigUserId ?? null,
        signalType: SIGNAL_TYPES.DERIVED_POSTING_TRAJECTORY,
        signalValueNumeric: String(snapshot.cyclesObserved),
        signalValueJsonb: snapshot,
        observedAt: new Date(),
        source: SIGNAL_SOURCES.LP_TRAJECTORY_JOB,
      });
      trajectoriesWritten++;
    } catch (err) {
      errors.push({
        customerId: customer.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { customersProcessed, trajectoriesWritten, errors };
}
