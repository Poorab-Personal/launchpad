# HubSpot Engagement Card — Data Review

**Status:** Review for Phase 2c. **Date:** 2026-05-17. **Scope:** the Contact-bound `EngagementCard.jsx` at `launchpad-integration/src/app/cards/EngagementCard.jsx`.

Phase 2b just shipped: posts last 7d / total posts / listings / video / image / signals_observed_at. This document inventories every Rejig + LP signal we already capture, identifies what is missing from the card, and proposes additions ranked by CSM utility.

---

## 1. Inventory — what we capture vs what we show

Sources abbreviated:
- **CUS** = `customer_usage_signals` (signal_type, signalValueNumeric or signalValueJsonb path).
- **CUST** = `customers` column.
- **CSUB** = `customer_subscriptions` column (Core product row).
- **CST** = `customer_state_transitions` (latest row, with `payload` jsonb).
- **BiContext** = computed in `src/lib/bi/context.ts`.

| Signal / field | Source | Current HS property | On card today |
|---|---|---|---|
| Engagement profile | classifyProfile output | `rejig_engagement_profile` | yes |
| Predicted outcome | RuleBasedOutcomePredictor | `rejig_predicted_outcome` | yes |
| Posting trajectory pattern | `derived.posting_trajectory` jsonb.pattern | `rejig_posting_trajectory` | yes |
| Trajectory confidence | `derived.posting_trajectory` jsonb.confidence | — | **no** |
| Trajectory cyclesObserved / currentPhase / velocityHistory / firstDeclineObservedAt / lastRecoveryObservedAt | trajectory jsonb | — | no |
| Outcome reasoning (predicates) | `CST.payload.outcomeReasoning` | — | **no** |
| Outcome confidence | `CST.payload.outcomeConfidence` | — | no |
| Action template id | `CST.payload.actionTemplateId` | (on Ticket: `rejig_recommended_action`) | no (Contact) |
| Last login | CUS `rejig.last_login` jsonb.lastLoginISO | `rejig_last_login` | yes |
| Days since last post | CUS `rejig.days_since_last_post` | `rejig_days_since_last_post` | yes |
| Days until expiry | CSUB `current_period_end` (fallback signal) | `rejig_days_until_expiry` | yes |
| Total posts | CUS `rejig.total_published_posts` | `rejig_total_posts` | yes |
| Video posts / Image posts | CUS `rejig.total_published_posts` jsonb | `rejig_video_posts` / `rejig_image_posts` | yes |
| Posts last 7d | computed in BI cron | `rejig_posts_last_7d` | yes |
| Listing count | CUS `rejig.listing_count` | `rejig_listing_count` | yes |
| Content-type breakdown | CUS `rejig.total_published_posts` jsonb.contentTypeBreakdown | — | **no** |
| Plan key | CUS `rejig.days_until_expiry` jsonb.planKey | — | **no** |
| Plan expiry date (ISO) | same jsonb | — | (only derived days) |
| isManual (Rejig plan flag) | same jsonb | — | no |
| Rejig subscription_status (raw) | CUS `rejig.account_active` jsonb | — | no |
| Account active (0/1) | CUS `rejig.account_active` numeric | — | no |
| Signals observed at | CUS observed_at | `rejig_signals_observed_at` | yes (footer) |
| Brokerage channel | derived from workflowKey | `rejig_brokerage_channel` | yes |
| Payment mode | derived | `rejig_payment_mode` | no |
| Billing relationship | `customers.billingRelationship` | `rejig_billing_relationship` | **no** |
| Customer type (D2C / B2B) | `customers.type` | implicit in channel | no |
| Tenure days | computed from `customers.createdAt` | — | **no** |
| Stripe Customer ID / Sub ID | customers | `stripe_customer_id` | no (link only) |
| Selected plan name | `customers.selectedPlanName` | — | no |
| MRR | `customers.mrr` (and CSUB.mrr) | — | no |
| current_period_start / end / start_source | CSUB | — | no |
| last_invoice_status / last_invoice_url | CSUB | — | **no** |
| Payment source | CSUB.paymentSource | — | no |
| Subscription status (LP) | `customers.subscriptionStatus` | — | no |
| Onboarding state | `customers.onboardingState` | (on Ticket: hs_pipeline_stage) | no |
| Attention reason (Contact-level) | `customers.attentionReason` | (on Ticket: `rejig_attention_reason`) | no |
| Attention set at | `customers.attentionSetAt` | (on Ticket: `rejig_attention_set_at`) | no |
| Stage entered at | `customers.stageEnteredAt` | — | no |
| Onboarding no-show count | HS Contact | `onboarding_no_show_count` | yes (conditional) |
| Last stripe payment_failed/succeeded | CUS `stripe.invoice.*` | — | no |
| Last stripe sub status | CUS `stripe.subscription.updated` jsonb | — | no |
| Last state transition (from→to, ts, source) | latest CST row | — | **no** |
| Engagement score (legacy) | `customers.engagementScore` | — | no |
| Days since login (computed) | BiContext.signals.rejig.daysSinceLogin | — | no |
| Posts velocity history | trajectory jsonb.velocityHistory[] | — | no |
| LaunchPad customer ID | `customers.id` | `launchpad_customer_id` | yes (link) |
| Rejig user ID | `customers.rejigUserId` | `rejig_user_id` | no |
| CSM owner | `customers.csmTeamMemberId` | — | no |

---

## 2. Recommended additions — ranked by CSM utility

### Tier A — high value, low UX cost

**A1. Outcome reasoning (top 2 predicates)**
- **Why:** Today a CSM sees "Likely churn in 30d" with zero context. The reasoning array is exactly the human-readable evidence ("trajectory.pattern='terminally_declining'", "stripe.lastSubscriptionStatus='past_due'", "paying_but_absent + tenureDays=92"). Highest-leverage addition: converts a black-box label into a debuggable signal.
- **Source:** `customer_state_transitions.payload.outcomeReasoning: string[]` (already written by BI cron). Latest row per customer.
- **HS property needed:** yes. `rejig_outcome_reasoning` (textarea — first 2 reasons joined by " · ", humanized: strip quotes, replace `=` with " "). Set by BI cron alongside the existing predicted-outcome push.
- **Card UX:** inline microcopy beneath the **Predicted** row. Italic, muted color. No new tile.

**A2. Trajectory confidence**
- **Why:** "Declining (low confidence)" tells a CSM "wait one more snapshot." "Declining (high confidence)" says "act now."
- **Source:** `derived.posting_trajectory.signalValueJsonb.confidence` ∈ low/medium/high. Already in `BiContext.signals.trajectory.confidence`.
- **HS property needed:** yes. `rejig_posting_trajectory_confidence` (enumeration low/medium/high). Trivial cron addition.
- **Card UX:** subscript Tag next to the trajectory label: "Declining (medium)". Same row; no extra space.

**A3. Billing relationship**
- **Why:** A CSM who doesn't know "this is a comped exec account" misallocates effort on an at-risk signal.
- **Source:** `customers.billingRelationship` ∈ paying|comped|internal_demo. HS property `rejig_billing_relationship` already exists.
- **HS property needed:** no — just add to `PROPS` array in `EngagementCard.jsx`.
- **Card UX:** small Tag in top header row. Render only when value is `comped` (label "Comped"). Suppress for `paying` and `internal_demo`.

**A4. Plan key + plan expiry absolute date**
- **Why:** "Days until expiry: 12" leaves CSM guessing. Knowing plan_key ("standard_luxury", "keyes_trial") and date converts to "Standard Luxury expires May 26".
- **Source:** CUS `rejig.days_until_expiry` jsonb.planKey + jsonb.planExpiryDate.
- **HS property needed:** yes. `rejig_plan_key` (text). Plan expiry date can be derived from existing properties or push `rejig_plan_expiry_date` (datetime).
- **Card UX:** replace "Days until expiry" row with two-line cell. Line 1: "Plan: Standard Luxury". Line 2: "Expires in 12 days (May 26)".

**A5. Days-since-login surfacing**
- **Why:** A CSM scanning needs "27" — a number — more than the parenthesized date. When customer has never logged in, card shows "—" with no explanation.
- **Source:** Already in BiContext. Derivable from existing `rejig_last_login`.
- **HS property needed:** no — derive in card.
- **Card UX:** when last_login is null but `rejig.account_active` shows the account exists, render "Never logged in" explicitly. When days >=14, color warning; >=30 danger.

### Tier B — useful, moderate cost

**B1. Top 3 content types** — `rejig_top_content_types` (textarea). "Listings (65) · Industry News (54) · Articles (51)".
**B2. Last state transition** — 4 new properties (from / to / set_at / source). "Active → Watch · 3d ago (lp_bi)".
**B3. Tenure** — derive from HubSpot's native `createdate`. No new properties.
**B4. Onboarding state (Contact-level mirror)** — `rejig_onboarding_state` (enum). Mirrors what's on the Ticket.

### Tier C — defer

- **C1. Subscription period dates + last_invoice_status** — belongs on the planned Stripe card #1.
- **C2. Stripe link button** — small addition; just uses existing `stripe_customer_id`.
- **C3. Outcome confidence** — redundant with outcome label.
- **C4. Last payment failed/succeeded** — out of scope for engagement card.
- **C5. Velocity history sparkline** — `@hubspot/ui-extensions` doesn't support SVG; just numeric.

---

## 3. Recommended omissions

- **`payment_mode`** — operational detail. Useful for backend automation, not for CSM glance.
- **`launchpad_customer_id` / `rejig_user_id` as visible IDs** — opaque UUIDs. Keep them only as link targets.
- **Trajectory `velocityHistory` raw array** — defer or render as a tile.
- **`engagement_score` / `last_engagement_briefing`** — legacy fields from pre-BI plan.
- **Raw `customers.currentStage`** — pre-launch state machine. Post-launch use `onboardingState`.
- **Stripe `subscription_status` raw value** — we already classify into LP subscription status.
- **`customer_period_start_source`** — internal provenance.
- **`onboarding_no_show_count` when zero** — current card already conditionally hides.
- **`isManual` Rejig plan flag** — internal trial billing oddity.

---

## 4. Proposed card layout

```
┌──────────────────────────────────────────────────────────┐
│ [Brokerage] [Comped?] [State: Watch]   On Rejig 14 months│  ← A3, B3, B4
│                                                          │
│ Profile     Power user, declining                        │
│ Predicted   Likely churn in 30d                          │
│   why: trajectory=terminally_declining · paying_but…     │  ← A1 reasoning
│ Trajectory  Declining (medium)                           │  ← A2 confidence
│ State       Active → Watch · 3d ago (lp_bi)              │  ← B2 (optional)
│ ──────────────────────────────────────────────────────── │
│ Posts last 7d  ·  Total posts  ·  Listings               │  (existing)
│       2              140            12                   │
│ Video posts  ·  Image posts                              │  (existing)
│     20             63                                    │
│ Mix: Listings (65) · Industry News (54) · Articles (51) │  ← B1 (optional)
│ ──────────────────────────────────────────────────────── │
│ Last login         3 days ago (2026-05-11) · 3d          │
│ Days since post    14                                    │
│ Plan               Standard Luxury                       │  ← A4
│ Renewal            Expires in 12 days (May 26)           │  ← A4
│ No-shows so far    2                                     │
│ ──────────────────────────────────────────────────────── │
│ → Open customer in LaunchPad admin                       │
│ → Open in Stripe (conditional, C2)                       │
│                                                          │
│ Rejig data as of 2 days ago (2026-05-12)                 │  (existing)
└──────────────────────────────────────────────────────────┘
```

### Section ordering rationale

1. **Header (state, channel, tenure, billing flag)** — answers "how severe, who is this, how long around"
2. **BI summary block (profile / predicted / why / trajectory / state history)** — "what does the model think and why"
3. **Statistics tiles** — "how active"
4. **Plan / renewal / no-shows** — "what's the deadline / risk timeline"
5. **Action links** — bottom, out of the way
6. **Freshness footer** — last

### Implementation order

1. **A1 (outcome reasoning)** — single highest-leverage. 1 property, cron write, card microcopy.
2. **A2 (trajectory confidence)** — 1 property, trivial cron and card change.
3. **A3 (billing relationship surfacing)** — 0 new properties, 2 lines of card code.
4. **A4 (plan key + label)** — 1-2 new properties, label map, row replacement.
5. **B4 (onboarding state on Contact)** — 1 new property, 1 new tag.
6. **B3 (tenure)** — read `createdate`, render bucket. No new properties.
7. **B1 (top 3 content types)** — 1 new textarea property.
8. **B2 (last state transition)** — 4 new properties; consider LP-API fetch alternative.
9. Defer Tier C until usage data justifies.

### Risks / gotchas

- BI cron's `updateContactProperties` payload is currently 11 keys; Tier A + B adds ~9 more. Verify HS API call still fits — HubSpot allows hundreds per request. No change needed.
- `rejig_outcome_reasoning` currently has code-style predicates (`"trajectory.pattern='terminally_declining'"`). Either humanize in cron or in card. **Cron is better** — humanized strings useful in HS reports too.
- Reasoning array can be empty. Render nothing rather than empty bullet.
- For `comped` accounts, BI cron still runs (only `internal_demo` is skipped). Payment-related outcomes should still NOT fire for comped — that's a state-mapper tuning task, not a card issue.

---

### Critical files for implementation

- `launchpad-integration/src/app/cards/EngagementCard.jsx`
- `scripts/setup-hubspot-properties.ts`
- `src/app/api/cron/bi/route.ts`
- `src/lib/bi/context.ts`
- `src/lib/bi/outcome-predictor.ts`
