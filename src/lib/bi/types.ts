/**
 * Shared types for the BI evaluators. The 5 layers consume + produce
 * these types so each layer file in src/lib/bi/ can be built independently
 * without circular imports.
 */

// === Layer 1: Engagement Profile ===
// 17 values from Pass 2.5 §11.2. First-match-wins decision tree in profile-classifier.ts.
export type EngagementProfile =
  | 'power_user'
  | 'steady_user'
  | 'never_adopted'
  | 'light_user_engaged'
  | 'social_only'
  | 'trial_engaged'
  | 'canceled_pending'
  | 'light_user_dormant'
  | 'paying_but_absent'
  | 'steady_user_declining'
  | 'video_non_adopter'
  | 'power_user_declining'
  | 'power_user_waning'
  | 'listings_only'
  | 'trial_dormant'
  | 'ineligible'
  | 'steady_user_drifting';

// === Layer 2: Trajectory ===
// 9 patterns from Pass 2.5 §12.1. Pass 2.7 removed the snapshot-count gate;
// pattern fires on whatever data exists, confidence is downgraded but firing isn't blocked.
export type TrajectoryPattern =
  | 'ramping'
  | 'steady'
  | 'declining'
  | 'recovering'
  | 'oscillating_2'
  | 'oscillating_3'
  | 'terminally_declining'
  | 'oscillating_4plus'
  | 'insufficient_data';

export type TrajectoryConfidence = 'low' | 'medium' | 'high';

export type TrajectorySnapshot = {
  pattern: TrajectoryPattern;
  cyclesObserved: number;
  currentPhase: 'rising' | 'declining' | 'flat' | 'recovering';
  velocityHistory: number[];                    // last N post_velocity_7d values
  loginHistory: number[];                        // last N days_since_login values
  snapshotsEvaluated: number;
  firstDeclineObservedAt: string | null;        // ISO
  lastRecoveryObservedAt: string | null;        // ISO
  confidence: TrajectoryConfidence;
};

// === Layer 3: Predicted Outcome ===
// 6 buckets from Pass 2.5 §13.1.
export type PredictedOutcome =
  | 'likely_renew'
  | 'likely_renew_after_intervention'
  | 'likely_churn_in_60d'
  | 'likely_churn_in_30d'
  | 'near_certain_churn'
  | 'unknown';

export type OutcomeConfidence = 'low' | 'medium' | 'high';

export type OutcomePrediction = {
  outcome: PredictedOutcome;
  confidence: OutcomeConfidence;
  reasoning: string[];                          // human-readable list of triggering predicates
};

// === Layer 4: Recommended Action ===
// 15 templates A1-A15 (Pass 2.7 §29.3 — A16-A18 deferred with Conversations).
export type ActionType =
  | 'no_action'
  | 'email_template'
  | 'loom_send'
  | 'task_create'
  | 'csm_call';

export type ActionUrgency = 'today' | 'this_week' | 'monitor';

export type ActionTemplate = {
  id: string;                                   // 'A1' .. 'A15'
  actionType: ActionType[];                     // some templates fire multiple action types
  contentSummary: string;                       // CSM-facing template text
  urgency: ActionUrgency;
};

export type RecommendedAction = {
  template: ActionTemplate;
  reasoning: string[];                          // why this template fired
};

// === Layer 5: State Mapping ===
// Post-launch HubSpot ticket pipeline stage labels (Phase 0b setup doc).
export type OnboardingState =
  | 'Active'
  | 'Watch'
  | 'At-Risk'
  | 'Critical'
  | 'On Hold'
  | 'Churned';

// === The 10 locked attention_reason values ===
// docs/integrations/hubspot-integration-phase-0b-setup.md
export type AttentionReason =
  | 'no_show_no_rebook'
  | 'no_show_pattern'
  | 'customer_cancelled_onboarding'
  | 'partial_no_completion'
  | 'payment_failed'
  | 'payment_past_due'
  | 'stuck_in_onboarding'
  | 'engagement_drop_30d'
  | 'renewal_approaching_6w'
  | 'renewal_approaching_2w';

// === Aggregate types ===
/**
 * Input to all BI evaluators — the full per-customer signal context.
 * Built once per customer per cron run by `src/lib/bi/context.ts` (Phase 4b).
 */
export type BiContext = {
  customerId: string;
  workflowKey: string;                          // 'D2C-Standard' / 'B2B-Keyes' / 'B2B-BW'
  customerType: 'D2C' | 'B2B';
  subscriptionStatus: 'Active' | 'Trial' | 'Past Due' | 'Cancelled' | null;
  stripeSubscriptionId: string | null;
  stripeCustomerId: string | null;
  hubspotTicketId: string | null;
  hubspotContactId: string | null;
  selectedPlanName: string | null;              // customers.selectedPlanName — surfaced on HS Engagement Card
  billingRelationship: 'paying' | 'comped' | 'internal_demo' | null;  // customers.billingRelationship
  currentOnboardingState: string | null;        // mirror; what's in customers.onboardingState
  currentAttentionReason: string | null;
  currentEngagementProfile: EngagementProfile | null;
  attentionSetAt: Date | null;
  stageEnteredAt: Date | null;
  tenureDays: number;                           // since createdAt
  signals: {
    rejig: {
      lastLoginAt: Date | null;
      daysSinceLogin: number | null;            // computed from lastLoginAt
      totalPosts: number;
      videoPosts: number;
      imagePosts: number;
      daysSinceLastPost: number | null;
      listingCount: number;
      daysUntilExpiry: number | null;
      contentTypeBreakdown: Record<string, number>;
      isManual: boolean;
      planKey: string | null;
    };
    stripe: {
      lastPaymentFailedAt: Date | null;
      lastPaymentSucceededAt: Date | null;      // used to determine if a payment_failed has been resolved
      lastSubscriptionStatus: string | null;    // raw Stripe status from latest signal
    };
    trajectory: TrajectorySnapshot | null;       // null if no derived.posting_trajectory row exists yet
    hsContact: {
      onboardingNoShowCount: number;            // read from HS Contact property
    };
  };
};

export type BiLayerResult = {
  profile: EngagementProfile;
  trajectory: TrajectorySnapshot;
  outcome: OutcomePrediction;
  action: RecommendedAction | null;             // null when action_type=no_action or unknown outcome
  state: OnboardingState;
  attentionReason: AttentionReason | null;
  sourceDetail: string;                          // 'rule:...' or 'outcome:...' for audit log
};
