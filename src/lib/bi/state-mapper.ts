/**
 * Layer 5 — State Mapper.
 *
 * Maps the deeper-layer outputs (Layer 1 profile, Layer 2 trajectory,
 * Layer 3 outcome) plus hard Stripe/HubSpot override signals to a
 * HubSpot kanban state (OnboardingState) + attention reason. This is
 * the LAST step in the per-customer evaluation — the BI cron handler
 * calls `applyStateTransition` with the (state, attentionReason,
 * sourceDetail) tuple returned here.
 *
 * Replaces the 11-rule Pass 2 §2 matrix with override-and-funnel
 * logic per Pass 2.5 §15 + Pass 2.6 §15.1 + Pass 2.7 (final locks):
 *
 *   1. Check 7 hard overrides in priority order. First match wins.
 *      (canceled-expired, subscription_cancelled, payment_failed,
 *       past_due, no_show_pattern, stuck_in_onboarding,
 *       trial_not_activated.)
 *   2. If no override fires, map the Layer 3 outcome → state per the
 *      Pass 2.6 §15.1 mapping table. Renewal-window reasons take
 *      precedence over profile-derived reasons inside Watch.
 *
 * Pure function — no I/O, no DB reads.
 */

import { TIME_WINDOWS } from './thresholds';
import type {
  AttentionReason,
  BiContext,
  EngagementProfile,
  OnboardingState,
  PredictedOutcome,
  TrajectorySnapshot,
} from './types';

/**
 * Layer 5 mapper. See file docstring for the rule cascade.
 *
 * Override priority (Pass 2.6 §15.1):
 *   1. subscription Cancelled + expiry <= 0  → Churned
 *   2. subscription Cancelled (recent)       → Churned
 *   3. payment_failed in window + unresolved → Critical
 *   4. subscription Past Due                  → At-Risk / payment_past_due
 *   5. HS no_show_count >= 2 + pre-launch    → At-Risk / no_show_pattern
 *   6. stuck > 14d in pre-launch state       → At-Risk / stuck_in_onboarding
 *   7. B2B-Keyes Active + no Stripe sub + >24h → At-Risk / payment_past_due
 */
export function mapToState(args: {
  profile: EngagementProfile;
  trajectory: TrajectorySnapshot;
  outcome: PredictedOutcome;
  ctx: BiContext;
}): {
  state: OnboardingState;
  attentionReason: AttentionReason | null;
  sourceDetail: string;
} {
  const { profile, outcome, ctx } = args;
  const now = Date.now();

  // ─── Suppress payment-related overrides for comped customers ──────────
  // 'comped' = real engaged user, billing waived (UniqueCollective, IPRE,
  // NEXT, VP Group, etc.). They legitimately have no Stripe subscription
  // or a stale Cancelled / Past Due status that doesn't reflect reality.
  // Without this short-circuit they get flagged Critical / At-Risk for
  // payment_failed / payment_past_due — pure noise on the CSM queue.
  //
  // We DON'T suppress override 5/6 (no-show pattern, stuck in pre-launch)
  // because those represent real workflow signals independent of billing.
  // We DO suppress overrides 1-4 + 7 (all payment- or subscription-driven).
  // 'internal_demo' is already filtered out at the BI cron query level,
  // but we treat it the same here as a belt-and-suspenders.
  const billingSuppressed =
    ctx.billingRelationship === 'comped' ||
    ctx.billingRelationship === 'internal_demo';

  // --- Override 1: subscription canceled AND past expiry → Churned ---
  if (
    !billingSuppressed &&
    ctx.subscriptionStatus === 'Cancelled' &&
    ctx.signals.rejig.daysUntilExpiry !== null &&
    ctx.signals.rejig.daysUntilExpiry <= 0
  ) {
    return {
      state: 'Churned',
      attentionReason: null,
      sourceDetail: 'override:canceled_expired',
    };
  }

  // --- Override 2: subscription canceled (still within grace) → Churned ---
  // BiContext doesn't currently carry a separate `cancelledAt` timestamp;
  // the importer/context-builder owns when to clear subscriptionStatus.
  // For now, any Cancelled status that didn't hit override 1 still maps
  // to Churned per Pass 2.6 §15.1.
  if (!billingSuppressed && ctx.subscriptionStatus === 'Cancelled') {
    return {
      state: 'Churned',
      attentionReason: null,
      sourceDetail: 'override:subscription_cancelled',
    };
  }

  // --- Override 3: recent payment_failed without subsequent success → Critical ---
  const failedAt = ctx.signals.stripe.lastPaymentFailedAt;
  const succeededAt = ctx.signals.stripe.lastPaymentSucceededAt;
  const paymentFailedCutoff = new Date(
    now - TIME_WINDOWS.payment_failed_window_days * 86400 * 1000,
  );
  if (
    !billingSuppressed &&
    failedAt &&
    failedAt > paymentFailedCutoff &&
    (!succeededAt || succeededAt < failedAt)
  ) {
    return {
      state: 'Critical',
      attentionReason: 'payment_failed',
      sourceDetail: 'override:payment_failed',
    };
  }

  // --- Override 4: past_due → At-Risk / payment_past_due ---
  if (!billingSuppressed && ctx.subscriptionStatus === 'Past Due') {
    return {
      state: 'At-Risk',
      attentionReason: 'payment_past_due',
      sourceDetail: 'override:past_due',
    };
  }

  // --- Override 5: HS no_show_count >= 2 while still pre-launch ---
  if (
    ctx.signals.hsContact.onboardingNoShowCount >= 2 &&
    (ctx.currentOnboardingState === 'Pre-Onboarding' ||
      ctx.currentOnboardingState === 'Onboarding Scheduled')
  ) {
    return {
      state: 'At-Risk',
      attentionReason: 'no_show_pattern',
      sourceDetail: 'override:no_show_pattern',
    };
  }

  // --- Override 6: stuck > 14d in pre-launch state ---
  const stuckCutoff = new Date(
    now - TIME_WINDOWS.stuck_in_pre_launch_days * 86400 * 1000,
  );
  if (
    ctx.stageEnteredAt &&
    (ctx.currentOnboardingState === 'Pre-Onboarding' ||
      ctx.currentOnboardingState === 'Onboarding Scheduled') &&
    ctx.stageEnteredAt < stuckCutoff
  ) {
    return {
      state: 'At-Risk',
      attentionReason: 'stuck_in_onboarding',
      sourceDetail: 'override:stuck_in_onboarding',
    };
  }

  // --- Override 7: B2B-Keyes Active + no Stripe sub + >24h since entering Active ---
  const trialGraceCutoff = new Date(
    now - TIME_WINDOWS.trial_not_activated_grace_hours * 3600 * 1000,
  );
  if (
    !billingSuppressed &&
    ctx.workflowKey === 'B2B-Keyes' &&
    ctx.currentOnboardingState === 'Active' &&
    !ctx.stripeSubscriptionId &&
    ctx.stageEnteredAt &&
    ctx.stageEnteredAt < trialGraceCutoff
  ) {
    return {
      state: 'At-Risk',
      attentionReason: 'payment_past_due',
      sourceDetail: 'override:trial_not_activated',
    };
  }

  // --- No override fired → outcome → state mapping (Pass 2.6 §15.1) ---
  switch (outcome) {
    case 'near_certain_churn':
      return {
        state: 'Critical',
        attentionReason: 'engagement_drop_30d',
        sourceDetail: 'outcome:near_certain_churn',
      };

    case 'likely_churn_in_30d':
      return {
        state: 'At-Risk',
        attentionReason: 'engagement_drop_30d',
        sourceDetail: 'outcome:likely_churn_in_30d',
      };

    case 'likely_churn_in_60d':
      return {
        state: 'At-Risk',
        attentionReason: 'engagement_drop_30d',
        sourceDetail: 'outcome:likely_churn_in_60d',
      };

    case 'likely_renew_after_intervention': {
      // Watch state with profile-derived reason. Renewal-window
      // override (if applicable) takes precedence over profile-derived.
      const renewalReason = deriveRenewalWindowReason(ctx);
      if (renewalReason) {
        return {
          state: 'Watch',
          attentionReason: renewalReason,
          sourceDetail: `outcome:likely_renew_after_intervention:${renewalReason}`,
        };
      }
      return {
        state: 'Watch',
        attentionReason: 'engagement_drop_30d',
        sourceDetail: `outcome:likely_renew_after_intervention:profile:${profile}`,
      };
    }

    case 'likely_renew': {
      // Renewal window may downgrade Active → Watch.
      const renewalReason = deriveRenewalWindowReason(ctx);
      if (renewalReason) {
        return {
          state: 'Watch',
          attentionReason: renewalReason,
          sourceDetail: `outcome:likely_renew:${renewalReason}`,
        };
      }
      return {
        state: 'Active',
        attentionReason: null,
        sourceDetail: 'outcome:likely_renew',
      };
    }

    case 'unknown':
      // Don't change state — return current as-is. The BI cron's
      // applyStateTransition no-op detection swallows the redundant write.
      // If currentOnboardingState is null or not one of the 6 kanban
      // states (e.g. a pre-launch string like 'Pre-Onboarding'), fall
      // back to 'Watch' as the neutral signal.
      return {
        state: coerceOnboardingState(ctx.currentOnboardingState) ?? 'Watch',
        attentionReason:
          (ctx.currentAttentionReason as AttentionReason | null) ?? null,
        sourceDetail: 'outcome:unknown',
      };
  }
}

/**
 * Narrows the free-form `currentOnboardingState` string to the
 * OnboardingState union, or returns null if it isn't one of the 6
 * post-launch kanban values.
 */
function coerceOnboardingState(s: string | null): OnboardingState | null {
  if (s === null) return null;
  switch (s) {
    case 'Active':
    case 'Watch':
    case 'At-Risk':
    case 'Critical':
    case 'On Hold':
    case 'Churned':
      return s;
    default:
      return null;
  }
}

/**
 * Renewal-window helper. Returns the appropriate attention reason
 * if `daysUntilExpiry` falls inside one of the two renewal windows,
 * else null.
 *
 *   0-14d remaining  → renewal_approaching_2w
 *   15-42d remaining → renewal_approaching_6w
 *   otherwise        → null
 */
function deriveRenewalWindowReason(ctx: BiContext): AttentionReason | null {
  const days = ctx.signals.rejig.daysUntilExpiry;
  if (days === null || days < 0) return null;
  if (days <= TIME_WINDOWS.renewal_2w_max_days) {
    return 'renewal_approaching_2w';
  }
  if (
    days >= TIME_WINDOWS.renewal_6w_min_days &&
    days <= TIME_WINDOWS.renewal_6w_max_days
  ) {
    return 'renewal_approaching_6w';
  }
  return null;
}
