# LaunchPad Pass 2.5 Plan — Multi-Layer Intelligence Framework (continuation)

Status: **Pass 2.5 continuation of `docs/plans/post-launch-migration-pass-2.md`**. Augments Pass 2 with predictive-insight layers. All Pass 2 plumbing (`applyStateTransition`, registry, cron, importer, idempotency, taxonomy) STAYS — this adds intelligence atop.

The framing shift: the BI cron no longer "runs rules to set a state." It runs a **5-layer pipeline** (Profile → Trajectory → Predicted Outcome → Recommended Action → State) and persists the outputs of each layer. The Pass 2 rule set collapses into the Layer-3 outcome predictor + the Layer-5 state mapper. The literal threshold rules become inputs to the predictor, not destinations.

---

## §11 — Engagement profile derivation (Layer 1)

### 11.1 Design intent

A Layer-1 **engagement profile** is a categorical label that answers "WHO is this customer right now in terms of product behavior?" — derivable from a SINGLE snapshot of the Rejig usage signals + Stripe state. Profile is orthogonal to attention reason: a customer can be `power_user_declining` AND `engagement_drop_30d` simultaneously — the profile captures behavioral identity, the reason captures the BI alert that fires today.

The decision tree below uses ALL the CSV signals — including the four columns Pass 2 ignored (`Video Posts`, `Image Posts`, `Content Type Breakdown`, `Listing Count`). The tree is `first-match-wins` and order matters.

### 11.2 Final taxonomy — 17 profiles (counts validated against `scripts/data/rejig-accounts-snapshot.csv`)

| # | Profile | Active count | % | Definition (signal predicate) |
|---:|---|---:|---:|---|
| 1 | `power_user` | 178 | 26.1% | `posts >= 50 AND days_since_login <= 14` — heavy adopter, currently active |
| 2 | `steady_user` | 145 | 21.3% | `6 <= posts < 50 AND days_since_login <= 14` — moderate cadence, current |
| 3 | `never_adopted` | 56 | 8.2% | `subscription=active AND has_logged_in_at_least_once AND posts == 0` — got in, never produced content |
| 4 | `light_user_engaged` | 48 | 7.0% | `posts <= 5 AND days_since_login <= 14` — onboarding-stage or low-touch but present |
| 5 | `social_only` | 45 | 6.6% | `posts >= 5 AND listings == 0` — posting but no real-estate inventory linked |
| 6 | `trial_engaged` | 35 | 5.1% | `subscription=trialing AND posts > 0` |
| 7 | `canceled_pending` | 31 | 4.5% | `subscription=canceled` — terminal/transitional |
| 8 | `light_user_dormant` | 27 | 4.0% | `posts <= 20 AND days_since_login > 14` |
| 9 | `paying_but_absent` | 24 | 3.5% | `subscription=active AND last_login IS NULL` |
| 10 | `steady_user_declining` | 22 | 3.2% | `6 <= posts < 50 AND days_since_last_post > 30` |
| 11 | `video_non_adopter` | 20 | 2.9% | `posts >= 10 AND video_posts == 0` — ignoring AI-video feature |
| 12 | `power_user_declining` | 19 | 2.8% | `posts >= 50 AND days_since_last_post > 30` — heavy user, recent peter-out |
| 13 | `power_user_waning` | 11 | 1.6% | `posts >= 50 AND last_login > 14d ago` (and not declining-post) |
| 14 | `listings_only` | 8 | 1.2% | `listings >= 3 AND posts <= 2` — has inventory but isn't auto-posting it |
| 15 | `trial_dormant` | 6 | 0.9% | `subscription=trialing AND posts == 0` |
| 16 | `ineligible` | 4 | 0.6% | terminal / out-of-scope |
| 17 | `steady_user_drifting` | 3 | 0.4% | catch-all grey-zone |

### 11.3 Decision tree (canonical order — pseudo-code)

```ts
function classifyProfile(c: CustomerSignals): EngagementProfile {
  // Terminal / out-of-scope
  if (c.subscriptionStatus === 'canceled') return 'canceled_pending';
  if (c.subscriptionStatus === 'deactivated' || c.subscriptionStatus === null) return 'ineligible';
  if (c.isManual && !c.hasStripeSub && !c.planKey) return 'ineligible';

  // Trialing
  if (c.subscriptionStatus === 'trialing') {
    return c.totalPosts === 0 ? 'trial_dormant' : 'trial_engaged';
  }

  // Active subscription
  if (c.lastLoginAt === null) return 'paying_but_absent';
  if (c.totalPosts === 0) return 'never_adopted';

  // Power-user branches (>=50 lifetime posts)
  if (c.totalPosts >= 50) {
    if (c.daysSinceLastPost > 30) return 'power_user_declining';
    if (c.daysSinceLogin <= 14)   return 'power_user';
    return 'power_user_waning';
  }

  // Feature-specific signals (before generic buckets)
  if (c.totalPosts >= 10 && c.videoPosts === 0) return 'video_non_adopter';
  if (c.listingCount >= 3 && c.totalPosts <= 2) return 'listings_only';
  if (c.totalPosts >= 5 && c.listingCount === 0) return 'social_only';

  // Steady-user branches (6-49 posts)
  if (c.totalPosts >= 6) {
    if (c.daysSinceLogin <= 14)    return 'steady_user';
    if (c.daysSinceLastPost > 30)  return 'steady_user_declining';
    return 'steady_user_drifting';
  }

  // Light-user branches (<=5 posts)
  if (c.daysSinceLogin <= 14) return 'light_user_engaged';
  return 'light_user_dormant';
}
```

### 11.4 Storage

Profile lives on `customers.engagementProfile` (new column, nullable text). Single writer = LP BI cron. Mirrored to HS Contact property `rejig_engagement_profile`.

**This IS a schema migration delta** — a single nullable text column on `customers`. Defended: profile must be queryable for kanban filters, segmentation reports, and cohort analysis.

---

## §12 — Trajectory framework (Layer 2 — design now, fires Phase 9+)

### 12.1 Trajectory taxonomy

| Pattern | Definition | Triggers (Layer 3) |
|---|---|---|
| `ramping` | post velocity ↑ ≥30% over last 3 snapshots | positive |
| `steady` | velocity flat ±20% over last 3 snapshots | neutral |
| `declining` | velocity ↓ ≥30% over last 3 snapshots, first occurrence | `likely_renew_after_intervention` |
| `recovering` | declining pattern then ≥2 snapshots back up | positive — drop CSM urgency |
| `oscillating_2` | declined → recovered → declined again (2nd peter-out) | `likely_churn_in_60d` |
| `oscillating_3` | 3 full cycles of peter-out + return | `likely_churn_in_60d` (high confidence) |
| `terminally_declining` | 3+ consecutive snapshots showing decline, no recovery | `likely_churn_in_30d` |
| `oscillating_4plus` | 4+ peter-outs | `near_certain_churn` |
| `insufficient_data` | <2 snapshots OR <14 days of history | Fallback to single-snapshot |

### 12.2 Velocity metric

`post_velocity_7d` = `(total_posts_snapshot_N - total_posts_snapshot_N-1) / days_between_snapshots`. Also `login_recency_score` = `1 / (1 + daysSinceLogin)`.

### 12.3 New signal type — `derived.posting_trajectory`

Lives in `customer_usage_signals` (no schema change). One row per customer per recomputation.

```jsonc
{
  "signal_type": "derived.posting_trajectory",
  "signal_value_jsonb": {
    "pattern": "oscillating_3",
    "cycles_observed": 3,
    "current_phase": "declining",
    "velocity_history": [2.3, 2.1, 1.4, 0.6, 1.8, 0.4],
    "login_history":    [3, 5, 12, 24, 4, 18],
    "snapshots_evaluated": 6,
    "confidence": "high"
  },
  "observed_at": "<NOW()>",
  "source": "lp_trajectory_job"
}
```

### 12.4 Trajectory computation job

Lives at `src/lib/bi/trajectory-job.ts`. Triggered by snapshot importer (Phase 5) and live-ingestion (Phase 9), NOT by the daily BI cron.

`detectPattern` state machine:
1. Compute deltas between consecutive velocity samples.
2. Mark each transition as `↑` (≥30% up), `↓` (≥30% down), `=` (±20%).
3. Count `↓` → `↑` cycle pairs (one "peter-out + return" = one cycle).
4. Classify based on cycle count + current direction.

### 12.5 "Petering out" mapping (founder's exact mental model)

| Founder's term | System representation | Outcome impact |
|---|---|---|
| 1st peter-out | `declining`, cycles=0 | `likely_renew_after_intervention` |
| Recovery | `recovering`, cycles=1 | Demotes urgency |
| 2nd peter-out | `oscillating_2` | `likely_churn_in_60d` |
| 3rd peter-out | `oscillating_3` | `likely_churn_in_60d` (high confidence) — CSM personal call |
| 4th peter-out | `oscillating_4plus` | `near_certain_churn` |
| 3 declines in a row no recovery | `terminally_declining` | `likely_churn_in_30d` |

---

## §13 — Predicted outcome rules (Layer 3)

### 13.1 Outcome taxonomy — 6 buckets

| Outcome | Definition |
|---|---|
| `likely_renew` | Health strong; no negative signals dominate |
| `likely_renew_after_intervention` | Recoverable decline; targeted nudge expected to retain |
| `likely_churn_in_60d` | Multiple negative signals or 2-3 trajectory cycles |
| `likely_churn_in_30d` | Hard signals (payment failed) OR `terminally_declining` |
| `near_certain_churn` | 4th peter-out OR canceled-pending close to expiry |
| `unknown` | Insufficient data |

### 13.2 Per-outcome rule definitions

(See full agent output for combinatorial rules; high-level summary below.)

- `likely_renew`: healthy profile + healthy trajectory + no payment issues
- `likely_renew_after_intervention`: declining profiles (`power_user_declining`, `video_non_adopter`, `listings_only`, mid-tenure `never_adopted`)
- `likely_churn_in_60d`: oscillating trajectory OR power_user_declining at high tenure + near expiry
- `likely_churn_in_30d`: payment_failed OR `terminally_declining` OR past_due
- `near_certain_churn`: `oscillating_4plus` OR canceled near expiry OR 90+ day paying_but_absent

### 13.3 Pluggable predictor interface

`src/lib/bi/outcome-predictor.ts` exports `OutcomePredictor` interface so Phase 9+ can swap deterministic rules for a trained model without changing the cron handler.

---

## §14 — Recommended actions (Layer 4)

### 14.1 Action library (15 templates)

| # | Trigger | Action type | Content | Urgency |
|---:|---|---|---|---|
| A1 | `likely_renew` | `no_action` | — | `monitor` |
| A2 | `likely_renew_after_intervention` + `power_user_declining` | `email_template` + `task_create` | "Re-engagement email referencing top past posts; CSM check-in next week" | `this_week` |
| A3 | `likely_renew_after_intervention` + `power_user_waning` | `email_template` | "'We miss you' nudge with industry article" | `this_week` |
| A4 | `likely_renew_after_intervention` + `never_adopted` | `loom_send` + `task_create` | "90-second walkthrough Loom; onboarding refresher call" | `this_week` |
| A5 | `likely_renew_after_intervention` + `video_non_adopter` | `loom_send` | "'Create your first AI video' Loom" | `monitor` |
| A6 | `likely_renew_after_intervention` + `listings_only` | `loom_send` | "'Auto-post your listings' tutorial" | `monitor` |
| A7 | `likely_renew_after_intervention` + `steady_user_declining` | `email_template` | "'3 quick post ideas this week' nudge" | `this_week` |
| A8 | `likely_churn_in_60d` + `oscillating_2` | `task_create` + `email_template` | "Personal CSM email; ask 'what's been hard?'" | `this_week` |
| A9 | `likely_churn_in_60d` + `oscillating_3` | `csm_call` | "**CSM personal call THIS WEEK; root-cause discovery (forgot/hard/value)**" | `today` |
| A10 | `likely_churn_in_60d` + `paying_but_absent` | `csm_call` | "Outbound; verify access; offer onboarding redo" | `today` |
| A11 | `likely_churn_in_30d` + payment_failed | `task_create` + `email_template` | "Billing follow-up; updated payment link" | `today` |
| A12 | `likely_churn_in_30d` + `terminally_declining` | `csm_call` | "Last-chance call; offer pause/downgrade" | `today` |
| A13 | `near_certain_churn` + `oscillating_4plus` | `csm_call` | "**4th peter-out; CSM call THIS WEEK; pause vs cancel offer**" | `today` |
| A14 | `near_certain_churn` + `canceled_pending`, exp ≤14d | `email_template` | "Last-week reactivation offer (20% off renewal)" | `today` |
| A15 | `unknown` | `no_action` | — | `monitor` |

### 14.2 Surfacing — two tiers

**Tier A (always):** HubSpot Contact/Ticket properties (passive — `rejig_recommended_action`, `_set_at`, `_urgency`).

**Tier B (only when urgency = today/this_week):** HubSpot Task creation on the Ticket. Idempotency: skip if open task with same `lp_action_template_id`.

### 14.3 Dampening

- Task-level dedup (HubSpot open tasks)
- Property-level dampening: if same `(customer, action)` fired in last 7 days AND outcome hasn't worsened, skip the write. Stored as `derived.action_fired` signals.

---

## §15 — Updated state mapping (Layer 5)

The Pass 2 §2 rule list collapses into a state mapper that maps `predicted_outcome` (+ hard overrides) to a kanban state.

### 15.1 Mapping table (overrides checked first)

| Layer 3 outcome | Override conditions | Default state | Reason |
|---|---|---|---|
| (any) | sub canceled + exp ≤0 | `Churned` | null |
| (any) | sub.cancelled signal in last 7d | `Churned` | null |
| (any) | payment_failed in 14d no payment_succeeded after | `Critical` | `payment_failed` |
| (any) | sub past_due | `At-Risk` | `payment_past_due` |
| (any) | no_show_count ≥2 + pre-launch state | `At-Risk` | `no_show_pattern` |
| (any) | stuck in pre-launch >14d | `At-Risk` | `stuck_in_onboarding` |
| (any) | B2B-Keyes + Active + no sub + >24h | `At-Risk` | `payment_past_due` (sd:`trial_not_activated`) |
| `near_certain_churn` | — | `Critical` | `engagement_drop_30d` |
| `likely_churn_in_30d` | — | `At-Risk` | `engagement_drop_30d` |
| `likely_churn_in_60d` | — | `At-Risk` | `engagement_drop_30d` |
| `likely_renew_after_intervention` | — | `Watch` | derived from Layer 1 |
| `likely_renew` | — | `Active` | null |
| `unknown` | — | (no change) | (no change) |

### 15.2 Watch attention reason from Layer 1

Profile-driven reason within Watch:
- `power_user_*`, `steady_user_declining`, `light_user_dormant` → `engagement_drop_30d`
- `never_adopted`, `paying_but_absent` → `engagement_drop_30d` (source_detail differs)
- `video_non_adopter`, `listings_only` → `engagement_drop_30d` (source_detail differs)
- renewal-window (days_until_expiry 0-14 / 15-42) → `renewal_approaching_2w/6w` (overrides profile)

### 15.3 The collapse of the 11 Pass-2 rules

Pass 2's 11 rule files → 5 evaluator files in `src/lib/bi/`:
1. `profile-classifier.ts` (Layer 1)
2. `trajectory-job.ts` (Layer 2)
3. `outcome-predictor.ts` (Layer 3)
4. `action-recommender.ts` (Layer 4)
5. `state-mapper.ts` (Layer 5 — replaces all 11 rule files)

---

## §16 — Updated HubSpot Contact/Ticket properties

| # | Property | Type | Object | Verdict |
|---:|---|---|---|---|
| 1 | `rejig_last_login` | Date | Contact | KEEP from Pass 2 |
| 2 | `rejig_days_since_last_post` | Number | Contact | KEEP from Pass 2 |
| 3 | `rejig_days_until_expiry` | Number | Contact | KEEP from Pass 2 |
| 4 | `rejig_engagement_profile` | Dropdown (17 values) | Contact | **ADD** — orthogonal to attention_reason; CSM filter |
| 5 | `rejig_predicted_outcome` | Dropdown (6 values) | Contact | **ADD** — daily prioritization queue |
| 6 | `rejig_recommended_action` | Multi-line text | Ticket | **ADD** — per-intervention specificity |
| 7 | `rejig_recommended_action_set_at` | Datetime | Ticket | **ADD** — freshness indicator |
| 8 | `rejig_recommended_action_urgency` | Dropdown (today/this_week/monitor) | Ticket | **ADD** — list-view color hint |
| 9 | `rejig_posting_trajectory` | Dropdown (9 values) | Contact | **ADD (NULL until ≥2 snapshots)** — Phase 9 forward-compat |

**Net 6 new properties** (Pass 2's 3 + 6 new from 2.5 = 9 total). Each defended against lean-properties anti-patterns. None duplicate Stripe-mirrored data (`rejig_subscription_status` etc. remain dropped).

---

## §17 — Single-snapshot vs multi-snapshot behavior

| Layer | At N=1 snapshot (today) | At N=2 (Phase 9 day 1) | At N=7 (week 1) | At N=21+ (~3 weeks) |
|---|---|---|---|---|
| Profile (1) | Fully functional | Same | Same | Same |
| Trajectory (2) | `insufficient_data` | First non-insufficient (mostly `steady`) | `ramping`/`declining` reliable | Cycle detection live |
| Outcome (3) | Layer-1-driven; trajectory-conditioned outcomes skipped | Marginally better | High confidence on healthy/declining | Founder's "3rd peter-out" fires |
| Action (4) | A1-A7, A10, A11, A14 fire; A8/A9/A12/A13 deferred | Same | Same | A8/A9/A12/A13 begin firing |
| State (5) | Fully functional, predictive accuracy improves over time | Same | Same | Same |

---

## §18 — Cohort validation + brokerage-level risk

### 18.1 Distribution validation

All 17 profiles have ≥1 customer. Largest profile = 26.1% (`power_user`) — well under 40% ceiling. 100% coverage of active base.

### 18.2 Per-brokerage at-risk %

| Brokerage | Total | At-risk profiles | % at-risk |
|---|---:|---:|---:|
| `unique` | 20 | 15 | **75%** |
| `arcrealty` | 6 | 5 | **83%** |
| `agentship` | 10 | 2 | 20% |
| `kcn` | 16 | 4 | 25% |
| `baird` | 221 | 27 | 12% |
| `keyes` | 72 | 9 | 13% |
| `d2c_or_unknown` | 304 | 77 | 25% |

**`unique` and `arcrealty` cohorts show brokerage-level distress.** System-level alert fires when >50% of a brokerage's customers in `*_declining` or `paying_but_absent` for ≥7 days.

---

## §19 — Open questions (revised)

1. **Carry-over** Brokerages outside the 4-channel enum (52 customers in `unique`/`kcn`/`agentship`/`arcrealty`) — skip in Phase 5; Phase 6 identity mapping handles.
2. **`rejig_engagement_profile` cardinality (17 values).** OK with this many? Recommendation: ship 17; review at 30 days.
3. **Trajectory threshold sensitivity.** 30%↓ / 20%↑ deltas; cycle-length ≥7 days. Confirm thresholds (alternatives: 50%↓/30%↑ less sensitive, or 20%↓/15%↑ more sensitive).
4. **HS Task auto-creation aggression.** Tier-B auto-creates ~50-100 tasks/run. Properties-only for v1 launch? Flip Tier B on after 1 week of property-only? **Recommendation: properties-only initially.**
5. **Customer-visible profile labels?** Recommendation: NO — internal-only.
6. **Multi-snapshot enablement gate.** Recommendation: ≥3 distinct snapshots over ≥7 calendar days.
7. **`LP_HUBSPOT_APP_ID` discrepancy** — verified `39386685` is correct.
8. **Cohort-level alert threshold.** Recommendation: 50% of brokerage in `*_declining`/`paying_but_absent` for ≥7d → alert.
9. **Action library ownership.** Recommendation: LP product owner; PR-gated changes.
10. **Profile churn dampening.** Recommendation: profile change must persist ≥48h before being persisted.

---

## §20 — Cross-cutting risks (Pass 2.5 additions)

| # | Risk | Severity | Mitigation |
|---:|---|---|---|
| 9 | Profile boundary thrashing | Medium | 48h hysteresis on profile change |
| 10 | Trajectory noise from missed snapshots | High | Require ≥3 snapshots over ≥7d before non-insufficient; cycle counter requires ≥7d between adjacent peter-outs |
| 11 | Low-confidence predictions auto-creating tasks | High | Tier-B task creation gated on `confidence='high'` only |
| 12 | Algorithm staleness — single-snapshot thresholds | Medium | Quarterly threshold review; constants versioned (`PROFILE_THRESHOLDS_V1`) |
| 13 | Brokerage cohort distress unsurfaced | Medium | System-level alert at >50% at-risk; admin dashboard |
| 14 | Action library overlap (multiple templates match) | Medium | Library ordered by urgency descending; first-match-wins; test asserts urgency-monotonic |
| 15 | Phase 9 vs Phase 5 `observed_at` semantics drift | Medium | Lock contract NOW: `observed_at` = canonical event time, never ingestion time |

---

## Wrap-up — net delta from Pass 2

| Pass 2 | Pass 2.5 disposition |
|---|---|
| `applyStateTransition` helper | KEEP |
| `customer_usage_signals` schema | KEEP; add `derived.posting_trajectory` + `derived.action_fired` signal types |
| BI cron architecture | KEEP; rule files reorganized into 5 evaluators |
| Snapshot importer | KEEP; add post-import `computeTrajectories` call |
| Locked attention-reason enum (10 values) | KEEP unchanged |
| 3 HS Contact properties | KEEP; add 6 more (total 9) |
| 11 BI rule files | REPLACE with 5 evaluator files |
| Open questions / risks | 4 carry forward; 6 added in §19; 7 risks added in §20 |

**Net effort delta:** ~+2-3 days (from Pass 2's ~7 days to ~9-10 days total).

### Critical Files for Implementation (5 new evaluator files)

- `src/lib/bi/profile-classifier.ts` (Layer 1)
- `src/lib/bi/trajectory-job.ts` (Layer 2)
- `src/lib/bi/outcome-predictor.ts` (Layer 3 — pluggable for Phase 9 model)
- `src/lib/bi/action-recommender.ts` + `src/lib/bi/action-library.ts` (Layer 4)
- `src/lib/bi/state-mapper.ts` (Layer 5 — replaces Pass 2's 11 rule files)
</content>
</invoke>