/**
 * Layer 1 — Engagement Profile classifier.
 *
 * Single-snapshot derivable: takes the customer's current signals and
 * returns ONE of 17 engagement profiles. First-match-wins decision tree
 * (order matters). Thresholds from PROFILE_THRESHOLDS_V1 — each decision
 * branch documents its threshold + rationale inline.
 *
 * Pure function, no I/O. Called by the BI cron once per customer per run.
 * Returns 'ineligible' for terminal/out-of-scope customers (canceled,
 * deactivated, missing data) — caller decides whether to skip further
 * layers for these.
 *
 * Pass 2.5 §11.3 — full decision tree. Update PROFILE_THRESHOLDS_V1 at
 * src/lib/bi/thresholds.ts to retune (data-derived from 2026-05-11
 * snapshot histograms; 4-week re-tune scheduled per Pass 2.7 §29.4).
 *
 * Profile catalog (Pass 2.5 §11.2):
 *   - canceled_pending       — subscriptionStatus === 'Cancelled' (terminal).
 *   - ineligible             — null subscription or unhydrated manual account.
 *   - trial_dormant          — Trial + 0 lifetime posts.
 *   - trial_engaged          — Trial + ≥1 post.
 *   - paying_but_absent      — Active/Past Due but never logged in.
 *   - never_adopted          — Active/Past Due + logged in but 0 posts.
 *   - power_user_declining   — ≥posts_power_user_floor posts AND
 *                              daysSinceLastPost > declining_floor.
 *   - power_user             — ≥power_user_floor posts AND
 *                              daysSinceLogin ≤ engaged_ceiling.
 *   - power_user_waning      — ≥power_user_floor posts but neither engaged
 *                              login nor recent post (drifting heavy user).
 *   - video_non_adopter      — ≥video_non_adopter_posts_floor posts AND
 *                              videoPosts === 0 (adopting product, skipping video).
 *   - listings_only          — ≥listing_count_active_floor listings AND
 *                              totalPosts ≤ 2 (uploads inventory, no social).
 *   - social_only            — ≥5 posts AND 0 listings (posting w/o inventory).
 *   - steady_user            — 6..49 posts AND daysSinceLogin ≤ engaged_ceiling.
 *   - steady_user_declining  — 6..49 posts AND daysSinceLastPost > declining_floor.
 *   - steady_user_drifting   — 6..49 posts, neither engaged login nor recent
 *                              post (between steady and steady_declining).
 *   - light_user_engaged     — ≤5 posts AND daysSinceLogin ≤ engaged_ceiling.
 *   - light_user_dormant     — ≤5 posts, no recent login.
 */

import type { BiContext, EngagementProfile } from './types';
import { PROFILE_THRESHOLDS_V1 } from './thresholds';

export function classifyProfile(ctx: BiContext): EngagementProfile {
  const r = ctx.signals.rejig;
  const T = PROFILE_THRESHOLDS_V1;

  // --- Terminal / out-of-scope ---
  // Cancelled subscription is a definitive end-of-lifecycle signal.
  if (ctx.subscriptionStatus === 'Cancelled') return 'canceled_pending';
  // Null subscription = missing/unhydrated; skip further layers.
  if (ctx.subscriptionStatus === null) return 'ineligible';
  // Manual account with no Stripe sub AND no plan key = orphan / config error.
  if (r.isManual && !ctx.stripeSubscriptionId && !r.planKey) return 'ineligible';

  // --- Trialing ---
  // Bifurcate by whether they've posted at all during trial.
  if (ctx.subscriptionStatus === 'Trial') {
    return r.totalPosts === 0 ? 'trial_dormant' : 'trial_engaged';
  }

  // --- Active / Past Due subscription branch ---
  // Never logged in despite paying = paying_but_absent (highest churn risk).
  if (r.lastLoginAt === null) return 'paying_but_absent';
  // Logged in but never posted = never_adopted.
  if (r.totalPosts === 0) return 'never_adopted';

  // --- Power-user branches (≥posts_power_user_floor = 50 lifetime posts) ---
  // Power-user check MUST come before feature-specific checks (video_non_adopter,
  // listings_only, social_only) because a power_user_declining heavy user should
  // win over a coincidental video_non_adopter classification.
  if (r.totalPosts >= T.posts_power_user_floor) {
    // Stopped posting recently (>30d) — declining heavy user.
    if (
      r.daysSinceLastPost !== null &&
      r.daysSinceLastPost > T.days_since_last_post_declining_floor
    ) {
      return 'power_user_declining';
    }
    // Recently logged in — still engaged.
    if (
      r.daysSinceLogin !== null &&
      r.daysSinceLogin <= T.days_since_login_engaged_ceiling
    ) {
      return 'power_user';
    }
    // Heavy lifetime usage but neither recent login nor recent post → waning.
    return 'power_user_waning';
  }

  // --- Feature-specific signals (must come BEFORE generic steady/light buckets) ---
  // Adopting the product (≥10 posts) but ignoring video entirely.
  if (r.totalPosts >= T.video_non_adopter_posts_floor && r.videoPosts === 0) {
    return 'video_non_adopter';
  }
  // Has inventory (≥3 listings) but barely posts socially (≤2 posts).
  if (r.listingCount >= T.listing_count_active_floor && r.totalPosts <= 2) {
    return 'listings_only';
  }
  // Posting without inventory (no listings backing the social activity).
  if (r.totalPosts >= 5 && r.listingCount === 0) {
    return 'social_only';
  }

  // --- Steady-user branches (6..49 posts) ---
  if (r.totalPosts >= T.posts_steady_user_floor) {
    // Recently logged in — actively engaged steady user.
    if (
      r.daysSinceLogin !== null &&
      r.daysSinceLogin <= T.days_since_login_engaged_ceiling
    ) {
      return 'steady_user';
    }
    // Stopped posting (>30d) — declining steady user.
    if (
      r.daysSinceLastPost !== null &&
      r.daysSinceLastPost > T.days_since_last_post_declining_floor
    ) {
      return 'steady_user_declining';
    }
    // Steady cohort but neither engaged login nor recent post → drifting.
    return 'steady_user_drifting';
  }

  // --- Light-user branches (≤5 posts) ---
  // Recently engaged but still light usage — early-tenure or selective user.
  if (
    r.daysSinceLogin !== null &&
    r.daysSinceLogin <= T.days_since_login_engaged_ceiling
  ) {
    return 'light_user_engaged';
  }
  // Default fall-through: light usage, no recent login.
  return 'light_user_dormant';
}
