Excellent. I have everything I need. Now I'll write the plan.

---

# LaunchPad Pass 2 Plan — Phases 4 & 5 (BI rules engine + Rejig snapshot ingestion)

Status: Pass 2 plan. Phases 1, 2, 3 shipped. This plan locks scope for Phases 4 + 5 with data-backed thresholds. Open questions in §9 must be resolved before execution.

---

## 1. Data analysis findings

**Source:** `/Users/poorabshah/dev/rejig-ai/launchdeck/scripts/data/rejig-accounts-snapshot.csv`, 682 rows (one trailing blank row), snapshot dated 2026-05-11.

### 1.1 Subscription state buckets

| Subscription Status | Count | % of total |
|---|---:|---:|
| `active` | 608 | 89.1% |
| `trialing` | 41 | 6.0% |
| `canceled` | 31 | 4.5% |
| `deactivated` | 1 | 0.1% |
| (empty) | 1 | 0.1% |

Notes:
- No `past_due` rows in the snapshot. Past-due is a real Stripe state but it transitions quickly into `canceled` or back to `active`; the snapshot only captures terminal states. **Past-due signals must come from Stripe webhook events** (already captured) — the Rejig snapshot cannot drive past-due rules.
- `canceled` status with future `Plan Expiry Date` is normal — these are "cancel at period end" customers still paying-through.

### 1.2 Plan Key vs Manual vs Broker

| Plan Key | Count | Notes |
|---|---:|---|
| `standard_luxury` | 481 | B2B-dominant (346/481 have Broker ID) |
| `standard_premium` | 171 | D2C-dominant (only 1 with Broker ID) |
| (empty) | 30 | All `Is Manual=TRUE` — orphan/legacy accounts |

| Is Manual | Stripe Sub ID? | Count |
|---|---|---:|
| `FALSE` | has | 391 |
| `TRUE` | none | 290 |

**Perfect bijection: Manual=TRUE ↔ no Stripe subscription.** Manual customers are non-billing legacy/B2B-bulk accounts. **390 of the 391 non-manual customers have a Stripe sub** (one outlier — empty status). This means:

1. Stripe webhook BI rules (payment_failed, past_due) only apply to ~391 customers.
2. Manual customers (290) have no payment signal — they can only be evaluated on engagement + expiry-date signals.
3. The 30 empty-Plan-Key rows are entirely Manual=TRUE: deactivated or pre-paid bulk accounts likely. They're a separate cohort that should probably not be in active BI evaluation at all (out-of-scope cohort).

### 1.3 Broker ID distribution (6 distinct values)

| Broker ID | Count | LP `rejig_brokerage_channel` mapping |
|---|---:|---|
| `baird` | 221 | `b2b_bw` ✓ |
| `keyes` | 73 | `b2b_keyes` ✓ |
| `unique` | 20 | **NOT in LP enum** |
| `kcn` | 17 | **NOT in LP enum** — but mentioned in `rejig_brokerage_channel` matrix elsewhere? No, our enum is `d2c / b2b_keyes / b2b_bw / b2b_ipre`. |
| `agentship` | 10 | **NOT in LP enum** |
| `arcrealty` | 6 | **NOT in LP enum** |
| (empty) | 335 | D2C or unknown — most `standard_premium` rows |

**Risk surfaced:** 53 customers belong to brokerages we don't model. They'll back-fill as D2C with `manual_review_brokerage_unknown` per scrutiny point 11 in Pass 1, but the BI rules need to be aware that B2B-specific rules (trial activation, no Stripe sub on active) might fire spuriously on them. **Question 1 in §9.**

### 1.4 Days Until Expiry distribution (681 parsed)

| Bucket | Count |
|---|---:|
| 0 (today) | 5 |
| 1–14 (2w window) | 84 |
| 15–42 (6w window) | 123 |
| 43–90 | 45 |
| 90+ | 424 |

**Cross with Subscription Status:**

| Status | 0–14 | 15–42 | 43–90 | 90+ |
|---|---:|---:|---:|---:|
| active | 73 | 91 | 41 | 403 |
| trialing | 13 | 28 | 0 | 0 |
| canceled | 3 | 3 | 4 | 21 |

**No negative `Days Until Expiry` exists in the snapshot.** Either the source already removes lapsed accounts, or there's a normalization on Rejig's side. **This means "expired" cannot be inferred from the snapshot alone**; for the live pipeline (Phase 9) this assumption must be re-verified, but for Phase 5 snapshot ingestion: treat absence as "still inside grace period." The Stripe webhook owns the real lapse signal.

### 1.5 Last Login distribution (days since)

| Bucket | Count |
|---|---:|
| ≤7d | 413 (60.6%) |
| 8–14d | 73 |
| 15–30d | 40 |
| 31–60d | 39 |
| 61–90d | 30 |
| 91–180d | 35 |
| 181–365d | 13 |
| >365d | 8 |
| never | 31 |

**Of 608 active customers:**
- 100 logged in >30d ago (16.4%) — engagement_drop_30d candidates
- 64 >60d (10.5%) — engagement_drop_60d candidates
- 45 >90d (7.4%)
- 24 active customers have **never logged in** (half manual, half non-manual — these are paying customers who never used the product)

Threshold pick: **30 days = the natural shoulder** in the histogram (drops from 73 in the 8–14d bucket to 40 in 15–30d to 39 in 31–60d). Pre-Pass-2 plan and 0b enum already enshrine `engagement_drop_30d`; the data supports it.

### 1.6 Days Since Last Post (already-numeric column from Rejig)

| Bucket | Count |
|---|---:|
| ≤7 | 381 |
| 8–14 | 46 |
| 15–30 | 39 |
| 31–60 | 31 |
| 61–90 | 23 |
| 91–180 | 40 |
| 181–365 | 19 |
| >365 | 12 |
| never_posted | 91 |

**Of 528 active customers with posting history:** 98 have >30d since last post (18.6%); 68 have >60d (12.9%); 53 have >90d (10.0%).

The "never posted" cohort is 91 customers — of which **80 are `active` subscribers with 0 posts**. Breakdown of those 80:
- 24 never logged in (paying for unused product)
- 27 logged in within 14d but never posted (onboarded but not adopting content)
- 10 logged in 15–30d ago
- 9 logged in >90d ago (lapsed before adopting)

Distinct signal candidates here: `never_adopted_content` (paying, no posts ever, logged in >14d ago) is different from `engagement_drop_30d` (was posting, has stopped).

### 1.7 Total Published Posts (lifetime usage proxy)

| Posts | Count |
|---|---:|
| 0 | 90 |
| 1–5 | 101 |
| 6–20 | 151 |
| 21–50 | 117 |
| 51–100 | 89 |
| 101+ | 133 |

Wide adoption spread. The light-user cohort (1–5 lifetime posts) is 101 customers; combined with 0-post = 191 (28% of all customers). Heavy adopters (51+) = 222 (33%).

### 1.8 Listing Count

| Listings | Count |
|---|---:|
| 0 | 144 |
| 1–3 | 261 |
| 4–10 | 161 |
| 11–30 | 79 |
| 31+ | 36 |

Listings are a real-estate-specific signal — agents not adding listings indicates low product engagement on the listings flow specifically. **Likely not load-bearing for v1 BI rules** because the broader engagement signals (login + posts) are more direct. Defer to later iteration.

### 1.9 Cross-correlations

- **Active + never logged in (24 customers):** half are manual, half are paying via Stripe. These are paying for product they don't touch — high-value churn risk. Distinct rule warranted: `never_signed_in_14d_post_launch` or similar.
- **Active + 0 posts + login within 14d (27 customers):** the "logged in but not adopting" cohort. Different intervention than "stopped engaging."
- **Active + login ≤14d + post_days >30 (15 customers):** still active in the product but stopped publishing — sometimes the lead signal for full disengagement. Marginal cohort — borderline whether to bother.
- **Canceled with recent activity (a handful):** customers in "cancel at period end" who are still using the product. Should NOT be in `Churned` — they're still on `Active` semantically.
- **Trialing + 0 posts + expiry ≤14d: 0 customers in this snapshot.** Either we don't have trial customers in the urgent-2-week pre-expiry window with zero engagement, or trial customers always do at least one post (good news; trial activation is working).

### 1.10 Outliers / messy data

- **30 rows have empty Plan Key + Is Manual=TRUE + no Stripe ID.** These look like deactivated/legacy/bulk accounts. Phase 5 import should still capture their signals (they have rejig_user_id), but Phase 4 BI rules should skip customers with `subscriptionStatus IS NULL`.
- **53 rows have Broker IDs outside our 4-channel enum.** Phase 5 import: capture as-is; Phase 6 identity-mapping handles backfill.
- **1 row with empty subscription status** — almost certainly a data quality issue at export. Skip in BI evaluation.

### 1.11 Renewal-window cohort (active customers)

- **2w window (≤14 days to expiry):** 73 active customers
- **6w window (15–42 days):** 91 active customers
- **>42d:** 444 active customers

Both `renewal_approaching_2w` and `renewal_approaching_6w` reasons in the locked enum have substantial cohorts to act on. The 6w window must fire BEFORE the 2w window for the same customer (otherwise on day-43 we set 6w, customer drifts to day-13 — still in 2w window — and we'd need to advance the reason).

---

## 2. Proposed BI rules

### 2.1 Rule taxonomy + priority ordering

Rules fire **first-match-wins**, ordered by severity then specificity. Higher severity = lower priority number = evaluated first.

| Priority | Rule name | Severity (stage) | Reason code | Data sources |
|---:|---|---|---|---|
| 10 | `subscription_cancelled` | Churned | (none — terminal) | Stripe webhook (`stripe.subscription.cancelled`) + `subscriptionStatus` |
| 20 | `payment_failed` | Critical | `payment_failed` | Stripe webhook (`stripe.invoice.payment_failed`) |
| 30 | `payment_past_due` | At-Risk | `payment_past_due` | Stripe webhook (subscription status `past_due`/`unpaid`/`incomplete`) |
| 40 | `trial_not_activated` | At-Risk | `payment_past_due` (reused; see §2.5) | LP state (`workflowKey` B2B + ticket=Active + no `stripeSubscriptionId`) |
| 50 | `no_show_pattern` | At-Risk | `no_show_pattern` | HS Contact `onboarding_no_show_count` ≥ 2 |
| 60 | `stuck_in_onboarding` | At-Risk | `stuck_in_onboarding` | `customer_state_transitions` (ticket in same pre-launch stage >14d) |
| 70 | `renewal_approaching_2w` | Watch | `renewal_approaching_2w` | `renewalDate` / `customer_usage_signals` (`rejig.days_until_expiry`) |
| 80 | `engagement_drop_30d` | Watch | `engagement_drop_30d` | `customer_usage_signals` (`rejig.last_login` >30d ago) |
| 90 | `never_signed_in_post_launch` | Watch | `engagement_drop_30d` (reused) | `customer_usage_signals` `rejig.last_login` IS NULL + onboardingState=`Active` + transitioned to Active >7d ago |
| 100 | `renewal_approaching_6w` | Watch | `renewal_approaching_6w` | Same as priority 70 |
| 110 | `bi_recovery` | Active | (clear) | Heal: no rule fires + currently in Watch/At-Risk |

This is **11 rules** — under the 8-15 target and covers payment, engagement, stuck-in-stage, renewal, B2B-specific, no-show. Two new rule names beyond the locked enum (`trial_not_activated`, `never_signed_in_post_launch`) **reuse existing reason codes** — see §2.5.

### 2.2 Per-rule specifications

For each rule below: **Trigger predicate** is the SQL-ish condition; **Output** is the side-effect; **Idempotency** is the skip condition on re-evaluation.

#### Rule 10 — `subscription_cancelled` → Churned

- **Trigger:** `customers.subscriptionStatus = 'Cancelled'` AND `customers.onboardingState != 'Churned'`. (Optional defensive: check that the most recent `stripe.subscription.cancelled` signal is within the last 7 days, to avoid moving customers whose status drifted via Stripe Data Sync corrections.)
- **Threshold rationale:** Stripe webhook owns the canonical signal; mirror immediately. 31 customers in current snapshot already in `canceled` status.
- **Output:**
  - `onboardingState = 'Churned'`
  - `attentionReason = NULL` (Churned needs no reason)
  - `attentionSetAt = NULL`
  - HS ticket → `Churned` (label)
  - `customer_state_transitions` row: `change_source='lp_bi'`, `source_detail='rule:subscription_cancelled'`, `payload={ruleName, stripeSubId}`
- **Precedence:** Highest. Always wins.
- **Idempotency:** Skip when already in Churned with matching status.

#### Rule 20 — `payment_failed` → Critical

- **Trigger:** A `customer_usage_signals` row exists where `signal_type='stripe.invoice.payment_failed'` AND `observed_at >= NOW() - INTERVAL '14 days'` AND no subsequent `stripe.invoice.payment_succeeded` for the same customer with `observed_at > the_failed_row`. AND `subscriptionStatus != 'Cancelled'`.
- **Threshold rationale:** Payment failure is a hard binary signal. 14-day window prevents stale failures (already-resolved) from re-firing.
- **Output:** state → Critical, `attentionReason='payment_failed'`, ticket stage `Critical`, transition logged.
- **Idempotency:** Skip if already (Critical, payment_failed) AND `attentionSetAt > NOW() - 14d` (re-fire after 14d to refresh the timestamp if still unresolved — gives CSMs a "this has been broken for X days" signal in `rejig_attention_set_at`).

#### Rule 30 — `payment_past_due` → At-Risk

- **Trigger:** `subscriptionStatus = 'Past Due'` (mapped from Stripe `past_due | unpaid | incomplete`). Last `stripe.subscription.updated` signal's `signalValueJsonb->>'stripeStatus' IN ('past_due','unpaid','incomplete')`. AND no Rule 20 firing.
- **Threshold rationale:** Past-due is softer than payment_failed (Stripe's retry cycle is still in progress). Differentiated severity is correct.
- **Output:** state → At-Risk, `attentionReason='payment_past_due'`, ticket → `At Risk`.
- **Idempotency:** Skip if already (At-Risk, payment_past_due).

#### Rule 40 — `trial_not_activated` → At-Risk

- **Trigger:** `workflowKey LIKE 'B2B-%'` AND `onboardingState = 'Active'` AND `stripeSubscriptionId IS NULL` AND `(NOW() - stageEnteredAt) > 24 hours` (gives belt-A webhook time to complete).
- **Threshold rationale:** "Belts and suspenders" tertiary belt for B2B trial activation per Pass 1 OQ 6. The 24h delay prevents a race with the webhook handler. Snapshot data: 290 manual customers (no Stripe sub) — most should be in `Pre-Onboarding` or `Onboarding Scheduled`, never `Active`. This rule catches the rare B2B case where ticket went Active without Stripe.
- **Output:** state → At-Risk, `attentionReason='payment_past_due'` (re-use; the actionable behavior is the same — CSM checks Stripe). `source_detail='rule:trial_not_activated'` differentiates in the transition log. Optional follow-up admin task creation deferred to v2.
- **Idempotency:** Skip if already in this (At-Risk, payment_past_due) with same source_detail in the last 24h transition log.

#### Rule 50 — `no_show_pattern` → At-Risk

- **Trigger:** HubSpot Contact `onboarding_no_show_count >= 2`. (Read via HS API on cron run, or — for performance — mirror to a column at write-time. **Deferred property add.** For v1, read on cron via batched HS API contact fetches.) AND `onboardingState IN ('Pre-Onboarding', 'Onboarding Scheduled')`.
- **Threshold rationale:** 2 no-shows is the locked threshold per HS Workflow B design. Pattern signal is more severe than single no-show (which is handled by Workflow B's email cadence, not BI).
- **Output:** state → At-Risk, `attentionReason='no_show_pattern'`, ticket → `At Risk`.
- **Idempotency:** Skip if already in (At-Risk, no_show_pattern).

#### Rule 60 — `stuck_in_onboarding` → At-Risk

- **Trigger:** `onboardingState IN ('Pre-Onboarding', 'Onboarding Scheduled')` AND most recent `customer_state_transitions` row for this customer has `changedAt < NOW() - INTERVAL '14 days'`. AND not in `Churned`.
- **Threshold rationale:** A customer should move out of Pre-Onboarding within a week (book + meet); 14 days gives buffer for legitimate reschedules. Tighter than Workflow B's 7-day no-show escalation so they don't conflict — Workflow B handles the active-meeting case, this catches the not-even-booked-yet case.
- **Output:** state → At-Risk, `attentionReason='stuck_in_onboarding'`, ticket → `At Risk`.
- **Idempotency:** Skip if already (At-Risk, stuck_in_onboarding) within last 7 days.

#### Rule 70 — `renewal_approaching_2w` → Watch

- **Trigger:** Most recent `customer_usage_signals` row of type `rejig.days_until_expiry` has `signal_value_numeric BETWEEN 0 AND 14`, observed within the last 7 days (snapshot not stale). AND `onboardingState='Active'`. AND `subscriptionStatus != 'Cancelled'`.
- **Alternative source:** `customers.renewalDate <= NOW() + INTERVAL '14 days'` if the column is populated reliably. Snapshot puts this number in the `customer_usage_signals` row.
- **Threshold rationale:** 73 active customers currently in the 2-week window. Concrete CSM action triggered.
- **Output:** state → Watch, `attentionReason='renewal_approaching_2w'`, ticket → `Watch`.
- **Idempotency:** Skip if already (Watch, renewal_approaching_2w).

#### Rule 80 — `engagement_drop_30d` → Watch

- **Trigger:** Most recent `rejig.last_login` signal's `observed_at < NOW() - INTERVAL '30 days'` (i.e. login was >30d ago at observation time AND no fresher signal). AND `onboardingState='Active'`. AND `subscriptionStatus IN ('Active', 'Trial')`. AND customer has logged in at least once (`rejig.last_login` signal exists).
- **Threshold rationale:** 30d is the natural shoulder in the login histogram. 100/608 (16%) of active customers are in this bucket — meaningful cohort.
- **Output:** state → Watch, `attentionReason='engagement_drop_30d'`, ticket → `Watch`.
- **Idempotency:** Skip if already (Watch, engagement_drop_30d). Re-fire every 14 days to refresh `attentionSetAt` so CSMs see "this has been a problem for X days."

#### Rule 90 — `never_signed_in_post_launch` → Watch

- **Trigger:** `onboardingState='Active'` AND `subscriptionStatus IN ('Active', 'Trial')` AND no `rejig.last_login` signal of any age for this customer (or `rejig.last_login` exists with `signal_value_jsonb->>'never'='true'` for snapshot-imported nulls). AND the transition to Active was >7 days ago.
- **Threshold rationale:** 24 active customers in snapshot never logged in. Different rule than `engagement_drop_30d` (which requires prior login activity). Catches the "paying but not using" case.
- **Output:** state → Watch, `attentionReason='engagement_drop_30d'` (reused — see §2.5). `source_detail='rule:never_signed_in_post_launch'` differentiates.
- **Idempotency:** Skip if already in matching state with same source_detail in last 14 days.

#### Rule 100 — `renewal_approaching_6w` → Watch

- **Trigger:** Most recent `rejig.days_until_expiry` signal between 15 and 42 inclusive, observed within last 7 days. Else `renewalDate` in range. AND `onboardingState='Active'`. AND `subscriptionStatus != 'Cancelled'`.
- **Threshold rationale:** 91 active customers in this window. Lower priority than 2w so the customer's reason advances correctly as time passes (6w → 2w on natural progression).
- **Output:** state → Watch, `attentionReason='renewal_approaching_6w'`, ticket → `Watch`.
- **Idempotency:** Skip if (Watch, renewal_approaching_6w) and the days_until_expiry signal value hasn't dropped below 15.
- **Re-fire condition:** When the customer naturally crosses the 14-day boundary, Rule 70 wins; this rule's idempotency check fails (because the customer is now in Rule 70's state), and the transition Watch→Watch with updated reason is logged.

#### Rule 110 — `bi_recovery` → Active

- **Trigger:** `onboardingState IN ('Watch', 'At-Risk', 'Critical')` AND **no other rule in this list fires for this customer this run**. AND no `customer_state_transitions` row with `change_source='hubspot_csm_ui'` to the current state in the last 7 days (don't override a CSM's deliberate placement). AND `subscriptionStatus != 'Cancelled'`.
- **Threshold rationale:** Closes the loop so customers heal back to Active when their issues resolve (payment succeeded after past_due, login returned after engagement_drop).
- **Output:** state → Active, `attentionReason=NULL`, `attentionSetAt=NULL`, ticket → `Active`.
- **Idempotency:** Already-in-Active customers skip the entire rule chain (they're the default).
- **Caveat:** This is the only rule that **does NOT use first-match-wins**; it's evaluated only if all other rules abstain. Implementation note: easier expressed as a separate evaluator that runs after the main chain returns "no rule matched."

### 2.3 Rule precedence enforcement

Concrete implementation: `registry.ts` exports rules as `BiRule[]`. The cron iterates rules in order; the first rule that returns `{fires: true, ...}` wins; remaining rules are skipped for that customer. The recovery rule (110) is evaluated only when all 1-100 return `{fires: false}`.

When the rule that "wins" is the same as the one that fired last time, the BI cron MUST NOT write a no-op transition row. Implement idempotency at the helper layer — `applyStateTransition` returns `{applied: false, reason: 'no-op'}` when the target state + attention reason match current.

### 2.4 Conflict with CSM manual moves

Per the locked v1 decision in §hubspot-integration.md ("BI is authoritative; no CSM override in v1"), CSMs are not supposed to drag tickets. BUT — if a CSM does it anyway, we log it as `hubspot_csm_ui`. Rule 110 explicitly does NOT heal back over a CSM placement made within the last 7 days. This is the cooling-off for human override. Hard rules 10–60 will still override (a Critical for payment_failed must beat a CSM's Watch placement).

### 2.5 Reason-code reuse vs new reasons

The locked enum (`docs/integrations/hubspot-integration-phase-0b-setup.md`) has 10 values. The 11 rules above use only **9 of them**:

- `payment_failed`, `payment_past_due`, `no_show_pattern`, `stuck_in_onboarding`, `engagement_drop_30d`, `renewal_approaching_2w`, `renewal_approaching_6w` — direct mappings.
- `no_show_no_rebook`, `customer_cancelled_onboarding`, `partial_no_completion` — owned by HubSpot Workflow B/C/D (NOT BI cron). BI cron MUST NOT write these.

**Two rules reuse codes via source_detail differentiation:**
- `trial_not_activated` uses `payment_past_due` (the user-facing implication is the same — billing not flowing).
- `never_signed_in_post_launch` uses `engagement_drop_30d` (CSM sees the same "go nudge them" signal).

The `customer_state_transitions.source_detail` column captures the precise rule name, so the audit trail is clean. **The 10-value enum is sufficient for v1; no schema change needed.** Recommendation deferred: monitor CSM feedback for 2 weeks post-launch; if differentiation in the UI is needed, propose adding `trial_not_activated` + `never_signed_in_14d` as separate reason values in a future pass.

---

## 3. HubSpot Contact metadata push proposal

The user asked: "feed important parts of this data into HS ticket (or contact rather) — so there's richer metadata available."

### 3.1 Lean-properties test — proposed Contact properties

Each property must defend against the lean-properties anti-patterns. Verdicts below:

| Proposed property | Type | Defends lean test? | Verdict |
|---|---|---|---|
| `rejig_last_login` | Date picker (with time) | **PASS** — directly displayed on kanban card; CSM glance value "logged in 47 days ago"; used in lists/filters. Single writer (BI cron). | **ADD** |
| `rejig_days_since_last_post` | Number | **PASS** — actionable metric for CSMs ("Mike hasn't posted in 92 days"). Single writer. | **ADD** |
| `rejig_total_posts` | Number | **MARGINAL** — useful for segmentation ("heavy user vs light user"), but the CSM action is the same (check engagement). Not strictly needed for daily kanban. **Defer** unless segmentation reports add a concrete use. | **DEFER** |
| `rejig_subscription_status` | Dropdown enum | **REJECT** — anti-pattern #2 + #5. Stripe webhook already drives `customers.subscriptionStatus`; mirroring it to HS = 2 writers + drift surface. CSMs can see Stripe status by clicking through to the Deal where it's already on `dealstage` (closed-won) + custom prop. | **DROP** |
| `rejig_plan_key` | Single-line text | **REJECT** — anti-pattern #5. Plan info is on the Deal level. D2C: `standard_premium`; B2B: bulk plan terms. Already inferable from existing `rejig_brokerage_channel`. | **DROP** |
| `rejig_days_until_expiry` | Number | **PASS** — but only if displayed/filtered. CSMs need to see "47 days until renewal" on the kanban card especially for Watch tickets in renewal_approaching state. Single writer (BI cron). | **ADD** |
| `rejig_listing_count` | Number | **DEFER** — listing engagement is real-estate-specific; not core daily metric. Add only if a listing-focused BI rule is built (§2.7 not in this pass). | **DEFER** |
| `rejig_engagement_state` | Dropdown enum (`heavily_engaged / regularly_engaged / lightly_engaged / dormant / never_engaged`) | **MARGINAL** — fits the user's "tagging" question (§4) better than as a standalone property; revisit there. | **CONSIDER IN §4** |

**Final ADD list — 3 properties on Contact:**

| Internal name | Label | Type | Writer | Update cadence |
|---|---|---|---|---|
| `rejig_last_login` | Rejig Last Login | Date picker (with time) | LP BI cron | On-change only (skip write if value unchanged) |
| `rejig_days_since_last_post` | Rejig Days Since Last Post | Number | LP BI cron | Every BI run (daily) — value drifts naturally |
| `rejig_days_until_expiry` | Rejig Days Until Expiry | Number | LP BI cron | Every BI run (daily) — value drifts naturally |

### 3.2 Update cadence and write semantics

- **On-change only** for `rejig_last_login` — login dates rarely change day-to-day for any single customer; needlessly writing the same value 600× per day spams the HubSpot audit log.
- **Every run** for the two derived `days_since_*` numbers — values drift +1 daily; writing every run keeps the card current.
- **Batched writes** via HubSpot's `crm/v3/objects/contacts/batch/update` endpoint (max 100 per batch). At ~700 active contacts this is ~7 batch calls per BI run — well inside HS rate limits.
- **Property writes occur after `applyStateTransition`** (see §5.2). State changes are atomic at the DB layer; metadata pushes are best-effort and logged but don't fail the cron.

### 3.3 Why NOT add `rejig_subscription_status` / `rejig_plan_key`

The user's instinct is reasonable, but these two violate anti-pattern #5 (HS as backup database). Subscription status is the most-changed billing-side property; if a Stripe state-change webhook drops or arrives out-of-order, HS shows stale subscription data while the LP DB shows fresh. Two writers, one truth — pick LP. Plan info should be inferred from the brokerage channel + tier-on-Deal, not duplicated.

### 3.4 What stays on Ticket (no additions)

- `rejig_attention_reason` and `rejig_attention_set_at` are already on Ticket (Phase 0b). BI cron writes these via `pushTicketStage` plus a follow-up `updateContactProperties`-equivalent that targets Ticket. Phase 4 needs a new helper `updateTicketProperties(ticketId, props)` parallel to the existing `updateContactProperties`. **Not a property add — a code add.**

---

## 4. HubSpot tagging strategy

### 4.1 What "tagging" primitives HubSpot offers

HubSpot has no native "tag" object. Tag-like behavior on tickets/contacts requires one of:

1. **Multi-checkbox property** — multiple values selectable from a defined enum. Visible on card; filterable in lists; usable in workflow conditions. Cardinality limited by your config.
2. **Saved list / dynamic list** — auto-membership based on property criteria. NOT visible on the card itself (list-membership is queried separately). Works for "all customers matching pattern X" but doesn't show on the ticket.
3. **Multiple single-checkbox boolean properties** — one property per tag value. Becomes property-soup at scale.

For "differentiation within a stage" (the user's actual ask), **option 1 — a multi-checkbox property on Ticket — is the only viable answer.** Saved lists aren't visible on kanban cards.

### 4.2 The lean-properties test applied

A `rejig_attention_tags` multi-checkbox property on Ticket would have these candidate values:

- `low_engagement` — customer in Watch for engagement_drop_30d
- `payment_concern` — customer in Watch/At-Risk for any payment reason
- `b2b` / `d2c` — segmentation tag
- `heavy_user` / `light_user` — adoption segmentation
- `recent_no_show` — had a no-show in last 30d but otherwise healthy

This is **almost entirely derivable from existing data**:
- `rejig_attention_reason` already says "low_engagement" if reason=`engagement_drop_30d`. Adding a `low_engagement` tag is anti-pattern #3 (denormalizing for clicks).
- `rejig_brokerage_channel` already says `d2c / b2b_*`. Adding `b2b/d2c` tag is anti-pattern #5 (backup database).
- `heavy_user/light_user` would be a NEW segmentation signal derivable from `rejig_total_posts`. Marginal value vs `rejig_total_posts` being a number property.

**Verdict on tagging:** **DO NOT add a multi-checkbox property in this pass.** The existing `rejig_attention_reason` + `rejig_brokerage_channel` properties + the (proposed) numeric metadata properties cover stage-internal differentiation. Adding tags would be denormalization (anti-pattern #3) for which there's no concrete CSM workflow that breaks today.

What we DO get for free that satisfies the user's intent: **CSMs can build saved list views in HubSpot UI** filtered by `rejig_attention_reason = engagement_drop_30d` AND `rejig_brokerage_channel = b2b_keyes` to see "Keyes customers with engagement issues." This is HubSpot's intended UX and requires no schema additions.

### 4.3 If user pushes back on §4.2

If CSMs surface a real need for stage-internal sub-classification that isn't covered by the reason + brokerage filters, the right fix is **a single multi-checkbox `rejig_attention_secondary_tags` property on Ticket** with a tight, locked enum (5–8 values max). Writer = BI cron (same writer as the primary reason). NOT proposed in this pass — defer to a post-launch iteration with concrete CSM feedback.

**Question 2 in §9.**

---

## 5. Phase 4 implementation plan (BI cron + rules)

### 5.1 File structure

| Path | Purpose |
|---|---|
| `src/lib/bi/cron.ts` | Top-level cron handler — fetch customers, iterate, call applyStateTransition |
| `src/lib/bi/registry.ts` | Exported `BI_RULES: BiRule[]` ordered array + types |
| `src/lib/bi/types.ts` | `BiRule` interface, `BiContext`, `BiRuleResult` types |
| `src/lib/bi/context.ts` | Build per-customer context: customer row, recent signals (last 90d), recent transitions, HS contact props (no-show count) |
| `src/lib/bi/rules/subscription-cancelled.ts` | Rule 10 |
| `src/lib/bi/rules/payment-failed.ts` | Rule 20 |
| `src/lib/bi/rules/payment-past-due.ts` | Rule 30 |
| `src/lib/bi/rules/trial-not-activated.ts` | Rule 40 |
| `src/lib/bi/rules/no-show-pattern.ts` | Rule 50 |
| `src/lib/bi/rules/stuck-in-onboarding.ts` | Rule 60 |
| `src/lib/bi/rules/renewal-approaching-2w.ts` | Rule 70 |
| `src/lib/bi/rules/engagement-drop-30d.ts` | Rule 80 |
| `src/lib/bi/rules/never-signed-in-post-launch.ts` | Rule 90 |
| `src/lib/bi/rules/renewal-approaching-6w.ts` | Rule 100 |
| `src/lib/bi/rules/bi-recovery.ts` | Rule 110 |
| `src/lib/bi/contact-metadata-push.ts` | Batch update of `rejig_last_login`, `rejig_days_since_last_post`, `rejig_days_until_expiry` |
| `src/app/api/cron/bi/route.ts` | Vercel cron endpoint (auth via `CRON_SECRET` header) |
| `vercel.json` | New file — `{ "crons": [{ "path": "/api/cron/bi", "schedule": "0 11 * * *" }] }` (11 UTC = 7am ET) |
| `src/lib/integrations/hubspot/client.ts` | Add `updateTicketProperties(ticketId, props)` helper |
| `src/lib/db.ts` | Add `applyStateTransition` helper |

### 5.2 `applyStateTransition` helper signature

```
async function applyStateTransition(args: {
  customerId: string;
  toState: string;                                  // 'Active' | 'Watch' | 'At-Risk' | 'Critical' | 'Churned'
  attentionReason: string | null;                   // from locked 10-value enum, or null on Active/Churned
  changeSource: ChangeSource;                       // 'lp_bi' for cron; 'lp_auto2' / 'lp_admin' for other writers
  sourceDetail: string;                             // e.g. 'rule:engagement_drop_30d'
  expectedFromState?: string | null;                // optional conditional WHERE — opposite-direction race guard (Pass 1 scrutiny #5)
  pushToHubSpot?: boolean;                          // default true; false for backfill scripts
  payload?: Record<string, unknown>;                // BI rule context for the transition row
}): Promise<{ applied: boolean; reason?: 'no-op' | 'expected-from-mismatch' | 'applied' }>
```

Behavior (atomic, in one `db.transaction`):
1. SELECT current `onboardingState`, `attentionReason`. If `expectedFromState` provided and doesn't match → return `{applied: false, reason: 'expected-from-mismatch'}`.
2. If `(currentState, currentReason) === (toState, attentionReason)` → return `{applied: false, reason: 'no-op'}` (idempotency).
3. UPDATE `customers SET onboardingState=$toState, attentionReason=$attentionReason, attentionSetAt=$now WHERE id=$customerId AND onboardingState=$currentState` (conditional WHERE — Pass 1 scrutiny point 5). If 0 rows updated → race condition, return `{applied: false, reason: 'expected-from-mismatch'}`.
4. INSERT into `customer_state_transitions` with `fromState=$currentState`, `toState=$toState`, `attentionReason`, `changeSource`, `sourceDetail`, `payload`, `changedAt=$now`.
5. If `pushToHubSpot && customer.hubspotTicketId`: after transaction commits, call `pushTicketStage(ticketId, stageLabel)` + `updateTicketProperties(ticketId, {rejig_attention_reason, rejig_attention_set_at})`. Failures logged, do not throw.
6. Return `{applied: true, reason: 'applied'}`.

### 5.3 Cron handler flow

`src/app/api/cron/bi/route.ts`:

1. Auth: check `Authorization: Bearer ${CRON_SECRET}` header (Vercel cron pattern).
2. Fetch all customers WHERE `onboardingState IS NOT NULL AND subscriptionStatus IS NOT NULL` (skip pre-launch + dropped data). Expect ~700 rows.
3. For each customer (in a per-customer try/catch — one bad row doesn't kill the run):
   - Build BiContext via `context.ts` — bulk-loads signals + transitions + HS contact props with one batched fetch per data source (not per-customer).
   - Walk rules 10→100. First one returning `{fires: true, toState, attentionReason, sourceDetail}` wins.
   - If none fired, run rule 110 (recovery). If it fires → applyStateTransition to Active.
   - If 110 also doesn't fire (customer already Active with no concerns) → no-op.
4. After ALL customers processed: run `contact-metadata-push.ts` to batch-update the 3 Contact metadata properties.
5. Log structured summary: `{customersEvaluated, ruleFireCounts: {ruleName: count}, errors: [{customerId, error}], durationMs}`.
6. Return 200 with summary JSON.

### 5.4 Performance budget

- 700 customers × ~5 SQL queries/customer (signals, transitions, HS contact) = 3,500 reads. With bulk-fetching at the start of the cron run (one query each for "latest signal per (customer, signal_type)" via DISTINCT ON), this collapses to ~10 SQL queries + 700 in-memory rule evaluations.
- HubSpot writes: ~50–100 per run (only customers whose state changed). Plus 7 batch metadata updates (100/batch).
- Target runtime: <2 minutes. Well inside Vercel cron's 5-minute timeout.

### 5.5 Vercel cron config

```
{
  "crons": [
    { "path": "/api/cron/bi", "schedule": "0 11 * * *" }
  ]
}
```

Daily at 11 UTC (7am ET) before CSMs start the day. **Question 3 in §9** on whether daily is the right cadence vs every 4 hours.

### 5.6 Loop-prevention boundary

The BI cron writes via `applyStateTransition`, which calls `pushTicketStage`. That triggers a HubSpot webhook back to LP with `changeSource=INTEGRATION, sourceId=LP_HUBSPOT_APP_ID`. The existing webhook handler (`/api/webhooks/hubspot/route.ts:69 isLPOwnWrite`) filters those out — **no duplicate transition row**, no echo loop. **This is already in place** from Phase 3.

⚠️ **Discrepancy flag:** The user-provided spec says `LP_HUBSPOT_APP_ID=39386ksb685`. The code at `src/app/api/webhooks/hubspot/route.ts:20` has `'39386685'`. One of these is wrong. **Question 4 in §9.**

---

## 6. Phase 5 implementation plan (Rejig snapshot import + taxonomy lock)

### 6.1 Signal taxonomy — final list

Locked vocabulary for `customer_usage_signals.signal_type`:

| signal_type | numeric value | jsonb shape | source | written by |
|---|---|---|---|---|
| `stripe.subscription.created` | — | `{subscriptionId, stripeStatus, mappedLPStatus, trialEnd, cancelAt, stripeCustomerId}` | stripe_webhook | already live |
| `stripe.subscription.updated` | — | same | stripe_webhook | already live |
| `stripe.subscription.cancelled` | — | same | stripe_webhook | already live |
| `stripe.subscription.trial_will_end` | — | same | stripe_webhook | already live |
| `stripe.invoice.payment_succeeded` | `invoice.amountPaid/100` | `{invoiceId, amountDue, amountPaid, currency, attemptCount, stripeCustomerId}` | stripe_webhook | already live |
| `stripe.invoice.payment_failed` | `invoice.amountDue/100` | same | stripe_webhook | already live |
| `stripe.setup_intent.succeeded` | — | `{setupIntentId, paymentMethodId, stripeCustomerId}` | stripe_webhook | already live |
| **`rejig.last_login`** | days_since_login (or null if never) | `{lastLoginISOString \| null, sourceRowId}` | rejig_csv_snapshot (Phase 5) / rejig_api (Phase 9) | new — Phase 5 import |
| **`rejig.days_since_last_post`** | int days | `{neverPosted: bool, sourceRowId}` | same | new |
| **`rejig.total_published_posts`** | int count | `{videoPosts, imagePosts, contentTypeBreakdown, sourceRowId}` | same | new |
| **`rejig.listing_count`** | int count | `{sourceRowId}` | same | new |
| **`rejig.days_until_expiry`** | int days | `{planExpiryDate, planKey, subscriptionStatus, isManual, sourceRowId}` | same | new |
| **`rejig.account_active`** | 1 or 0 | `{subscriptionStatus, isManual, sourceRowId}` | same | new — derived from `Subscription Status` |

12 signal types total — 7 existing Stripe + 5 new Rejig. **The 5 new types are locked here as canonical.** Phase 9 live API ingestion will write the same names.

**Rationale per signal:**
- `rejig.last_login` — observed_at = the login date (not the snapshot date). For "never logged in" rows: write the signal with `observed_at = customer.createdAt` (best available "this customer has existed since X with no login") and `signal_value_numeric = NULL`, `signal_value_jsonb = {never: true, snapshotDate: '2026-05-11'}`. BI rule 90 checks for `NULL` numeric + `never=true`.
- `rejig.days_since_last_post` — observed_at = snapshot date (2026-05-11). Numeric = the days count. Null-post rows: `numeric=NULL`, `jsonb={neverPosted: true}`.
- `rejig.total_published_posts` — observed_at = snapshot date. Cumulative count, not a rate. BI rules don't currently use this; captured for future trend analysis.
- `rejig.listing_count` — observed_at = snapshot date. Same as above.
- `rejig.days_until_expiry` — observed_at = snapshot date. Numeric = days. Captures the renewal cohort.
- `rejig.account_active` — observed_at = snapshot date. Numeric = 1 if `Subscription Status='active'` else 0. Useful for time-series active-base trend (Phase 9).

### 6.2 Importer script — `scripts/import-rejig-snapshot.ts`

**Signature:** `npx tsx scripts/import-rejig-snapshot.ts [--apply] [--limit N] [--csv path]`

**Flow:**
1. Parse CSV with proper quoted-field handling (Node's `csv-parse` or similar). Validate header.
2. Phase 1 — **Identity mapping pre-pass (no writes):**
   - Build a map of LP customers: `lowercase_trim(contactEmail) → customer.id`, and also `lowercase_trim(platformEmail) → customer.id`.
   - For each CSV row: try contactEmail match, then platformEmail match. Track `{matched, unmatched_email, ambiguous}` counts.
   - Print summary: "Of 682 CSV rows: 312 matched to LP customers, 370 unmatched (will land as orphan signals with `customer_id=NULL`, `rejig_user_id=<ID>`)."
3. Phase 2 — **Signal staging pre-pass (still no writes, --dry-run by default):**
   - For each CSV row, compute the 6 signal rows it produces. Aggregate by `signal_type`. Print: "Will insert: 682 rejig.last_login (of which 31 NULL), 682 rejig.days_since_last_post (91 NULL), ..."
4. Phase 3 — **Idempotency check:**
   - For each `(customer_id|rejig_user_id, signal_type, observed_at)` tuple, query existing `customer_usage_signals` to see if a row already exists. Print "X rows would be skipped (already-imported)." This makes the script idempotent — re-running with the same CSV is a no-op.
5. Phase 4 — **--apply gate.** Without `--apply`, print summary and exit. With `--apply`:
   - Open one transaction per 100 rows (chunked).
   - Insert with `source='rejig_csv_snapshot'`, `ingested_at=now()`.
   - On unique-violation: skip (idempotent re-runs).
6. Print final summary: `{rowsRead, customersMatched, signalsInserted, signalsSkipped, errors}`.

**Identity mapping safety (per Pass 1 scrutiny point 10):**
- Case-insensitive, trim. ONLY email-based; no fuzzy matching.
- Multiple LP customers with the same email (legacy dups) → log to a `customer_identity_conflicts.log` file. DO NOT silently pick one. Importer prints a warning but continues for the matched-unambiguously rows.
- Multiple CSV rows with the same email (rare per spot-check; should be 0 in clean data) → log + skip, do not double-import.

**Out of scope for Phase 5:** Backfilling `rejigAccountId` on LP customers from matched email rows. That's Phase 6 (identity mapping). Phase 5 only writes signals.

### 6.3 Importer test fixtures

A small fixture CSV at `scripts/data/rejig-accounts-snapshot-test.csv` (in-repo, hand-crafted, NOT gitignored) with 15–25 rows covering:
- 3 rows that match existing test customers (Poorab LP Two, Matt Keyes, Mansi D2C) — verify matched-path
- 5 rows with deliberately-unmatched emails (`testnobody+1@example.com`...) — verify orphan-path
- 2 rows with `Last Login=""` (never logged in) — verify NULL handling
- 2 rows with `Days Since Last Post=""` (never posted) — verify NULL handling
- 3 rows with `Subscription Status='canceled'`, 2 with `'trialing'`, 1 with `'active'` — verify subscription_status pass-through
- 2 rows with `Days Until Expiry` in renewal windows (one in 2w, one in 6w) — verify rule-trigger compatibility
- 1 row with unparseable `Plan Expiry Date` — verify error handling

This fixture is the basis for unit tests on both the importer and the BI rules.

---

## 7. Testing approach

### 7.1 Unit tests — per rule

Per `src/lib/bi/rules/*.ts`, a sibling `*.test.ts` in `tests/bi/rules/`. Each test:
- Synthesizes a `BiContext` (in-memory; not against the DB) covering: customer with `subscriptionStatus`, signals array, transitions array, HS contact props.
- Calls `rule.evaluate(context)`.
- Asserts `{fires, toState, attentionReason, sourceDetail}` matches expected.

Per rule, **at least 3 test cases:**
1. Positive — predicate matches → fires
2. Negative — predicate doesn't match → doesn't fire
3. Idempotency — already in target state → fires=false (or fires=true but applyStateTransition returns no-op)

### 7.2 Integration tests — CSV-driven

`tests/bi/integration/csv-fixture.test.ts`:
1. Load the test-fixture CSV.
2. Run the importer in --apply mode against a test DB (using Vitest's `setup` with a docker-compose Postgres).
3. Seed a few LP customers matching the fixture emails with specific `onboardingState` (Active, Watch, etc.).
4. Run the BI cron handler against the test DB.
5. Assert per-customer post-state:
   - `Poorab LP Two` (active, recent login, recent post) → stays Active
   - Fixture row "test_engagement_drop" (active, login 45d ago, post 50d ago) → Watch + reason `engagement_drop_30d`
   - Fixture row "test_renewal_2w" (active, expiry in 7 days) → Watch + reason `renewal_approaching_2w`
   - Fixture row "test_never_logged_in" (active, no login signal) → Watch + reason `engagement_drop_30d` + source_detail `rule:never_signed_in_post_launch`
   - Fixture row "test_canceled" (Stripe sub cancelled) → Churned
6. Verify the right `customer_state_transitions` rows are appended.

### 7.3 Manual verification cohort (post-snapshot-import)

After running the **real snapshot import** (live data) on a staging DB, pick 10 customers from `scripts/data/rejig-accounts-snapshot.csv` covering each rule's positive case. Verify after BI cron run:

| Customer (anonymized) | Expected post-BI state | Expected attentionReason |
|---|---|---|
| Active, 73 days no login, 75d no posts | Watch | engagement_drop_30d |
| Active, never logged in, 24-customer cohort | Watch | engagement_drop_30d (source_detail: never_signed_in) |
| Active, expiry in 7 days | Watch | renewal_approaching_2w |
| Active, expiry in 30 days | Watch | renewal_approaching_6w |
| Canceled status, sub_id has cancel_at | Churned | (null) |
| B2B-Keyes, ticket=Active, no Stripe sub | At-Risk | payment_past_due (source_detail: trial_not_activated) |
| Stripe past_due from recent webhook | At-Risk | payment_past_due |
| Stripe payment_failed in last 7d | Critical | payment_failed |
| Active, all signals healthy | Active | (null) |
| Previously At-Risk, now signals healed | Active (via Rule 110) | (null) |

Each assertion checks: `customers.onboardingState`, `customers.attentionReason`, latest `customer_state_transitions` row, and the HubSpot ticket's `hs_pipeline_stage` + `rejig_attention_reason` properties via API readback.

### 7.4 Smoke gate before flipping the daily cron live

Before enabling the Vercel cron schedule:
1. Run the cron handler manually via `curl -H "Authorization: Bearer $CRON_SECRET" $URL/api/cron/bi`.
2. Review the response JSON's `ruleFireCounts`. Expect roughly: ~100 engagement_drop_30d, ~73 renewal_2w, ~91 renewal_6w, ~24 never_signed_in, single-digit counts for the rest.
3. Spot-check 5 customers in HS — verify ticket stage + reason match expectations.
4. Verify webhook echoes are filtered (no extra `customer_state_transitions` rows from HS → LP echo).
5. If counts are wildly off (e.g. 600 engagement_drop_30d — suggests the threshold misfired), pause, fix, retry. Only flip cron schedule to live after smoke is clean.

---

## 8. Sequencing recommendation

| Sub-phase | Work | Dependency | Est. effort |
|---|---|---|---|
| **4a** | `applyStateTransition` helper + signal_type taxonomy doc lock + `updateTicketProperties` HS helper | None (pure schema-level + helper code) | 0.5 day |
| **5a** | Snapshot importer + test fixture + dry-run + --apply gates | 4a (helpers) | 1 day |
| **5a.1** | Run importer in --apply against staging | 5a | 0.25 day (validation) |
| **4b** | Rule files (10 rules + recovery) + registry + cron handler + Vercel cron config | 4a + 5a (need data to test) | 2 days |
| **4b.1** | Unit tests per rule + integration test against fixture | 4b | 1 day |
| **5b** | Add 3 HS Contact metadata properties in HubSpot UI + `contact-metadata-push.ts` integration | 4b live | 0.5 day |
| **5c** | (DEFERRED) HubSpot tagging implementation — NOT pursued in this pass per §4.2 | — | 0 |
| **4c** | Test pass + manual verification on 10 customers + smoke gate + enable cron | 5b complete | 1 day |
| **Buffer** | Rule threshold tweaks based on first-run results | 4c | 0.5 day |

**Total:** ~7 days of focused work. Sequenced so each sub-phase is independently verifiable; if 4b is delayed, 5a can still ship (importer is useful standalone).

The interleaving matters: **importing the snapshot before building the rules** means we test rules against real data immediately. Skipping 5a until after 4b would mean the unit tests + integration test are running against synthetic data only.

---

## 9. Open questions

1. **Brokerages outside our 4-channel enum** — Broker IDs `unique` (20), `kcn` (17), `agentship` (10), `arcrealty` (6) account for 53 customers. Should Phase 5 import treat these as "rejig_brokerage_channel=other_b2b" (new enum value) or leave them unmapped and surface in a gap report? **Needs user input.** Suggestion: leave unmapped in Phase 5; Phase 6 identity mapping handles backfill via `manual_review_brokerage_unknown` per Pass 1.

2. **HubSpot tagging — go vs no-go.** §4.2 recommends no-go for this pass. Confirm? Or push back with a concrete CSM workflow that requires sub-stage labels beyond the existing `rejig_attention_reason` + `rejig_brokerage_channel` filters. **Needs user input.**

3. **BI cron cadence — daily vs more frequent.** Daily at 7am ET handles renewal windows fine (expiry-date changes are slow). But payment_failed signals could lag up to 24h before BI moves to Critical. Recommend: daily for v1; observe; tighten to every 4h if payment-failure response time becomes a CSM complaint. **Confirm?**

4. **`LP_HUBSPOT_APP_ID` discrepancy** — user spec says `39386ksb685`; code has `39386685`. Which is correct? Phase 4's loop-prevention depends on this being right. **Needs user input — verify in HubSpot Developer Portal.**

5. **Trial-not-activated false positives for non-modeled B2B brokerages** — If `unique/kcn/agentship/arcrealty` customers get imported with `workflowKey LIKE 'B2B-%'` (Phase 6 work, not this pass), Rule 40 will fire on them. Is the right behavior to flag them or to require explicit `paymentMode='setup-intent-at-intake'` before evaluating? Recommend: gate Rule 40 on `customers.payment_mode = 'setup-intent-at-intake'` (whenever that column lands in Phase 6) rather than on workflowKey. For Phase 4 ship: gate on `workflowKey='B2B-Keyes'` only (the one trial-mode brokerage today). **Confirm Phase 4 gate?**

6. **Recovery rule (110) safe-default** — if all rules abstain BUT the customer's most recent `customer_state_transitions` has `change_source='hubspot_csm_ui'`, do we never recover until a CSM explicitly moves them back? Recommended: yes, until 7 days have passed (then BI takes over again). 7d is arbitrary; user input wanted. **Confirm 7d?**

7. **HubSpot Contact property additions (3 props)** — the §3.1 list of `rejig_last_login` + `rejig_days_since_last_post` + `rejig_days_until_expiry`. Are these the right three, or should `rejig_total_posts` also be in (currently DEFERRED)? Defer or add? **Confirm the 3-property set.**

8. **Snapshot import frequency vs Phase 9 readiness** — The CSV is dated 2026-05-11. By the time Phase 4 ships, it'll be ~2 weeks stale. Should we plan a second snapshot import the day before BI cron goes live? Or rely on the stale data and Phase 9 catches up? Recommend: re-export + re-import day-of-launch for fresh data. **Confirm.**

---

## 10. Cross-cutting risks

| # | Risk | Severity | Mitigation | Surfaces in |
|---:|---|---|---|---|
| 1 | **Clock skew between LP cron `NOW()` and signal `observed_at`.** A signal observed at T-30d may be evaluated as T-29d if the source system's clock drifts. | Low | All time arithmetic uses Postgres `NOW()` server-side, not Node's `Date.now()`. Stripe and Rejig timestamps already arrive as canonical (Stripe is UTC, Rejig snapshot date is fixed). | All time-based rules (70, 80, 90, 100). |
| 2 | **Signal staleness from old snapshot.** If the snapshot is 30 days old at BI run time, all `rejig.days_since_last_post` values are 30 days stale. Customers who logged in yesterday look like 30d-no-login. | **High** | All renewal/engagement rules gate on `observed_at >= NOW() - INTERVAL '7 days'`. If the snapshot is older than 7d, the rule doesn't fire (false-negative is safer than false-positive). Document the gating in each rule. Pass 1 risk #3 referenced. | Rules 70, 80, 90, 100. |
| 3 | **Double-firing across cron runs.** Race where a customer state changes between the context-build step and the apply step (e.g. CSM moves ticket mid-cron, Stripe webhook updates subscription mid-cron). | Medium | `applyStateTransition` uses conditional UPDATE with `expectedFromState`. If the state moved under us, the apply returns `expected-from-mismatch` and the customer is skipped this run. Re-evaluated next cron. | `applyStateTransition` core. |
| 4 | **HubSpot property explosion drift.** Adding 3 new Contact properties is fine; if every iteration adds 3 more, in 6 months we have 30 sync'd properties + drift surface. | Medium | Lean-properties principle holds. Pass 2+ MUST defend new property adds per the audit checklist. Doc updates capture the cumulative count. | §3 property additions. |
| 5 | **BI cron conflicts with CSM manual moves.** Per locked decision, CSMs shouldn't drag tickets in v1. If they do, Rule 110 might fight them. | Medium | Rule 110 has the 7-day CSM cooldown (§2.4). Cron handler logs `change_source='hubspot_csm_ui'` transitions for weekly admin review (per Phase 0b Step 2 lock-down mechanism). | Rule 110, admin review process. |
| 6 | **Identity-mapping import collisions corrupting BI eligibility.** A CSV row mis-matched to the wrong LP customer would feed wrong signals into BI rules. | High | Importer logs identity collisions to a file; does NOT silently merge. Phase 5 only fires for unambiguous matches. Phase 6 separately deals with ambiguous cases. | Phase 5 importer. |
| 7 | **Recovery rule loops.** If a Watch customer recovers, Rule 110 moves to Active, then HubSpot Workflow A (Meeting=Completed) doesn't re-fire so no state churn — but if a stale Meeting-outcome webhook arrives, it could push to Active, BI then sees no rule fires, customer stays Active. OK actually. The real loop is: a flaky signal feed causing oscillation between Watch and Active daily. | Low | Re-fire idempotency at `applyStateTransition` skips no-ops. Add an alert if any customer transitions back-and-forth >2 times in 7 days (admin dashboard query — Phase 8+). | Rule 110, admin tooling. |
| 8 | **`renewalDate` vs `rejig.days_until_expiry` source-of-truth split.** `customers.renewalDate` is touched by closed-won Stripe ingestion + the snapshot importer. Two writers → drift. | Medium | Phase 4 BI rules use ONLY the signal table (`rejig.days_until_expiry`), not `customers.renewalDate`. `renewalDate` stays for legacy compat per Pass 1 ("NOT touched by this plan"). Phase 9 reconciliation later. | Rules 70, 100. |

---

## Critical Files for Implementation

- `/Users/poorabshah/dev/rejig-ai/launchdeck/src/lib/db.ts` (add `applyStateTransition` helper)
- `/Users/poorabshah/dev/rejig-ai/launchdeck/src/lib/integrations/hubspot/client.ts` (add `updateTicketProperties` helper)
- `/Users/poorabshah/dev/rejig-ai/launchdeck/src/lib/bi/registry.ts` (new — exports `BI_RULES` array)
- `/Users/poorabshah/dev/rejig-ai/launchdeck/scripts/import-rejig-snapshot.ts` (new — Phase 5 importer)
- `/Users/poorabshah/dev/rejig-ai/launchdeck/src/app/api/cron/bi/route.ts` (new — Vercel cron entry; `vercel.json` companion at repo root)
