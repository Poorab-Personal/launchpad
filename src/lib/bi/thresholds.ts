/**
 * V1 thresholds for the Layer 1 profile classifier + Layer 2 trajectory
 * detector + Layer 3 outcome predictor. Derived from the 2026-05-11
 * Rejig snapshot histograms in docs/plans/post-launch-migration-pass-2.md §1
 * (specifically §1.5 last-login distribution, §1.6 days-since-last-post,
 * §1.7 total-posts, §1.8 listing-count).
 *
 * Each threshold has an inline rationale citing the data source. Re-tune
 * review at 4 weeks post-launch per Pass 2.7 §29.4 — propose
 * PROFILE_THRESHOLDS_V2 if any profile drifts >20% from V1 counts.
 */
export const PROFILE_THRESHOLDS_V1 = {
  // §1.7: 51-100 cohort=89, 101+ cohort=133. Heavy-adopter floor is 50.
  posts_power_user_floor: 50,

  // §1.7: 0-post cohort=90, 1-5 cohort=101. The "barely using" tail is <6.
  posts_light_user_ceiling: 5,

  // §1.7 inverse: meaningful adoption starts at 6 lifetime posts.
  posts_steady_user_floor: 6,

  // §1.5: ≤7d bucket=413 (60.6%), 8-14d=73. Together = currently engaged.
  // Drops to 40 in 15-30d. 14d is the natural break.
  days_since_login_engaged_ceiling: 14,

  // §1.6: ≤7=381, 8-14=46, 15-30=39, 31-60=31. The 30-day mark is the
  // natural break between "currently posting" and "stopped."
  days_since_last_post_declining_floor: 30,

  // §1.8: 1-3 cohort=261 (typical agent inventory). 4+ = listing-active.
  // Used for `listings_only` (has inventory but no social content).
  listing_count_active_floor: 3,

  // Feature-specific: 10+ posts shows real adoption; 0 video_posts inside
  // that cohort flags "using product but ignoring video feature."
  video_non_adopter_posts_floor: 10,
} as const;

export type ProfileThresholdsVersion = 'V1' | 'V2';

export const ACTIVE_THRESHOLDS_VERSION: ProfileThresholdsVersion = 'V1';

/**
 * Trajectory detector tuning. Pass 2.5 §12.4 + Pass 2.7 §29.2.
 *
 * Velocity = (posts_now - posts_prev) / days_between_snapshots.
 * Pattern detection uses 30%↓ / 20%↑ deltas to classify each transition
 * as ↑ / ↓ / =. A "peter-out cycle" = one ↓ → ↑ pair.
 */
export const TRAJECTORY_THRESHOLDS_V1 = {
  velocity_delta_down_pct: 30,                  // ≥30% drop = ↓ transition
  velocity_delta_up_pct: 20,                    // ≥20% rise = ↑ transition
  cycle_min_separation_days: 7,                 // ≥7d between peter-outs (with weekly snapshots, this naturally enforces)
  insufficient_data_snapshot_count: 1,          // <=1 snapshot returns 'insufficient_data'; >=2 attempts classification
} as const;

/**
 * Outcome predictor + state mapper time windows.
 */
export const TIME_WINDOWS = {
  payment_failed_window_days: 14,               // payment_failed signal within this window triggers Critical
  stuck_in_pre_launch_days: 14,                 // ticket in pre-launch state >this = stuck_in_onboarding
  csm_cooldown_days: 7,                         // bi_recovery rule (110) cooldown after CSM manual move
  trial_not_activated_grace_hours: 24,          // B2B Active without Stripe sub for this long = trial_not_activated
  renewal_2w_max_days: 14,
  renewal_6w_max_days: 42,
  renewal_6w_min_days: 15,
  paying_but_absent_churn_tenure_days: 90,      // never-logged-in + 90d tenure = near_certain_churn
  never_adopted_intervention_min_tenure_days: 14,
  never_adopted_intervention_max_tenure_days: 60,
  never_adopted_churn_tenure_days: 60,
  power_user_declining_churn_tenure_days: 60,
} as const;
