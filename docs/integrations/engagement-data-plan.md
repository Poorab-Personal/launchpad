# Plan — Engagement Data Integration + Churn-Risk Intelligence

**Status (post-cutover 2026-05-12):** Not yet built. The Postgres migration prereq this plan was waiting on is now COMPLETE — implementation can proceed when scheduled. No revisions needed; the plan was authored Postgres-native from the start.

---

**Status (original):** Draft v2, applies Plan-agent review 2026-05-11
**Author:** Claude (LaunchPad), based on convo with poorab@
**Date:** 2026-05-11
**Reviewers wanted:** push back on the join strategy, the rule set, the `at_risk_reason` write contract with payment-mode plan, the case-library model, and the LLM-vs-classical sequencing.

**Prereq (now satisfied):** assumes the Airtable → Postgres migration (`docs/plans/airtable-to-postgres-migration.md`) is landed. All schema sketches here are Postgres-native.

## Changes from v1 (post Plan-agent review)

- **ID-join cascade reordered.** Email first (always present), Stripe sub as disambiguator when email matches multiple Customers, manual override last. Now also ignores archived/churned LaunchPad customers when matching.
- **Write-contract collision with payment-mode plan resolved.** `at_risk_reason` is a closed enum in `src/types/index.ts` (`No CC | No Booking | No Approval | No Form | CSM Flagged`). v1 wrote free-form strings, breaking payment-mode's auto-clearing. v2 adds enum values (`Inactive | Trial Ending | Disengaged | No Listings | Engagement Falling | Churned`), splits ownership between plans, defines precedence, adds an `at_risk_source` column, and moves the day-count into a separate `at_risk_detail` text column.
- **Cron-race coordination.** Engagement cron and payment-mode dropoff cron both write `at_risk`. The engagement cron never writes `at_risk=false` for a customer whose active reason is owned by payment-mode.
- **`condition_sql` replaced by predicate enum.** SQL templating in a text column was an injection / typo risk. v2 uses a closed set of typed predicates with parameter columns. Adding a rule = picking a predicate + filling parameters in admin UI.
- **Rules 4/6 cold-start handled.** Rules requiring snapshot history short-circuit until `days_with_snapshots ≥ window`. New-customer cold-start (account < window age) similarly handled.
- **Outcome lifecycle expanded.** Separate `state` (`open | snoozed | resolved`) from `outcome` (`saved | lost | false-alarm | auto-recovered | null`). Auto-mark `auto-recovered` when the underlying rule stops firing for 7 consecutive days without CSM action. Otherwise "saved" gets diluted by passive recoveries and Phase 4 labels are noise.
- **FK cascades fixed.** `engagement_flags.customer_id` and `engagement_cases.customer_id` are `ON DELETE SET NULL`, not CASCADE — preserves outcome data through customer record changes.
- **`outcome_by` is FK to `team_members.id`**, not loose text email.
- **Snapshot soft-delete clarified.** `last_seen_in_api_at` is separate from `last_synced_at`. Archive when `last_seen_in_api_at < now() - 30d`. Re-appearance clears `archived`.
- **Case-library retrieval realism.** "SQL similarity" v1-claim downgraded to "hand-pick by archetype label." Vector embeddings only when library hits ~100 cases.
- **Phase estimates revised** (Phase 0 = 1.5d, Phase 1 = 7–8d, Phase 2 = 3d, Phase 3 = 6–7d) — v1 was optimistic.
- **Drift dashboard gets alerts.** Email `alerts@rejig.ai` when unjoined-Rejig-accounts > N or unjoined-post-onboarding-LaunchPad-customers > 0 for 48h. Tiles alone go unread.
- **Architect signoff 2026-05-11:** kept `customers.at_risk_reason` denormalized for v1 (cleaner refactor to flag-driven kanban is v2), but added two schema-level constraints on `engagement_flags`: `UNIQUE (customer_id, rule_id, raised_on_date)` for daily idempotency, and a CHECK constraint that the engagement cron can only insert rows whose `at_risk_reason` is in the engagement-owned half of the enum. These belt-and-suspender the precedence rule from §4.5.

---

## 1. Problem

LaunchPad knows about a customer through onboarding but goes blind once they're "live" in Rejig core. The integration notes flagged this as deferred:

> `docs/plans/payment-mode-dropoff.md:362` — *Engagement-data dump for CSM signals (e.g. "agent hasn't logged in") — deferred until the dump API exists.*

The dump API now exists. CSMs need a daily-updated view answering:

- Who has stalled (login, posts, listings)?
- Who's approaching trial expiry without engaging?
- Who's been quietly disengaging for weeks and is the next churn risk?

The data lives in Rejig's product DB, exposed via an admin account-list endpoint. LaunchPad needs to pull it, join it to LaunchPad Customers, derive risk signals, and surface them on the existing CSM kanban (the `At Risk` + `At Risk Reason` machinery from the payment-mode plan).

## 2. Data source

**Endpoint:**

```
GET https://api.rejig.ai/dashboard/admin/account-list
Headers:
  X-Service-API-Key: ${REJIG_SERVICE_API_KEY}
```

Returns ~700 rows today. Will grow with the business but stays small for the foreseeable future (low thousands).

**Columns** (from sample CSV `Accounts Snapshot - Raw Data (1).csv`, 682 rows):

| # | Column | Type | Purpose |
|---|---|---|---|
| 1 | `ID` | string (Mongo-ish) | **Rejig account PK — primary join key** |
| 2 | `Account Name` | string | Internal handle (random-looking, e.g. `OTp6eR`) |
| 3 | `Business Name` | string | Display business name |
| 4 | `Display Business Name` | string | Usually person/team name |
| 5 | `Email` | string | **Secondary join key** |
| 6 | `Phone` | string (optional) | — |
| 7 | `Broker ID` | string (optional, often empty) | Rejig's brokerage slug. Unreliable — empty even for KW agents. |
| 8 | `Plan Key` | enum | `standard_premium`, `standard_luxury`, blank |
| 9 | `Subscription Status` | enum | `active`, `trialing`, `canceled` |
| 10 | `Plan Expiry Date` | datetime | When current plan ends |
| 11 | `Days Until Expiry` | int | Pre-computed |
| 12 | `Last Login` | datetime | **Headline engagement signal** |
| 13 | `Listing Count` | int | — |
| 14 | `Total Published Posts` | int | **Lifetime, not rolling** |
| 15 | `Video Posts` | int | Lifetime |
| 16 | `Image Posts` | int | Lifetime |
| 17 | `Days Since Last Post` | int | **Headline engagement signal** |
| 18 | `Content Type Breakdown` | string (semicolon-delimited) | `Type: count; Type: count` |
| 19 | `Domain URL` | string | — |
| 20 | `Display Domain URL` | string | — |
| 21 | `Is Manual` | bool | `TRUE` = no Stripe sub (manual setup) |
| 22 | `Stripe Subscription ID` | string (`sub_...`) | **Tertiary join key** |

**Important:** lifetime totals only. To compute velocity ("posts in the last 14 days"), we have to diff snapshots over time. This is the single biggest reason snapshots matter — the API alone doesn't tell us trajectory.

**Things to clarify with Rejig before Phase 1:**

- Timezone of `Last Login` / `Plan Expiry Date` — assume UTC unless told otherwise.
- Whether `Total Published Posts` is truly lifetime or rolling.
- Whether deleted accounts disappear from the list (matters for soft-delete logic).
- Rate limits on the endpoint and whether bulk-fetch is the only mode.
- Whether the endpoint can support `?since=` filtering for incremental pulls (not required at our scale, nice to have).

## 3. The ID-join

The hardest part. Without a reliable join, the whole pipeline is wrong silently.

**Strategy:** three-key cascade, in order. Email-first because Stripe sub is *absent* for B&W (invoice mode) and any Keyes account before the onboarding call completes; running it first only helps the D2C cohort.

1. **`email` exact match (lowercase + trim)** against active LaunchPad Customers (`current_stage != 'Churned'` AND not soft-deleted). Excludes archived rows so a re-signed-up agent doesn't match their old record.
2. **If email matches multiple Customers** (real possibility with brokerage agents on shared inboxes, or a re-signup), use `stripe_subscription_id` as the disambiguator. If both are present and they conflict, log to `alerts@rejig.ai` and skip the auto-link — manual override required.
3. **`stripe_subscription_id` exact match** as a fallback when email match fails (a Rejig email change post-creation, for example).
4. **Manual override.** `customers.rejig_account_id` is settable by an Account Creator or Admin via `/workspace/admin/customer/[id]/link-rejig` when auto-match fails or conflicts.

**During each daily sync:**

- For Rejig accounts where `rejig_accounts.customer_id IS NULL`, attempt the cascade. Write `customer_id` on a clean hit.
- Update `last_seen_in_api_at = now()` for any account present in this run's payload.
- For Rejig accounts no longer present (deleted in Rejig core?), leave the row but **don't** advance `last_seen_in_api_at`. After 30 days (`last_seen_in_api_at < now() - 30d`), set `archived = true`. Re-appearance in a later run resets `archived = false` and advances `last_seen_in_api_at`. (Separate from `last_synced_at`, which advances on every cron run regardless of whether the account reappeared.)
- For LaunchPad Customers that have completed onboarding (`current_stage IN ('Review & Grow', 'Live')` or similar) but have no matching Rejig account, surface in the drift dashboard.

**Drift surfaces in `/workspace/admin`:**

- Tile: "N Rejig accounts unjoined to LaunchPad" (with email + Stripe sub for matching).
- Tile: "N LaunchPad Customers post-onboarding with no Rejig account" — these should have one.
- Tile: "N conflicting matches awaiting manual review" — email matched multiple Customers and Stripe sub couldn't disambiguate.

**Drift alerts (cron emits to `alerts@rejig.ai`):**

- Unjoined-Rejig-accounts count > 20 (configurable in `settings`).
- Any unjoined-post-onboarding-LaunchPad-customer persisting > 48h.
- Any conflicting-match persisting > 24h.

Tiles alone go unread. The alert thresholds are the teeth.

Silent join failures are how engagement intelligence becomes wrong without anyone noticing. The drift tiles + alerts are non-negotiable for v1.

**Capture-at-source improvement (post-v1):** if the temp-password / Sign-In task flow already calls a Rejig endpoint to provision the user, that endpoint likely returns the Rejig account ID. Capture it inline and write `customers.rejig_account_id` at provision time — eliminates the join problem for new customers entirely. Worth a separate ticket once v1 ingests.

## 4. Storage

Single Postgres DB (post-migration). Five new tables.

### 4.1 `rejig_accounts` — current state, one row per Rejig account

```ts
export const rejigAccounts = pgTable('rejig_accounts', {
  rejigAccountId: text('rejig_account_id').primaryKey(),
  customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
  email: text('email').notNull(),
  businessName: text('business_name'),
  displayBusinessName: text('display_business_name'),
  brokerId: text('broker_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  planKey: text('plan_key'),
  subscriptionStatus: text('subscription_status'),     // active | trialing | canceled
  planExpiryAt: timestamp('plan_expiry_at'),
  lastLoginAt: timestamp('last_login_at'),
  listingCount: integer('listing_count'),
  totalPublishedPosts: integer('total_published_posts'),
  videoPosts: integer('video_posts'),
  imagePosts: integer('image_posts'),
  daysSinceLastPost: integer('days_since_last_post'),
  isManual: boolean('is_manual').default(false),
  domainUrl: text('domain_url'),
  archived: boolean('archived').default(false),
  firstSeenAt: timestamp('first_seen_at').notNull().defaultNow(),
  lastSeenInApiAt: timestamp('last_seen_in_api_at').notNull().defaultNow(),  // advances only when account is in current API response
  lastSyncedAt: timestamp('last_synced_at').notNull().defaultNow(),          // advances on every cron run regardless
});
// indexes: (lower(email)), (stripe_subscription_id), (customer_id), (last_seen_in_api_at) WHERE archived = false
```

`last_seen_in_api_at` is separate from `last_synced_at` so the 30-day archive check is unambiguous. `lower(email)` index supports case-insensitive matching from §3.

### 4.2 `rejig_account_snapshots` — append-only history

```ts
export const rejigAccountSnapshots = pgTable('rejig_account_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  rejigAccountId: text('rejig_account_id').notNull().references(() => rejigAccounts.rejigAccountId, { onDelete: 'cascade' }),
  snapshotDate: date('snapshot_date').notNull(),
  subscriptionStatus: text('subscription_status'),
  lastLoginAt: timestamp('last_login_at'),
  listingCount: integer('listing_count'),
  totalPublishedPosts: integer('total_published_posts'),
  videoPosts: integer('video_posts'),
  imagePosts: integer('image_posts'),
  daysSinceLastPost: integer('days_since_last_post'),
  rawJson: jsonb('raw_json'),                          // entire row for forensics
  capturedAt: timestamp('captured_at').notNull().defaultNow(),
  // UNIQUE (rejig_account_id, snapshot_date)
});
```

Retention: 90 days daily, then downsample to weekly via a cleanup cron. At ~700 accounts × 90 days = ~63k rows — not a concern. Downsampling becomes relevant if account count grows 10×.

### 4.3 `engagement_flags` — risk-rule output, the CSM-facing record

```ts
export const engagementFlags = pgTable('engagement_flags', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
  rejigAccountId: text('rejig_account_id').references(() => rejigAccounts.rejigAccountId, { onDelete: 'set null' }),
  ruleId: text('rule_id').notNull(),                                  // 'inactive-14d', 'trial-ending-3d', etc.
  atRiskReason: atRiskReasonEnum('at_risk_reason').notNull(),         // closed enum — see §4.5
  detail: text('detail'),                                              // e.g. "17 days" — numeric/freeform context, NOT shown as the reason itself
  briefing: text('briefing'),                                          // LLM output, Phase 3+
  state: flagStateEnum('state').notNull().default('open'),             // open | snoozed | resolved
  snoozedUntil: timestamp('snoozed_until'),                            // for state='snoozed'
  outcome: flagOutcomeEnum('outcome'),                                 // saved | lost | false-alarm | auto-recovered (null until state='resolved')
  outcomeNote: text('outcome_note'),
  outcomeByTeamMemberId: uuid('outcome_by_team_member_id').references(() => teamMembers.id),
  raisedAt: timestamp('raised_at').notNull().defaultNow(),
  raisedOnDate: date('raised_on_date').notNull().defaultNow(),         // bucketed daily for the unique constraint below
  resolvedAt: timestamp('resolved_at'),
  ruleStoppedFiringAt: timestamp('rule_stopped_firing_at'),            // tracks consecutive-days-with-no-fire for auto-recovered detection
});
// indexes:
//   (customer_id, state) WHERE state IN ('open','snoozed') — active flags per customer
//   (state) WHERE state = 'open' — queue tile count
// constraints (per architect signoff 2026-05-11):
//   UNIQUE (customer_id, rule_id, raised_on_date)
//     — daily idempotency: a re-run of the cron on the same day for the same (customer, rule) cannot duplicate-insert
//   CHECK (
//     (at_risk_reason IN ('Inactive','Trial Ending','Disengaged','No Listings','Engagement Falling','Churned'))
//   )
//     — the engagement cron can ONLY insert flags whose reason is in the engagement-owned half of the enum.
//       Payment-mode reasons (No CC, No Booking, No Approval, No Form, CSM Flagged) live on customers.at_risk_reason
//       via the payment-mode plan's webhook handlers; they MUST NOT enter engagement_flags. Belt-and-suspenders
//       protection against a future code change subtly violating the precedence rule in §4.5.
```

Important: `ON DELETE SET NULL` (not CASCADE) on both FKs. Deleting a customer must not wipe outcome labels — those are training data for Phase 4 and historical audit. Same for cases (§4.4).

`auto-recovered` outcome: set automatically by the daily cron when a flag's `ruleId` has not fired for that customer for 7 consecutive days AND no CSM has resolved it. Otherwise "saved" gets diluted by passive recoveries and the eventual ML labels are noise (an architect call-out — fix it in v1, not after).

The two constraints above (`UNIQUE` + `CHECK`) were added per architect signoff 2026-05-11. The architect kept `customers.at_risk_reason` denormalized for v1 (rather than the stronger refactor of "drive kanban purely from `engagement_flags` rows") but insisted on these constraints as belt-and-suspenders: they make the precedence rule from §4.5 enforced at the schema layer, so it can't get silently violated by a future code change. If/when v2 moves payment-mode reasons into `engagement_flags` too, the CHECK relaxes to include the full enum.

### 4.4 `engagement_cases` — curated case library (Phase 3+)

```ts
export const engagementCases = pgTable('engagement_cases', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
  rejigAccountId: text('rejig_account_id'),
  archetype: text('archetype'),                                        // 'slow-fade' | 'cliff-drop' | 'trial-no-convert' | 'early-stall' | 'dormant-then-resurgent'
  trajectoryDescription: text('trajectory_description'),
  whatHappened: text('what_happened').notNull(),                       // 'churned' | 'saved' | 'still-active'
  intervention: text('intervention'),                                  // what the CSM did, if anything
  signalsJson: jsonb('signals_json'),                                  // snapshot timeline for prompt feed
  createdByTeamMemberId: uuid('created_by_team_member_id').references(() => teamMembers.id),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
```

### 4.5 Denormalized fields on `customers` — coordinated with payment-mode plan

The CSM-facing UI reads only from `customers`. **But:** payment-mode plan (already designed) writes `at_risk_reason` as a closed enum (`No CC | No Booking | No Approval | No Form | CSM Flagged`) with webhook-driven auto-clearing rules. Free-form writes break that. Resolution:

**`at_risk_reason` becomes an extended closed enum:**

```ts
export const atRiskReasonEnum = pgEnum('at_risk_reason', [
  // Owned by payment-mode plan (auto-cleared by Stripe / Calendly / approval / form webhooks)
  'No CC', 'No Booking', 'No Approval', 'No Form', 'CSM Flagged',
  // Owned by engagement plan (auto-cleared by `auto-recovered` mechanism or CSM resolve)
  'Inactive', 'Trial Ending', 'Disengaged', 'No Listings', 'Engagement Falling', 'Churned',
]);
```

**Other Customer columns:**

- `at_risk: boolean` (existing per payment-mode plan)
- `at_risk_reason: atRiskReasonEnum` (extended above)
- `at_risk_detail: text` — engagement plan puts the day-count / percentage here; payment-mode leaves null. Display under the reason badge, not as the reason itself.
- `at_risk_source: text` — `'engagement' | 'payment-mode' | 'csm'`. Tells each cron whose flag this is so it doesn't stomp the other.
- `last_engagement_briefing: text` — new, Phase 3
- `engagement_score: int` — new, Phase 3+ (simple weighted sum or LLM-assigned)

**Write-contract & precedence (resolves the cron race):**

1. **`Churned`** (engagement, from `subscription_status='canceled'`) > all other reasons. Engagement cron sets `Churned` even if a payment-mode reason was active.
2. Payment-mode reasons (`No CC | No Booking | No Approval | No Form | CSM Flagged`) > engagement velocity reasons. Engagement cron must NOT clear or overwrite these — only update if `at_risk_source IS NULL` or `at_risk_source = 'engagement'`.
3. Engagement reasons (`Inactive | Trial Ending | Disengaged | No Listings | Engagement Falling`) — first-match-wins in severity order.
4. Engagement cron never writes `at_risk=false` if `at_risk_source = 'payment-mode'`. Only payment-mode's webhook handlers clear payment-mode reasons. Symmetrically, only engagement's auto-recovered logic + CSM resolve clear engagement reasons.

**Per-customer multiple flags:** `engagement_flags` rows ARE the structured record — `customers.at_risk_reason` is a *display denormalization* showing the highest-precedence active flag. The kanban can show the count badge from `engagement_flags WHERE state='open'`. CSM detail page shows the full list. This avoids the "single-column hides parallel concerns" complaint from the review.

No customer-page code ever queries `rejig_accounts` or `rejig_account_snapshots` directly. That's the storage seam.

### 4.6 `engagement_rules` — predicate-driven, not SQL-templated

The v1 plan's `condition_sql` text column was an injection risk and a typo footgun. v2 uses a closed set of predicates with typed parameter columns.

```ts
export const enginePredicateEnum = pgEnum('engine_predicate', [
  'subscription_status_eq',         // status = $value
  'days_since_login_gte',            // last_login_at < now() - $value days
  'days_until_expiry_lte',            // plan_expiry_at < now() + $value days
  'posts_in_window_eq',               // posts in last $window_days = $value
  'velocity_ratio_lt',                // posts_last_window / posts_prior_window < $value
  'listing_count_eq_with_age',        // listing_count = $value AND customer_age_days >= $window_days
]);

export const engagementRules = pgTable('engagement_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  ruleId: text('rule_id').notNull().unique(),
  description: text('description'),
  severity: integer('severity').notNull(),                // 1 = highest priority
  predicate: enginePredicateEnum('predicate').notNull(),
  paramValue: text('param_value'),                        // typed by predicate convention
  paramWindowDays: integer('param_window_days'),
  paramPriorWindowDays: integer('param_prior_window_days'),
  atRiskReason: atRiskReasonEnum('at_risk_reason').notNull(),  // must be an engagement-owned value (CHECK constraint)
  detailTemplate: text('detail_template'),                // e.g. "{days_since_login} days"
  active: boolean('active').default(true).notNull(),
  generatesCsmTask: boolean('generates_csm_task').default(false),
  csmTaskTemplate: text('csm_task_template'),
  minSnapshotDaysRequired: integer('min_snapshot_days_required').default(0),  // cold-start gate
});
```

Adding rule #7 = pick a predicate from a dropdown in `/workspace/admin/engagement-rules`, fill numeric params, set the at_risk_reason, save. No SQL written by humans, no injection risk. A future DSL (or a learned model) can replace the predicate enum if needed; for now this is the right level of constraint.

If a new rule needs a predicate that isn't in the enum, that's a code change with a migration — by design. The whole point is that the predicate set is the contract.

## 5. Ingestion cron

```json
// vercel.json (combined with existing crons from integration-notes.md §6)
{
  "crons": [
    { "path": "/api/cron/sync-roster-all",       "schedule": "0 6 * * *" },
    { "path": "/api/cron/dropoff-reminders",     "schedule": "0 14 * * *" },
    { "path": "/api/cron/sync-rejig-engagement", "schedule": "0 10 * * *" }
  ]
}
```

`/api/cron/sync-rejig-engagement` flow:

1. `Authorization: Bearer ${CRON_SECRET}` first-line check.
2. `GET https://api.rejig.ai/dashboard/admin/account-list` with `X-Service-API-Key`.
3. Upsert into `rejig_accounts` (ON CONFLICT update; preserve `first_seen_at`; advance `last_seen_in_api_at` AND `last_synced_at` for any account in the response; clear `archived = true` if re-appeared).
4. For accounts NOT in this run's payload: `last_synced_at = now()` but leave `last_seen_in_api_at` untouched.
5. Insert into `rejig_account_snapshots` ON CONFLICT (rejig_account_id, snapshot_date) DO NOTHING — one per account per day.
6. Run join logic for unjoined accounts (per §3 cascade).
7. Run scoring (next section), respecting payment-mode precedence per §4.5.
8. Run auto-recovered detection: any `engagement_flags` row whose `ruleId` did NOT fire for the customer in this run advances `rule_stopped_firing_at`; after 7 consecutive non-firing days, set `state = 'resolved', outcome = 'auto-recovered'`.
9. Run snooze expiry: any `engagement_flags` row with `state = 'snoozed' AND snoozed_until < now()` goes back to `state = 'open'`.
10. Archive: `UPDATE rejig_accounts SET archived = true WHERE last_seen_in_api_at < now() - interval '30 days' AND NOT archived`.
11. Drift alerts: count unjoined accounts, unjoined post-onboarding customers, conflicting matches. Emit alert email per §3 thresholds.
12. Write `Engagement Synced` event with `{ accounts_fetched, accounts_upserted, flags_raised, flags_auto_recovered, llm_briefings_queued, drift_unjoined, run_duration_ms }`.

**Cadence: daily.** Every-other-day saves nothing and breaks day-precision rules.

**Failure mode:** if the Rejig API errors, log to `alerts@rejig.ai`, skip the snapshot for the day, retry next run. Don't crash. Don't mark accounts as stale on a failed run.

**Cost:** one HTTP request, ~700 rows of JSON. Negligible.

## 6. The intelligence layer

Two distinct tasks, often conflated:

1. **Prediction** — *who* is at risk? Best done by rules now, ML someday.
2. **Recommendation** — *what should the CSM say* to this agent? Best done by LLM from day one.

The architecture supports both, but they ship in different phases. Path A (rules) ships first. Path B (rules + LLM narrative) ships once outcome data exists. Path C (classical ML) is a year out.

### 6.1 Phase 1 rules (six rules)

Severity order. Higher-severity flag becomes the *displayed* `at_risk_reason` on the Customer, but **all matching flags become rows in `engagement_flags`** so the CSM detail page shows the full picture (no more "first-match-wins hides parallel concerns").

| # | Rule ID | Severity | Predicate | At Risk Reason | Min snapshot days | Cold-start gate |
|---|---|---|---|---|---|---|
| 1 | `churned` | 1 | `subscription_status_eq = 'canceled'` | `Churned` | 0 | none |
| 2 | `trial-ending` | 2 | `subscription_status_eq = 'trialing'` AND `days_until_expiry_lte = 3` | `Trial Ending` | 0 | none |
| 3 | `inactive-14d` | 3 | `days_since_login_gte = 14` | `Inactive` | 0 | `customers.created_at < now() - 14d` (otherwise the rule misfires on new accounts whose Rejig user was just provisioned) |
| 4 | `disengaged` | 4 | `days_since_login_gte = 7` AND `posts_in_window_eq` (window=14, value=0) | `Disengaged` | **14** | `rejig_accounts.first_seen_at < now() - 14d` (otherwise no snapshot baseline) |
| 5 | `no-listings` | 5 | `listing_count_eq_with_age` (value=0, window_days=7) | `No Listings` | 0 | none |
| 6 | `engagement-dropping` | 6 | `velocity_ratio_lt` (window=30, prior_window=30, value=0.3) | `Engagement Falling` | **60** | `rejig_accounts.first_seen_at < now() - 60d` AND both window post counts > 0 |

Output per firing: insert a row in `engagement_flags` (one row per fired rule per customer per day, idempotent on `(customer_id, rule_id, snapshot_date)` — needs a unique index on the table). Update `customers.at_risk = true`, `at_risk_reason` = the enum value for the highest-severity *currently-firing* rule, `at_risk_detail` = e.g. `"17 days"` for inactive-17d, `at_risk_source = 'engagement'`.

**Precedence vs. payment-mode reasons:** see §4.5. Engagement cron never overwrites a payment-mode reason unless rule 1 (`churned`) fires. Engagement cron never clears `at_risk` when `at_risk_source = 'payment-mode'`.

**Velocity computation** (posts_in_last_14d, posts_last_30d, posts_prior_30d) comes from `rejig_account_snapshots` diffs. SQL window functions handle it cleanly. **Cold start matters:** rules 4 and 6 cannot fire correctly until enough snapshot history exists. The `min_snapshot_days_required` column on `engagement_rules` and the cold-start gate columns above prevent false positives during the warmup window.

**Coexisting flags:** rules 1 and 3 can both fire for the same customer on the same day (Churned overrides display, but Inactive is still recorded). The kanban shows a badge count when > 1 active flag exists; the customer detail page lists all of them.

**Tuning** lives in `engagement_rules`. Adding rule #7 = picking a predicate from the dropdown + filling parameters in `/workspace/admin/engagement-rules`, not a deploy.

### 6.2 Phase 2 — outcome capture (the gate for everything smarter)

**The single most important piece.** Without it: rules don't tune, LLM prompt can't improve, classical model can never be trained. Ships with Phase 1 even though it serves no immediate purpose. Realistic scope is bigger than v1 implied — three sub-pieces, not just a modal:

**(a) Per-flag action panel** on `/workspace/customers/[id]`:
- For each `state IN ('open', 'snoozed')` flag, show: rule, raised-at, current detail (e.g. "17d"), action buttons.
- Actions: **Resolve** (Saved / Lost / False alarm), **Snooze** (3d / 7d / 14d picker).
- Optional note field per resolution.
- Writes `engagement_flags.outcome`, `state`, `resolvedAt`, `snoozedUntil`, `outcomeByTeamMemberId`.

**(b) Auto-recovered detection** (runs in daily cron, not user-facing):
- For each `state='open'` flag, check if its rule fired for the customer in today's run.
- If not, advance `rule_stopped_firing_at`. After 7 consecutive non-firing days: set `state='resolved', outcome='auto-recovered'`.
- Without this, the "saved" label gets diluted by passive recoveries and Phase 4 training data is noise.

**(c) Queue tile + nudges:**
- `/workspace/queue` tile: "Flags awaiting resolution: N" (state='open' AND raised_at < now() - 7d, since fresher flags don't need nudging yet).
- Weekly digest email to each CSM lead listing their oldest unresolved flags (configurable in `settings`).

**Outcome enum**, expanded: `saved | lost | false-alarm | auto-recovered`. (`snoozed` is a state, not an outcome.)

The Saved/Lost data is what feeds Phase 4 (classical ML) someday and Path B's prompt examples in the interim.

### 6.3 Phase 3 — LLM briefing (Path B)

For each newly-raised flag, the cron enqueues an LLM job. At ~10–50 flags per cron run, sync execution inside the cron is fine; no queue infrastructure needed.

**Prompt structure:**

- **System:** "You're advising a CSM at Rejig.ai. Read this agent's data and write 2 sentences: (1) what's happening, (2) recommended next move. Add a confidence rating (low/med/high). Be specific. The CSM is about to dial this person."
- **Snapshot history:** last 60 days of `rejig_account_snapshots` for this account, compact tabular format.
- **Onboarding context:** workflow, completion date, current stage, CSM owner (from `customers`), notable events (from `events` — completed tasks, missed calls, design approval status).
- **Recent touchpoints:** CSM notes from `calls`, emails sent, etc.
- **Top-3 similar past cases** from `engagement_cases` — for v1, **hand-picked by `archetype` label match**, not algorithmic similarity. With 10–30 cases and clear archetype labels, this gives clean results. SQL "similarity" without a concrete distance function is hand-waving and an architect will (correctly) push back.

**Output:** written to `engagement_flags.briefing` and `customers.last_engagement_briefing`.

**Cost sanity:** ~50 calls/day, ~3K tokens input (most cacheable via prompt caching when library prefix ≥ 1024 tokens) + ~200 tokens output. **~$3–8/month** on Sonnet 4.6; **~$1–2/month** on Haiku 4.5 if the narrative quality is sufficient. Not a constraint either way.

**Model:** **lead with Haiku 4.5** (`claude-haiku-4-5-20251001`) for the 2-sentence narrative; escalate to Sonnet 4.6 (`claude-sonnet-4-6`) only if eval quality is poor. Latency matters inside the cron more than cost — Haiku is meaningfully faster.

**Prompt caching:** mark the system prompt + case library prefix as cacheable. **Requires the cached prefix to be ≥ 1024 tokens** (Sonnet) or ≥ 2048 tokens (Haiku) — verify case-library section meets that threshold. Order each prompt so the cached prefix comes first; per-customer details come last. Cache hit rate should be ~95% within a single cron run **assuming** the library prefix is identical across customers in that run (it should be — same N cases).

**Vector embeddings** for case retrieval come in when the library hits ~100 cases or when archetype assignment becomes ambiguous. Not v1.

### 6.4 Phase 4 (eventual) — classical ML

Once `engagement_flags` has ~500–1000 resolved outcomes (probably 6–9 months in), revisit. Features = snapshot deltas + customer context; label = "churned within 60 days." Logistic regression or gradient boosting. Output: probability score.

Wire as a 7th rule that reads the model output, or replace rules 3–6 entirely with a single learned score. Probably the former — rules + model coexisting is more debuggable than model-only.

**Do not build this before the data justifies it.** Until 500+ labeled outcomes exist, rules + LLM beat any model trained on the small dataset, full stop.

## 7. The case library — what "gets smarter over time" actually means

`engagement_cases` is the brain. Goal: 10–30 representative trajectories of past customers, hand-annotated:

- **Archetype** (`slow-fade`, `cliff-drop`, `trial-no-convert`, `early-stall`, `dormant-then-resurgent`, etc.).
- **Trajectory** — week-by-week snapshot timeline (JSON).
- **What the CSM did**, if anything.
- **Outcome** — churned at week N, saved by intervention X, still active.

**Where the historical data comes from:** poorab's existing email-then-churn dataset. People who fell off, got nudged, eventually canceled — that universe is already implicitly labeled. Mining it into structured rows is the highest-leverage prep work.

**Where it lives:** `engagement_cases` table; edited at `/workspace/admin/case-library` (part of the Postgres-migration admin CRUD work).

**How it powers Path B:** the LLM prompt retrieves up to 3 cases matching the firing rule's archetype (hand-labeled) and includes them as few-shot examples. Hand-pick by archetype, not algorithmic similarity, until the library is large enough to warrant vector embeddings (~100 cases).

**Curation owner & effort:** curating 5 representative cases from existing email-then-churn data is realistically 1–2 days of **poorab's time** (not engineering's): pulling Rejig snapshots for the historical agents, writing the trajectory + intervention notes, picking archetype labels. This is the non-engineering blocker on Phase 3 — call it out in sprint planning so it doesn't quietly hold up the cron going live.

**Phase 3 prereq:** ≥ 5 cases curated before turning LLM briefings on. Without it the prompt is too thin and outputs are generic.

## 8. Phases

| Phase | Work | Estimate | Prereq |
|---|---|---|---|
| 0 | Drizzle schema (5 tables, predicate enum, at_risk_reason enum extension, indexes) + `REJIG_SERVICE_API_KEY` env + cron entry + admin UI scaffolding | 1.5 days | Postgres migration landed |
| 1 | Ingestion cron, 6 rules with predicate engine, cold-start gating, `at_risk` writes coordinated with payment-mode precedence, snapshot velocity SQL, drift dashboard tiles + alert emails, archive logic | 7–8 days | 0 |
| 2 | Outcome capture: per-flag action panel + snooze/resolve modal, auto-recovered detection in cron, queue tile, weekly digest email | 3 days | 1 has fired flags |
| 3 | Case library schema + admin CRUD + LLM briefing job (Haiku 4.5 lead, Sonnet 4.6 escalation, prompt caching wired) + ≥5 hand-curated cases (poorab) | 6–7 days | 2 + curated cases ready |
| 4 | (Eventual) classical ML model | TBD | ~500 resolved outcomes (~6–9 months) |

**Total v1 (Phases 0–2): ~2.5 weeks.** Ships rules + outcome capture + auto-recovered + alerts — enough to be useful and to start accumulating clean labels. Phase 3 is the high-impact follow-up gated on poorab's case curation.

## 9. What to clarify with Rejig before Phase 1

Worth a 15-minute sync with whoever owns the Rejig core API:

1. Timezone of timestamps in the API response.
2. Is `Total Published Posts` lifetime or rolling? If rolling, what window?
3. When a Rejig account is deleted, does it disappear from the list immediately or get a `deleted_at` field?
4. Rate limits and authentication failure modes.
5. Any plans to add fields to the response in the near term that would let us drop snapshots in favor of API-provided velocity (e.g., a `posts_last_30d` column)?
6. Can the API support an `?ids=` filter for ad-hoc lookups (useful for the manual-override flow)?

## 10. Decisions for Poorab

1. **Rule thresholds.** 14d inactive, 7d disengaged + 14d zero-posts window, 70% drop / 60-day window for engagement-dropping. Adjust before Phase 1 or accept defaults and tune via `engagement_rules` post-launch.
2. **`at_risk_reason` enum extension.** The proposal in §4.5 adds 6 values (`Inactive | Trial Ending | Disengaged | No Listings | Engagement Falling | Churned`) to the existing payment-mode set. Confirm wording and that this doesn't conflict with any CSM-facing label conventions already in use.
3. **Snooze durations.** 3d / 7d / 14d in the picker — enough? Or want a freeform date input?
4. **Outcome enum values.** `saved | lost | false-alarm | auto-recovered`. Confirm; flag if "won back after trial expiry" or similar nuance is needed (probably not for v1).
5. **Case library curation owner.** You. ~1–2 days of your time. Phase 3 cannot proceed without 5 cases — confirm you can carve out the time in the sprint Phase 2 ships in.
6. **LLM model choice.** Recommendation revised: lead with Haiku 4.5, escalate to Sonnet 4.6 if quality is poor. Confirm.
7. **Flag → CSM task generation.** When a flag fires (especially `trial-ending`), auto-create a Task on the Customer ("Confirm conversion") or just surface in the kanban? Trade-off: tasks survive past the flag's lifecycle and show in the CSM's daily queue but add task-table noise. Suggest: only `trial-ending` generates a task; others stay flag-only.
8. **Capture-at-source for `rejig_account_id`.** Separate ticket to capture the Rejig user ID at the Sign-In task / temp-password flow, eliminating the join problem for new customers? (Not blocking v1; v1 uses the §3 cascade.)
9. **Drift alert thresholds.** Default proposed: alert when unjoined-Rejig-accounts > 20, OR unjoined-post-onboarding-customer > 0 for 48h, OR conflicting-match > 0 for 24h. Tune?

## 11. What this plan does NOT cover

- The Postgres migration itself — `docs/plans/airtable-to-postgres-migration.md`.
- DMG roster integration — `docs/integrations/dmg-roster-plan.md`. Independent: different data source, different join key. Coexists fine.
- Outbound nudges (emailing the agent directly) — separate plan. This layer surfaces signals to CSMs; the CSM decides what to do.
- The `last_engagement_briefing` UI surface on the customer detail page — design lands as part of Phase 3, not specified here.
- Cross-customer aggregates ("which brokerage has the highest churn risk?") — out of scope for v1.
- Real-time engagement streaming (webhooks from Rejig core when an agent logs in / posts) — explicitly out of scope. Daily batch is sufficient for CSM-paced workflows.
