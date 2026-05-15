/**
 * Layer 3 — Predicted Outcome.
 *
 * Combinatorial rules over (Layer 1 profile, Layer 2 trajectory, Stripe
 * payment state, subscription status, tenure) that map a customer into
 * ONE of 6 outcome buckets:
 *   - likely_renew
 *   - likely_renew_after_intervention
 *   - likely_churn_in_60d
 *   - likely_churn_in_30d
 *   - near_certain_churn
 *   - unknown
 *
 * First-match-wins, ordered by severity DESCENDING (most-severe rules
 * evaluated first, so they win when multiple match). Each prediction
 * carries a confidence (low | medium | high) and a `reasoning[]` array
 * of human-readable predicates that fired — emitted into the audit log
 * by the BI cron handler.
 *
 * V1 is rule-based; the `OutcomePredictor` interface lets Phase 9+ swap
 * in a trained-model predictor without touching the cron handler.
 *
 * Sources:
 *   - Pass 2.5 §13.1 (taxonomy) and §13.2 (per-outcome rule definitions).
 *   - Pass 2.7 §29.3: Intercom unresolved-threads predicate (Pass 2.6 §23.3)
 *     is DEFERRED to Phase 4.5 — not implemented here.
 *   - TIME_WINDOWS thresholds: src/lib/bi/thresholds.ts.
 */

import type {
  BiContext,
  EngagementProfile,
  OutcomeConfidence,
  OutcomePrediction,
  PredictedOutcome,
  TrajectoryPattern,
  TrajectorySnapshot,
} from './types';
import { TIME_WINDOWS } from './thresholds';

/**
 * Pluggable predictor interface — Phase 9+ can swap deterministic rules
 * for a trained model without changing the cron handler.
 */
export interface OutcomePredictor {
  predict(args: {
    profile: EngagementProfile;
    trajectory: TrajectorySnapshot;
    ctx: BiContext;
  }): OutcomePrediction;
}

// === Helpers ===

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysAgo(date: Date | null, now: Date): number | null {
  if (!date) return null;
  return Math.floor((now.getTime() - date.getTime()) / MS_PER_DAY);
}

/**
 * Recent payment_failed = a `lastPaymentFailedAt` within the window AND
 * no subsequent `lastPaymentSucceededAt` recovery. This mirrors Pass 2.5
 * §13.2 — a succeeded payment after the failure clears the signal.
 */
function hasUnresolvedRecentPaymentFailure(ctx: BiContext, now: Date): boolean {
  const failedAt = ctx.signals.stripe.lastPaymentFailedAt;
  if (!failedAt) return false;
  const daysSinceFailure = daysAgo(failedAt, now);
  if (daysSinceFailure === null) return false;
  if (daysSinceFailure > TIME_WINDOWS.payment_failed_window_days) return false;
  const succeededAt = ctx.signals.stripe.lastPaymentSucceededAt;
  if (succeededAt && succeededAt.getTime() > failedAt.getTime()) return false;
  return true;
}

// === V1 Rule-based predictor ===

/**
 * Outcome buckets, ordered most-severe → least-severe. First match wins.
 *
 * Each rule returns either an `OutcomePrediction` (rule fired) or `null`
 * (rule did not fire). The first non-null return is emitted; if every
 * rule returns null we fall through to `unknown`.
 */
type Rule = (args: {
  profile: EngagementProfile;
  trajectory: TrajectorySnapshot;
  ctx: BiContext;
  now: Date;
}) => OutcomePrediction | null;

// --- Rule 1: near_certain_churn (Pass 2.5 §13.2) ---
const ruleNearCertainChurn: Rule = ({ profile, trajectory, ctx }) => {
  const reasoning: string[] = [];
  let fired = false;

  if (trajectory.pattern === 'oscillating_4plus') {
    reasoning.push("trajectory.pattern='oscillating_4plus'");
    fired = true;
  }

  const daysUntilExpiry = ctx.signals.rejig.daysUntilExpiry;
  if (
    ctx.subscriptionStatus === 'Cancelled' &&
    daysUntilExpiry !== null &&
    daysUntilExpiry <= 14
  ) {
    reasoning.push("subscriptionStatus='Cancelled'", `daysUntilExpiry=${daysUntilExpiry} <= 14`);
    fired = true;
  }

  if (
    profile === 'paying_but_absent' &&
    ctx.tenureDays >= TIME_WINDOWS.paying_but_absent_churn_tenure_days
  ) {
    reasoning.push(
      "profile='paying_but_absent'",
      `tenureDays=${ctx.tenureDays} >= ${TIME_WINDOWS.paying_but_absent_churn_tenure_days}`,
    );
    fired = true;
  }

  if (!fired) return null;
  return { outcome: 'near_certain_churn', confidence: 'high', reasoning };
};

// --- Rule 2: likely_churn_in_30d (Pass 2.5 §13.2) ---
const ruleChurn30d: Rule = ({ trajectory, ctx, now }) => {
  const reasoning: string[] = [];
  let fired = false;

  if (hasUnresolvedRecentPaymentFailure(ctx, now)) {
    const days = daysAgo(ctx.signals.stripe.lastPaymentFailedAt, now);
    reasoning.push(
      `stripe.lastPaymentFailedAt within last ${TIME_WINDOWS.payment_failed_window_days}d (${days}d ago)`,
      'no subsequent lastPaymentSucceededAt',
    );
    fired = true;
  }

  if (trajectory.pattern === 'terminally_declining') {
    reasoning.push("trajectory.pattern='terminally_declining'");
    fired = true;
  }

  if (ctx.signals.stripe.lastSubscriptionStatus === 'past_due') {
    reasoning.push("stripe.lastSubscriptionStatus='past_due'");
    fired = true;
  }

  if (!fired) return null;
  return { outcome: 'likely_churn_in_30d', confidence: 'high', reasoning };
};

// --- Rule 3: likely_churn_in_60d (Pass 2.5 §13.2) ---
const ruleChurn60d: Rule = ({ profile, trajectory, ctx }) => {
  const reasoning: string[] = [];
  let fired = false;
  // oscillating_3 raises confidence to high; otherwise medium-high (medium).
  let elevatedConfidence = false;

  if (trajectory.pattern === 'oscillating_2' || trajectory.pattern === 'oscillating_3') {
    reasoning.push(`trajectory.pattern='${trajectory.pattern}'`);
    fired = true;
    if (trajectory.pattern === 'oscillating_3') elevatedConfidence = true;
  }

  const daysUntilExpiry = ctx.signals.rejig.daysUntilExpiry;
  if (
    profile === 'power_user_declining' &&
    ctx.tenureDays >= TIME_WINDOWS.power_user_declining_churn_tenure_days &&
    daysUntilExpiry !== null &&
    daysUntilExpiry <= 60
  ) {
    reasoning.push(
      "profile='power_user_declining'",
      `tenureDays=${ctx.tenureDays} >= ${TIME_WINDOWS.power_user_declining_churn_tenure_days}`,
      `daysUntilExpiry=${daysUntilExpiry} <= 60`,
    );
    fired = true;
  }

  if (profile === 'paying_but_absent' && ctx.tenureDays >= 30) {
    reasoning.push("profile='paying_but_absent'", `tenureDays=${ctx.tenureDays} >= 30`);
    fired = true;
  }

  if (
    profile === 'never_adopted' &&
    ctx.tenureDays >= TIME_WINDOWS.never_adopted_churn_tenure_days
  ) {
    reasoning.push(
      "profile='never_adopted'",
      `tenureDays=${ctx.tenureDays} >= ${TIME_WINDOWS.never_adopted_churn_tenure_days}`,
    );
    fired = true;
  }

  if (!fired) return null;
  const confidence: OutcomeConfidence = elevatedConfidence ? 'high' : 'medium';
  return { outcome: 'likely_churn_in_60d', confidence, reasoning };
};

// --- Rule 4: likely_renew_after_intervention (Pass 2.5 §13.2) ---
const RECOVERABLE_PROFILES: ReadonlySet<EngagementProfile> = new Set<EngagementProfile>([
  'power_user_declining',
  'power_user_waning',
  'steady_user_declining',
  'light_user_dormant',
]);
const RECOVERABLE_TRAJECTORIES: ReadonlySet<TrajectoryPattern> = new Set<TrajectoryPattern>([
  'declining',
  'insufficient_data',
]);

const ruleRenewAfterIntervention: Rule = ({ profile, trajectory, ctx }) => {
  const reasoning: string[] = [];
  let fired = false;

  if (RECOVERABLE_PROFILES.has(profile) && RECOVERABLE_TRAJECTORIES.has(trajectory.pattern)) {
    reasoning.push(
      `profile='${profile}' (recoverable)`,
      `trajectory.pattern='${trajectory.pattern}' (recoverable)`,
    );
    fired = true;
  }

  if (profile === 'video_non_adopter' && ctx.tenureDays >= 30) {
    reasoning.push("profile='video_non_adopter'", `tenureDays=${ctx.tenureDays} >= 30`);
    fired = true;
  }

  if (profile === 'listings_only' && ctx.tenureDays >= 30) {
    reasoning.push("profile='listings_only'", `tenureDays=${ctx.tenureDays} >= 30`);
    fired = true;
  }

  if (
    profile === 'never_adopted' &&
    ctx.tenureDays >= TIME_WINDOWS.never_adopted_intervention_min_tenure_days &&
    ctx.tenureDays <= TIME_WINDOWS.never_adopted_intervention_max_tenure_days
  ) {
    reasoning.push(
      "profile='never_adopted'",
      `tenureDays=${ctx.tenureDays} in [${TIME_WINDOWS.never_adopted_intervention_min_tenure_days}, ${TIME_WINDOWS.never_adopted_intervention_max_tenure_days}]`,
    );
    fired = true;
  }

  if (!fired) return null;
  return { outcome: 'likely_renew_after_intervention', confidence: 'medium', reasoning };
};

// --- Rule 5: likely_renew (default healthy) (Pass 2.5 §13.2) ---
const HEALTHY_PROFILES: ReadonlySet<EngagementProfile> = new Set<EngagementProfile>([
  'power_user',
  'steady_user',
  'light_user_engaged',
  'trial_engaged',
  'social_only',
]);
const HEALTHY_TRAJECTORIES: ReadonlySet<TrajectoryPattern> = new Set<TrajectoryPattern>([
  'ramping',
  'steady',
  'recovering',
  'insufficient_data',
]);

const ruleRenew: Rule = ({ profile, trajectory, ctx, now }) => {
  if (!HEALTHY_PROFILES.has(profile)) return null;
  if (!HEALTHY_TRAJECTORIES.has(trajectory.pattern)) return null;
  if (ctx.subscriptionStatus === 'Cancelled') return null;
  if (hasUnresolvedRecentPaymentFailure(ctx, now)) return null;

  const reasoning: string[] = [
    `profile='${profile}' (healthy)`,
    `trajectory.pattern='${trajectory.pattern}' (healthy)`,
    `subscriptionStatus='${ctx.subscriptionStatus ?? 'null'}'`,
    `no payment_failed in last ${TIME_WINDOWS.payment_failed_window_days}d`,
  ];

  // High confidence if trajectory is a known good pattern; medium when
  // we only have insufficient_data to lean on.
  const confidence: OutcomeConfidence =
    trajectory.pattern === 'insufficient_data' ? 'medium' : 'high';
  return { outcome: 'likely_renew', confidence, reasoning };
};

// --- Rule 6: unknown (catch-all when ineligible / brand-new / silent) ---
const ruleUnknown: Rule = ({ profile, ctx }) => {
  const reasoning: string[] = [];
  let fired = false;

  if (profile === 'ineligible') {
    reasoning.push("profile='ineligible'");
    fired = true;
  }

  // Brand-new, no usage signals yet: <7d tenure + paying_but_absent +
  // zero posts + never logged in. Don't pretend we know the answer.
  if (
    ctx.tenureDays < 7 &&
    profile === 'paying_but_absent' &&
    ctx.signals.rejig.totalPosts === 0 &&
    ctx.signals.rejig.lastLoginAt === null
  ) {
    reasoning.push(
      `tenureDays=${ctx.tenureDays} < 7`,
      "profile='paying_but_absent'",
      'rejig.totalPosts=0',
      'rejig.lastLoginAt=null',
    );
    fired = true;
  }

  if (!fired) return null;
  return { outcome: 'unknown', confidence: 'low', reasoning };
};

const RULES: ReadonlyArray<{ outcome: PredictedOutcome; fn: Rule }> = [
  { outcome: 'near_certain_churn', fn: ruleNearCertainChurn },
  { outcome: 'likely_churn_in_30d', fn: ruleChurn30d },
  { outcome: 'likely_churn_in_60d', fn: ruleChurn60d },
  { outcome: 'likely_renew_after_intervention', fn: ruleRenewAfterIntervention },
  { outcome: 'likely_renew', fn: ruleRenew },
  { outcome: 'unknown', fn: ruleUnknown },
];

export const RuleBasedOutcomePredictor: OutcomePredictor = {
  predict({ profile, trajectory, ctx }) {
    const now = new Date();
    for (const rule of RULES) {
      const result = rule.fn({ profile, trajectory, ctx, now });
      if (result) return result;
    }
    // Nothing fired — emit a low-confidence unknown rather than throwing,
    // so the cron handler can still write an audit row + dampen alerts.
    return {
      outcome: 'unknown',
      confidence: 'low',
      reasoning: ['no rule matched'],
    };
  },
};
