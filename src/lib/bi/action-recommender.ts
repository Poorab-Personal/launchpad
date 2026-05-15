import type {
  ActionTemplate,
  BiContext,
  EngagementProfile,
  PredictedOutcome,
  RecommendedAction,
  TrajectorySnapshot,
} from './types';
import { ACTION_LIBRARY } from './action-library';
import { TIME_WINDOWS } from './thresholds';

type MatchArgs = {
  profile: EngagementProfile;
  trajectory: TrajectorySnapshot;
  outcome: PredictedOutcome;
  ctx: BiContext;
};

type MatchResult = { matched: boolean; reasoning: string[] };

/**
 * Whether the customer has a recent unresolved payment failure.
 * Recent = within TIME_WINDOWS.payment_failed_window_days.
 * Resolved = a successful payment after the failure.
 */
function hasRecentPaymentFailed(ctx: BiContext): boolean {
  const { lastPaymentFailedAt, lastPaymentSucceededAt } = ctx.signals.stripe;
  if (lastPaymentFailedAt === null) return false;
  const windowStart = new Date(
    Date.now() - TIME_WINDOWS.payment_failed_window_days * 86400 * 1000,
  );
  if (lastPaymentFailedAt <= windowStart) return false;
  if (lastPaymentSucceededAt && lastPaymentSucceededAt >= lastPaymentFailedAt) return false;
  return true;
}

/**
 * First-match-wins predicate dispatch for each template id. Returns
 * matched=true with the triggering predicates listed in reasoning[].
 *
 * Each branch mirrors the Pass 2.5 §14.1 row exactly:
 *   A13 → near_certain_churn + oscillating_4plus
 *   A12 → likely_churn_in_30d + terminally_declining
 *   A11 → likely_churn_in_30d + recent payment_failed
 *   A14 → near_certain_churn + canceled_pending + daysUntilExpiry <= 14
 *   A10 → (likely_churn_in_60d | likely_churn_in_30d) + paying_but_absent
 *   A9  → likely_churn_in_60d + oscillating_3
 *   A8  → likely_churn_in_60d + oscillating_2
 *   A4  → likely_renew_after_intervention + never_adopted
 *   A2  → likely_renew_after_intervention + power_user_declining
 *   A3  → likely_renew_after_intervention + power_user_waning
 *   A7  → likely_renew_after_intervention + steady_user_declining
 *   A5  → likely_renew_after_intervention + video_non_adopter
 *   A6  → likely_renew_after_intervention + listings_only
 *   A1  → likely_renew
 *   A15 → unknown
 */
function matchesTemplate(template: ActionTemplate, args: MatchArgs): MatchResult {
  const { profile, trajectory, outcome, ctx } = args;
  const reasoning: string[] = [];

  switch (template.id) {
    case 'A13': {
      if (outcome === 'near_certain_churn' && trajectory.pattern === 'oscillating_4plus') {
        reasoning.push('outcome=near_certain_churn', 'trajectory=oscillating_4plus');
        return { matched: true, reasoning };
      }
      return { matched: false, reasoning };
    }
    case 'A12': {
      if (outcome === 'likely_churn_in_30d' && trajectory.pattern === 'terminally_declining') {
        reasoning.push('outcome=likely_churn_in_30d', 'trajectory=terminally_declining');
        return { matched: true, reasoning };
      }
      return { matched: false, reasoning };
    }
    case 'A11': {
      if (outcome === 'likely_churn_in_30d' && hasRecentPaymentFailed(ctx)) {
        reasoning.push(
          'outcome=likely_churn_in_30d',
          `payment_failed_within_${TIME_WINDOWS.payment_failed_window_days}d`,
        );
        return { matched: true, reasoning };
      }
      return { matched: false, reasoning };
    }
    case 'A14': {
      const daysUntilExpiry = ctx.signals.rejig.daysUntilExpiry;
      if (
        outcome === 'near_certain_churn' &&
        profile === 'canceled_pending' &&
        daysUntilExpiry !== null &&
        daysUntilExpiry <= 14
      ) {
        reasoning.push(
          'outcome=near_certain_churn',
          'profile=canceled_pending',
          `daysUntilExpiry=${daysUntilExpiry}`,
        );
        return { matched: true, reasoning };
      }
      return { matched: false, reasoning };
    }
    case 'A10': {
      if (
        (outcome === 'likely_churn_in_60d' || outcome === 'likely_churn_in_30d') &&
        profile === 'paying_but_absent'
      ) {
        reasoning.push(`outcome=${outcome}`, 'profile=paying_but_absent');
        return { matched: true, reasoning };
      }
      return { matched: false, reasoning };
    }
    case 'A9': {
      if (outcome === 'likely_churn_in_60d' && trajectory.pattern === 'oscillating_3') {
        reasoning.push('outcome=likely_churn_in_60d', 'trajectory=oscillating_3');
        return { matched: true, reasoning };
      }
      return { matched: false, reasoning };
    }
    case 'A8': {
      if (outcome === 'likely_churn_in_60d' && trajectory.pattern === 'oscillating_2') {
        reasoning.push('outcome=likely_churn_in_60d', 'trajectory=oscillating_2');
        return { matched: true, reasoning };
      }
      return { matched: false, reasoning };
    }
    case 'A4': {
      if (outcome === 'likely_renew_after_intervention' && profile === 'never_adopted') {
        reasoning.push('outcome=likely_renew_after_intervention', 'profile=never_adopted');
        return { matched: true, reasoning };
      }
      return { matched: false, reasoning };
    }
    case 'A2': {
      if (outcome === 'likely_renew_after_intervention' && profile === 'power_user_declining') {
        reasoning.push('outcome=likely_renew_after_intervention', 'profile=power_user_declining');
        return { matched: true, reasoning };
      }
      return { matched: false, reasoning };
    }
    case 'A3': {
      if (outcome === 'likely_renew_after_intervention' && profile === 'power_user_waning') {
        reasoning.push('outcome=likely_renew_after_intervention', 'profile=power_user_waning');
        return { matched: true, reasoning };
      }
      return { matched: false, reasoning };
    }
    case 'A7': {
      if (outcome === 'likely_renew_after_intervention' && profile === 'steady_user_declining') {
        reasoning.push('outcome=likely_renew_after_intervention', 'profile=steady_user_declining');
        return { matched: true, reasoning };
      }
      return { matched: false, reasoning };
    }
    case 'A5': {
      if (outcome === 'likely_renew_after_intervention' && profile === 'video_non_adopter') {
        reasoning.push('outcome=likely_renew_after_intervention', 'profile=video_non_adopter');
        return { matched: true, reasoning };
      }
      return { matched: false, reasoning };
    }
    case 'A6': {
      if (outcome === 'likely_renew_after_intervention' && profile === 'listings_only') {
        reasoning.push('outcome=likely_renew_after_intervention', 'profile=listings_only');
        return { matched: true, reasoning };
      }
      return { matched: false, reasoning };
    }
    case 'A1': {
      if (outcome === 'likely_renew') {
        reasoning.push('outcome=likely_renew');
        return { matched: true, reasoning };
      }
      return { matched: false, reasoning };
    }
    case 'A15': {
      if (outcome === 'unknown') {
        reasoning.push('outcome=unknown');
        return { matched: true, reasoning };
      }
      return { matched: false, reasoning };
    }
    default:
      return { matched: false, reasoning };
  }
}

/**
 * Layer 4 — recommend a CSM-facing action template for this customer.
 * First-match-wins over ACTION_LIBRARY. Library is ordered by urgency
 * descending, so the most-urgent matching template wins.
 *
 * Returns null if no template matches (treat as "no action recommended,
 * no Tier-A property write").
 *
 * Pure function; no I/O. Pass 2.5 §14.
 */
export function recommendAction(args: {
  profile: EngagementProfile;
  trajectory: TrajectorySnapshot;
  outcome: PredictedOutcome;
  ctx: BiContext;
}): RecommendedAction | null {
  for (const template of ACTION_LIBRARY) {
    const { matched, reasoning } = matchesTemplate(template, args);
    if (matched) {
      return { template, reasoning };
    }
  }
  return null;
}
