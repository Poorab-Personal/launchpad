/**
 * Enum value lists for setup-hubspot-properties.ts. Kept in a sidecar
 * file so the values stay one-line-each + git-blame-friendly when we
 * extend a profile or trajectory pattern.
 *
 * IMPORTANT: these must stay in lockstep with src/lib/bi/types.ts. If a
 * new value is added there, add it here too — otherwise the BI cron will
 * try to push an enum value HubSpot doesn't have and silently 400.
 */

// Mirrors EngagementProfile in src/lib/bi/types.ts (17 values).
export const PROFILE_VALUES = [
  'power_user',
  'steady_user',
  'never_adopted',
  'light_user_engaged',
  'social_only',
  'trial_engaged',
  'canceled_pending',
  'light_user_dormant',
  'paying_but_absent',
  'steady_user_declining',
  'video_non_adopter',
  'power_user_declining',
  'power_user_waning',
  'listings_only',
  'trial_dormant',
  'ineligible',
  'steady_user_drifting',
] as const;

// Mirrors TrajectoryPattern in src/lib/bi/types.ts (9 values).
export const TRAJECTORY_VALUES = [
  'ramping',
  'steady',
  'declining',
  'recovering',
  'oscillating_2',
  'oscillating_3',
  'terminally_declining',
  'oscillating_4plus',
  'insufficient_data',
] as const;

// Mirrors PredictedOutcome in src/lib/bi/types.ts (6 values).
export const OUTCOME_VALUES = [
  'likely_renew',
  'likely_renew_after_intervention',
  'likely_churn_in_60d',
  'likely_churn_in_30d',
  'near_certain_churn',
  'unknown',
] as const;

// Mirrors AttentionReason in src/lib/bi/types.ts (10 locked values).
export const ATTENTION_REASON_VALUES = [
  'no_show_no_rebook',
  'no_show_pattern',
  'customer_cancelled_onboarding',
  'partial_no_completion',
  'payment_failed',
  'payment_past_due',
  'stuck_in_onboarding',
  'engagement_drop_30d',
  'renewal_approaching_6w',
  'renewal_approaching_2w',
] as const;

// Mirrors paymentModeEnum in src/db/schema/enums.ts.
export const PAYMENT_MODE_VALUES = [
  'pre-paid',
  'setup-intent-at-intake',
  'invoice',
  'none',
] as const;

// Mirrors ActionUrgency in src/lib/bi/types.ts.
export const ACTION_URGENCY_VALUES = ['today', 'this_week', 'monitor'] as const;

// LP channels → HubSpot rejig_brokerage_channel display values.
// Mapping is documented in docs/integrations/hubspot-integration-phase-0b-setup.md §1.
// LP code 'Standard' → 'D2C'  / 'Keyes' → 'B2B - Keyes' / 'BW' → 'B2B - B&W'.
export const BROKERAGE_CHANNEL_VALUES = ['D2C', 'B2B - Keyes', 'B2B - B&W'] as const;
