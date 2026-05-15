# Rejig × HubSpot × Stripe × LaunchPad — One-Shot 4-Way Backfill Plan

Status: DESIGN — pending architect/founder sign-off, then build.
Last revised: 2026-05-15 (architect pass).
Authoritative ID anchor: `rejig_user_id` (Rejig Mongo `_id`).
Authority on contradictions: this doc supersedes prior backfill notes in `docs/integrations/hubspot-integration.md` Phase 5.

---

## 1. TL;DR

We have 694 Rejig accounts (618 active, 44 trialing, 31 canceled, 1 deactivated). 631 already exist as HubSpot Contacts. Zero exist as LaunchPad customers. This plan describes a single, idempotent, founder-supervised pass that creates the missing rows across four systems and stitches them together so the weekly BI cron at `/api/cron/bi` can immediately operate on the full 694-row population.

Output: per Rejig account, exactly one LP `customers` row, one HS Contact (Company-associated for B2B), one HS CJ Ticket (Company-associated for B2B), Stripe metadata merged with cross-system breadcrumbs, and existing orphan `customer_usage_signals` re-bound to the new LP customer via `rejig_user_id`.

Execution is **four staged gates**, not one button: diagnostic CSV → schema migration → dry-run CSV → apply. Each gate has explicit success criteria; the founder approves between gates.

Net new code: one schema migration, one diagnostic script, one backfill script, one verification script. No new tables. No new BI behavior. No new auth paths. Roster, IPRE, Voice, Avatar are explicitly out of scope.

Risk profile: the only structurally irreversible action is writing keys into Stripe metadata. Everything else is recoverable. Stripe writes use MERGE not REPLACE; we never strip data Rejig set.

---

## 2. Scope and non-goals

### In scope

- All 694 Rejig accounts (active + trialing + canceled + deactivated).
- One LP `customers` row per Rejig account, with `createdVia='backfill'`.
- HS Contact upsert (find-by-email, otherwise create) for each account.
- Per-Rejig-account HS CJ Ticket: create if missing; move stage if existing but in a wrong-for-current-state stage.
- B2B Contact + Ticket must be associated to the brokerage HS Company (Keyes `53893652348`, B&W `51123896468`).
- Workflow key detection per row (`D2C-Standard` / `B2B-Keyes` / `B2B-BW`), with documented evidence trail and a `needs_review` lane.
- Stripe customer + subscription metadata MERGE with `launchpad_customer_id`, `rejig_user_id`, `hubspot_contact_id` keys; pre-existing keys preserved.
- `customer_subscriptions` rows created for Core only when a `stripe_subscription_id` is known and Stripe confirms the subscription exists and is in `active|trialing|past_due|canceled` (decision: see §11.C).
- Rebinding existing orphan rows in `customer_usage_signals` (where `customer_id IS NULL` and `rejig_user_id` matches) to the newly-created LP `customer_id`.
- Single synthetic `customer_state_transitions` row per backfilled customer with `change_source='lp_admin'`, `source_detail='backfill_2026_05_14'` (decision: see §11.A).
- One-time CSV audit deliverable: every Rejig account, mapped, with full evidence trail.

### Out of scope (will not be built or touched in this pass)

- Roster table population for backfilled B2B agents. Future brokerage-side feed will retroactively bind roster rows to existing `customers.id`.
- IPRE channel detection / IPRE backfill. Not signed today; deferred.
- Voice / Avatar `customer_subscriptions` rows. Rejig API exposes only the Core sub.
- BI cron logic changes. Cron is already weekly-Monday-1100-UTC; once 694 customers have `onboardingState IS NOT NULL` and `subscriptionStatus IS NOT NULL`, the existing filter at `src/app/api/cron/bi/route.ts` will pick them up automatically.
- HS Workflows (A-E) activation. These remain deferred per the Phase 0b setup decision; backfill is a one-shot, not an ongoing-flow.
- LP task generation. `createdVia='backfill'` is already wired in `generate-tasks.ts` / `trigger-email.ts` to suppress the welcome email and the workflow-template task ladder.
- D2C HS Deal creation. None of the 694 are coming through closedwon; backfilled D2C customers have no associated Deal.
- Channel-aware MRR / `customer_subscriptions.mrr`. Not in the API response; leave NULL.
- Migration / consolidation of the 17-stage CJ pipeline (see §14).

### Explicit non-decisions deferred to runtime defaults

- HS ticket subject format: reuse the existing convention `"{customer.name} - LP"` from `intake-handler.ts`.
- Ticket owner (`hubspot_owner_id`): not set during backfill. CSMs claim manually in HS, or a follow-up admin script can round-robin.

---

## 3. Identity model — four systems, three join keys

```
+----------------+        email         +--------------+
|     Rejig      | -------------------> |   HubSpot    |
|  (Mongo _id)   | ===================> |   Contact    |
+----------------+   rejig_user_id      +--------------+
      | _id              property             | hubspot_contact_id
      |                                       |
      |                                       v
      |                                +--------------+
      |                                |   HubSpot    |
      |                                |  CJ Ticket   |
      |                                +--------------+
      |                                       | hubspot_ticket_id
      |                                       |
      v                                       v
+----------------+   launchpad_customer_id   +--------------+
|     Stripe     | <-----------------------> | LaunchPad    |
| (customer +    |   stripe_customer_id      | customers    |
|  subscription) |   stripe_subscription_id  |              |
+----------------+   hubspot_contact_id      +--------------+
                     rejig_user_id
```

LP is the orchestrator. The four IDs that travel:

| Key | Source | Lives in | Generated by |
|---|---|---|---|
| `rejig_user_id` | Rejig Mongo `_id` | Rejig (native) → LP column → HS Contact prop → Stripe metadata | Rejig |
| `launchpad_customer_id` | LP UUID | LP PK → HS Contact prop → Stripe metadata | LP (this script generates in memory before any external write) |
| `stripe_customer_id` | Stripe `cus_XXX` | Stripe (native) → LP column → HS Contact prop → (LP `customer_subscriptions`) | Stripe (resolved from sub on read) |
| `hubspot_contact_id` | HS numeric | HS (native) → LP column → Stripe metadata | HS |

Email is the **join key** for matching Rejig ↔ HS ↔ LP. Not a stored identity anchor. After backfill, no flow should re-match by email — all lookups should go through stored IDs.

Direction of write per row, in execution order:

1. **Generate LP UUID** in script memory (no DB writes yet).
2. **Lookup HS Contact by email** (read-only).
3. **Lookup Stripe sub → customer** (read-only, only if `stripe_subscription_id` present on Rejig row).
4. **Decide cohort + workflow key** (pure computation, no writes).
5. **Upsert HS Contact** (HS write, idempotent by email).
6. **Ensure HS Contact ↔ Company association** (B2B only; HS write, idempotent).
7. **Upsert HS Ticket** (create OR move-stage; HS write, idempotent on `rejig_user_id` Contact property).
8. **INSERT LP `customers` row** (one transaction, foreign IDs all known).
9. **Merge Stripe metadata** on customer + subscription objects (Stripe writes, additive only).
10. **Bind orphan `customer_usage_signals`** (LP write: `UPDATE ... SET customer_id WHERE rejig_user_id=...`).
11. **Insert synthetic `customer_state_transitions` row** (LP write, one row per customer).
12. **Insert `customer_subscriptions` row** (Core only, only if Stripe lookup succeeded).

Every step keys on `rejig_user_id` for idempotency. Re-running the script is safe by design (§11.H).

---

## 4. Diagnostic script — `scripts/diagnose-4way-mapping.ts`

Purpose: produce the authoritative pre-backfill audit. Builds on the existing `scripts/diagnose-rejig-hs-lp-gap.ts` but extends it from 3-way (Rejig × HS × LP) to 4-way (Rejig × HS Contact × HS Ticket × Stripe × LP), emits a CSV, and adds channel detection + review flagging.

**Inputs (read-only):**
- Rejig API snapshot via `fetchAccountsSnapshot()`.
- HS Contacts: batched `IN` search by email (existing pattern, 100 per call).
- HS Tickets per matched Contact: bulk via `crm.objects.searchApi.doSearch` on `tickets` filtered by `associations.contact` IN [contact_ids] — chunk to 100 per query. Property fetch: `subject`, `hs_pipeline`, `hs_pipeline_stage`, `createdate`. Only the CJ pipeline (`hs_pipeline=0`).
- HS Contact ↔ Company associations: `crm.associations.v4.batchApi.getPage('contacts', batchOfContactIds, 'companies')`. Resolves whether each contact is on Keyes/B&W/other/none.
- Stripe: per Rejig row with non-null `stripe_subscription_id`, `stripe.subscriptions.retrieve(...)`. Auth: `STRIPE_LIVE_SECRET_KEY` (set by user separately).
- LP DB: `SELECT id, contact_email, platform_email, rejig_account_id, hubspot_contact_id, hubspot_ticket_id FROM customers`. (Note: column is currently `rejig_account_id`; see §9.)

**Output:**
- `scripts/data/backfill-audit-2026-05-15.csv` (CSV; one row per Rejig account, ~694 rows).
- Console summary: cohort counts, needs_review counts by reason, error counts.
- Exit code: 0 if zero errors; 1 if API failures encountered.

**Rate limiting:** HS search at 4 req/sec sustained, Stripe at 25 req/sec. Use sequential per-batch awaits; no parallel fan-out.

**Behavior on partial failures:** any unrecoverable read (HS auth, Stripe auth) aborts the run and surfaces the error. Per-row read failures (one Stripe sub not found, one HS Contact lookup transient 500) write the row with the failure flagged in `needs_review_reasons` and continue.

This script is the **deliverable for Gate 1** (see §11.J). Founder reviews the CSV before any writes happen.

---

## 5. Audit CSV — full column list

The CSV is human-readable, sortable, and is the authoritative spec for what the backfill script will do. One row per Rejig account.

| # | Column | Type | Source | Example | Notes |
|---|---|---|---|---|---|
| 1 | `rejig_user_id` | text (Mongo ObjectId) | Rejig `_id` | `6602fd...8a1c` | The anchor. Always populated. |
| 2 | `rejig_email` | text | Rejig `email` | `agent@keyes.com` | Lowercased, trimmed for matching. Original case preserved here. |
| 3 | `rejig_account_name` | text | Rejig `account_name` | `Jane Doe` | Used for `customers.name`. |
| 4 | `rejig_business_name` | text | Rejig `business_name` / `display_business_name` | `Jane Doe Group` | Used for `customers.business_name`. |
| 5 | `rejig_domain_url` | text | Rejig `domain_url` | `https://janedoe.keyes.com` | One channel-detection signal. |
| 6 | `rejig_plan_key` | text | Rejig `plan_key` | `keyes_trial` / `standard_monthly` | One channel-detection signal. |
| 7 | `rejig_subscription_status` | text | Rejig | `active` / `trialing` / `canceled` / `deactivated` | Drives cohort + ticket stage. |
| 8 | `rejig_stripe_sub_id` | text | Rejig `stripe_subscription_id` | `sub_1Q...abc` or empty | NULL allowed; some accounts have no Stripe sub. |
| 9 | `rejig_last_login` | iso8601 | Rejig `last_login` | `2026-05-12T18:42:00Z` | Mirrored to HS Contact `rejig_last_login` post-backfill (BI cron handles this; backfill script does not). |
| 10 | `rejig_plan_expiry_date` | iso8601 | Rejig | `2026-08-01T...` | Reference. |
| 11 | `rejig_post_count_total` | int | Rejig `post_metrics.total_published` | `42` | Reference. |
| 12 | `email_match_mode` | enum | computed | `exact` / `case_normalized` / `none` | See §6.B. |
| 13 | `hs_contact_id` | text or empty | HS lookup | `12345678` | Empty if no HS match. |
| 14 | `hs_contact_company_ids` | text (comma-sep) | HS associations | `53893652348` | Empty array if not associated. |
| 15 | `hs_contact_company_match` | enum | computed | `keyes` / `bw` / `other` / `none` | Maps company IDs to the two known brokerage IDs. |
| 16 | `hs_ticket_id` | text or empty | HS ticket search | `99887766` | Empty if no CJ ticket. |
| 17 | `hs_ticket_current_stage_label` | text | HS | `Onboarding Scheduled` | Empty if no ticket. |
| 18 | `hs_ticket_current_stage_id` | text | HS | `1154519671` | Same. |
| 19 | `stripe_lookup_status` | enum | computed | `ok` / `not_found` / `auth_error` / `skip_no_sub_id` | See §11.K rollback note. |
| 20 | `stripe_customer_id` | text or empty | Stripe (sub.customer) | `cus_QabcD...` | NULL on lookup failure. |
| 21 | `stripe_sub_status` | text or empty | Stripe (sub.status) | `active` / `trialing` / `past_due` / `canceled` / `incomplete` | Authoritative; Rejig's mirror can lag. |
| 22 | `stripe_metadata_existing_keys` | text (comma-sep) | Stripe sub.metadata + cus.metadata keys | `internal_ref,rejig_team_id` | For MERGE audit. |
| 23 | `lp_customer_id` | text (UUID) | generated | `9f8e7d6c-...` | Generated by diagnostic script, written if/when backfill is applied. |
| 24 | `lp_customer_id_existing` | text (UUID) | LP DB lookup | empty | If a row already exists for this email or rejig_user_id; should be empty for all 694 today. |
| 25 | `proposed_workflow_key` | enum | computed | `D2C-Standard` / `B2B-Keyes` / `B2B-BW` | See §7. |
| 26 | `proposed_channel_code` | enum | computed | `Standard` / `Keyes` / `BW` | Matches LP `channels.code`. |
| 27 | `proposed_customer_type` | enum | computed | `D2C` / `B2B` | Derived from channel. |
| 28 | `proposed_brokerage_id` | text (UUID) | computed | `<brokerages.id>` | NULL for D2C; UUID for B2B. |
| 29 | `proposed_hubspot_company_id` | text | computed | `53893652348` | The same ID we'll associate on. NULL for D2C. |
| 30 | `proposed_onboarding_state` | enum | computed | `Active` / `Churned` | See §8. |
| 31 | `proposed_ticket_target_stage` | enum | computed | `Active` / `Churned` | See §8. |
| 32 | `proposed_ticket_action` | enum | computed | `create_new` / `move_stage` / `noop` | See §8. |
| 33 | `proposed_subscription_status` | enum | computed | `Active` / `Trial` / `Past Due` / `Cancelled` | Mirrors `subscriptionStatusEnum`. |
| 34 | `channel_detection_evidence` | text | computed | `company_match:keyes` | One of: `company_match:<x>`, `email_domain:<x>`, `plan_key:<x>`, `website:<x>`, `none`. Records which rule fired. |
| 35 | `channel_detection_score` | int | computed | `3` | 0-4, how many of the four signals agree. |
| 36 | `needs_review` | bool | computed | `Y` / `N` | See §6 vocabulary. |
| 37 | `needs_review_reasons` | text (semicolon-sep) | computed | `channel_ambiguous;stripe_status_mismatch` | One or more from the closed set in §6. |
| 38 | `notes` | text | computed | `B2B-Keyes detected via company association; plan_key disagreed (saw d2c_monthly)` | Free-form, machine-readable enough for grep. |

**Sort order in CSV:** by `needs_review` DESC (Y first), then by `proposed_workflow_key`, then by `rejig_email`. This puts everything the founder must eyeball at the top.

---

## 6. Review-reason vocabulary (closed set)

Every value of `needs_review_reasons` is one or more of these tokens, semicolon-joined.

| Token | Meaning | Action on apply |
|---|---|---|
| `channel_ambiguous` | Channel detection signals (§7) disagreed; cannot decide D2C vs B2B-Keyes vs B2B-BW with confidence. | Founder must edit `proposed_channel_code` column in CSV before apply; script reads founder's override. |
| `trial_non_keyes` | Customer is Stripe-trialing but channel detection didn't produce `Keyes`. All current trials should be Keyes; this is the exception. | Founder reviews; either confirm channel override or accept. |
| `email_fuzzy_match` | HS Contact found via case-normalized match but original-case strings differ. | Auto-accept on apply; logged. |
| `email_no_match_in_hs` | Rejig email has no HS Contact. Cohort D (Rejig only) — must CREATE HS Contact. | Auto-accept; this is the 63-row cohort. |
| `multiple_hs_contacts_same_email` | More than one HS Contact has this email. | Apply picks the contact with the most associations (heuristic), logs which it skipped. Founder may override via `hs_contact_id` column. |
| `hs_ticket_exists_no_pipeline_match` | HS Contact has a ticket but not in pipeline `0` (CJ). | Treat as no-ticket; create one in CJ pipeline. Logged. |
| `hs_ticket_in_terminal_stage` | Existing ticket is `Lost - Non-Churn` or `Lost - Churned`. | Move to `Churned` (the renamed stage) only if Rejig says canceled/deactivated; otherwise flag as conflict and skip ticket update. |
| `hs_multiple_open_tickets` | More than one open CJ ticket for this contact. | Apply picks oldest; logs the rest. Founder can override via `hs_ticket_id`. |
| `stripe_sub_not_found` | Rejig says `stripe_subscription_id=sub_XYZ` but Stripe returned 404. | Apply still creates LP customer + HS ticket; SKIPS `customer_subscriptions` insert and skips Stripe metadata merge for this sub. Logged. |
| `stripe_status_mismatch` | Rejig `subscription_status` ≠ Stripe `subscription.status` (e.g. Rejig says `active`, Stripe says `past_due`). | Stripe is authoritative; we use Stripe's status for `subscriptionStatus`. Logged. |
| `stripe_customer_mismatch_email` | Stripe customer's email is not equal (case-insensitive) to Rejig email. | Apply proceeds (we are NOT joining on email post-backfill), but logs. |
| `b2b_no_brokerage_company_id` | Channel detected as B2B but the resolved brokerage has no `hubspot_company_id`. | BLOCKING. Apply must abort for this row. Founder must seed brokerage row before re-running. |
| `b2b_company_id_mismatch` | HS Contact already associated to a Company that is NOT the brokerage we detected. | Apply still associates to the detected brokerage (ensureContactCompanyAssociation is additive). Logs both associations. |
| `lp_email_already_exists` | An LP `customers` row already exists for this email (unexpected — today this should be 0). | BLOCKING. Apply must skip and log. |
| `lp_rejig_user_id_already_exists` | An LP `customers` row already has this `rejig_user_id`. | NOOP on apply (script already wrote this row in a prior partial run); resume idempotently. |
| `stripe_no_sub_id` | Rejig row has no `stripe_subscription_id`. | Apply creates LP customer + `customer_subscriptions` row with `stripe_subscription_id=NULL`. Logged. |
| `payment_source_unknown` | Active customer with no Stripe sub_id (demo / data anomaly). Sub-cohort 2 of D2C-no-Stripe. | Apply creates `customer_subscriptions` row with `payment_source=NULL`. Informational only; not blocking. Eyeball recommended. |
| `rejig_no_email` | Rejig row has empty email. | BLOCKING. Cannot identify HS Contact or LP customer. Logged; founder decides. |

Founder-only blocker resolutions cause the apply script to print a count at the top, then proceed for all non-blocked rows.

---

## 7. Channel detection algorithm

Per row, we have up to four signals. Run them in order; first decisive answer wins. Record which signal fired in `channel_detection_evidence`.

**Signal 1 (highest authority): HS Contact ↔ Company association.**
- If `hs_contact_company_match=='keyes'` → channel `Keyes`. Decisive.
- If `hs_contact_company_match=='bw'` → channel `BW`. Decisive.
- If `hs_contact_company_match=='other'` → not Keyes, not B&W. Flag `channel_ambiguous`, default to `Standard` (D2C) but mark for review.
- If `hs_contact_company_match=='none'` or no HS contact → drop to Signal 2.

**Signal 2: Email domain.**
- Lowercase the email; take everything after the last `@`.
- If domain is `keyes.com` → channel `Keyes`. Decisive.
- If domain is `bairdwarner.com` → channel `BW`. Decisive.
- If domain is a public webmail (`gmail.com`, `yahoo.com`, `outlook.com`, `aol.com`, `hotmail.com`, `icloud.com`, `me.com`, `comcast.net`, `att.net`, `verizon.net`) → drop to Signal 3.
- Other domain → drop to Signal 3, but note the domain in `notes` for the founder.

**Signal 3: Rejig `domain_url`.**
- If `domain_url` contains `keyes.com` → channel `Keyes`. Decisive.
- If `domain_url` contains `bairdwarner.com` → channel `BW`. Decisive.
- Otherwise → drop to Signal 4. (B&W pays direct via invoice — no `plan_key` discriminator — so website-domain matching has to come before plan_key.)

**Signal 4: Rejig `plan_key`.**
- If `plan_key` matches case-insensitive substring `keyes` → channel `Keyes`. Decisive.
- If `plan_key` matches case-insensitive substring `baird` or `bairdwarner` or `bw_` → channel `BW`. Decisive.
- If `plan_key` matches `standard|d2c|monthly|annual` → channel `Standard`. Decisive.
- If null / unknown → channel `Standard` (default) and set `needs_review=Y` with reason `channel_ambiguous`.

**Trial check (exceptions-only flag):**
- After signals 1-4 produce a channel, if `rejig_subscription_status=='trialing'` AND computed channel ≠ `Keyes`, set `needs_review=Y` with reason `trial_non_keyes`.
- Rationale: founder asserts all 44 trialing accounts are Keyes today (no other brokerage has trials yet). When signals agree on Keyes, auto-accept. When signals disagree with the trial-is-Keyes assumption, that's a data integrity exception worth flagging.

**Score column (`channel_detection_score`):** number of Signals 1-4 that agreed with the final decision (0-4). Score ≤ 1 → review priority high.

**`proposed_brokerage_id`:** resolved by SELECT against `brokerages` table:
- `Keyes` → `SELECT id FROM brokerages WHERE name ILIKE 'Keyes%' LIMIT 1`
- `BW` → `SELECT id FROM brokerages WHERE name ILIKE '%Baird & Warner%' OR name ILIKE 'Baird%' LIMIT 1`
- `Standard` → NULL

**`proposed_hubspot_company_id`:** taken from the resolved brokerage's `hubspot_company_id` column. If NULL → review reason `b2b_no_brokerage_company_id` (blocking).

---

## 8. Per-cohort handling — decision table

| Rejig sub_status | In HS Contact | Has CJ Ticket | Stripe sub | target onboarding_state | target ticket stage | ticket action | subscription_status |
|---|---|---|---|---|---|---|---|
| `active` | yes | yes (stage = Active) | active | `Active` | `Active` | `noop` | `Active` |
| `active` | yes | yes (stage ≠ Active, not terminal) | active | `Active` | `Active` | `move_stage` | `Active` |
| `active` | yes | yes (stage = Active) | past_due | `Active` | `Active` | `noop` (BI cron will move to Critical via Stripe webhook signal next cycle) | `Past Due` |
| `active` | yes | no | active | `Active` | `Active` | `create_new` | `Active` |
| `active` | no | n/a | active | `Active` | `Active` | `create_new` | `Active` |
| `trialing` (Keyes) | yes | yes (stage = Active) | trialing | `Active` | `Active` | `noop` | `Trial` |
| `trialing` (Keyes) | yes | yes (stage ≠ Active, not terminal) | trialing | `Active` | `Active` | `move_stage` | `Trial` |
| `trialing` (Keyes) | yes | no | trialing | `Active` | `Active` | `create_new` | `Trial` |
| `trialing` (Keyes) | no | n/a | trialing | `Active` | `Active` | `create_new` | `Trial` |
| `canceled` | yes | yes (any stage) | canceled | `Churned` | `Churned` | `move_stage` (or `noop` if already Churned) | `Cancelled` |
| `canceled` | yes | no | canceled | `Churned` | `Churned` | `create_new` | `Cancelled` |
| `canceled` | no | n/a | canceled | `Churned` | `Churned` | `create_new` | `Cancelled` |
| `deactivated` | (any) | (any) | (any) | `Churned` | `Churned` | same as canceled rules | `Cancelled` |
| `active` or `trialing` | (any) | (any) | `not_found` | `Active` (or `Churned` if Rejig says canceled) | per status | per rules | NULL (no `customer_subscriptions` row) — flagged `stripe_sub_not_found` |

Notes:
- **Wrong-stage tickets get moved (no CSM action).** `pushTicketStage` from `hubspot/client.ts`. Logged in CSV `notes`.
- **"Terminal stage"** for `hs_ticket_in_terminal_stage` means `Lost - Non-Churn`. The renamed `Churned` stage is NOT terminal — we move into it freely.
- **Stripe is authoritative** for subscription status when Rejig and Stripe disagree.
- **`current_stage`**: for all backfilled rows, set to fixed string `"Backfilled"` (distinct from organically-launched rows for admin filtering).

---

## 9. Schema migrations — minimum viable

### Migration: rename `customers.rejig_account_id` → `customers.rejig_user_id` + add UNIQUE

The existing schema has `customers.rejig_account_id text` (no unique constraint). The cross-system naming convention uses `rejig_user_id` (HS property, Stripe metadata key, BI signal-handler `customerUsageSignals.rejigUserId`). The mismatch is historical.

**Choose the clean rename, not an additive column.** Rationale: zero production data in `rejig_account_id` today. Renaming costs one diff in `src/lib/bi/trajectory-job.ts` (2 references).

DDL:

```sql
-- Migration: 0009_rejig_user_id_rename_and_unique.sql

ALTER TABLE customers RENAME COLUMN rejig_account_id TO rejig_user_id;

CREATE UNIQUE INDEX customers_rejig_user_id_unique
  ON customers (rejig_user_id)
  WHERE rejig_user_id IS NOT NULL;
```

Drizzle schema diff: `src/db/schema/customers.ts`:
- Rename property `rejigAccountId` → `rejigUserId`.
- Rename column `'rejig_account_id'` → `'rejig_user_id'`.
- Add uniqueIndex declaration matching the SQL.

Code call sites that need updating:
- `src/lib/bi/trajectory-job.ts` — 2 references.

### What we deliberately don't migrate

- No new `rejig_*` columns on `customers` — metrics live in `customer_usage_signals`.
- No new pgEnum value for "Backfilled" current_stage (column is `text`, not pgEnum).
- No new pgEnum value for `change_source` — `'lp_admin'` is already in `CHANGE_SOURCE_VALUES`.

### Migration application order

1. `npm run db:generate` (Drizzle introspects).
2. Manual diff review.
3. `npm run db:migrate` against staging Neon branch.
4. `npm run db:list` to verify.
5. Code change PR (the two-line trajectory-job.ts fix) goes in same commit.
6. Then proceed to backfill apply.

---

## 10. Backfill script spec — `scripts/backfill-rejig-4way.ts`

**Invocation:**

```
npx tsx --env-file=.env.local scripts/backfill-rejig-4way.ts --csv=scripts/data/backfill-audit-2026-05-15.csv [--dry-run | --apply] [--only-rejig-user-id=<id> ...] [--limit=N] [--include-review]
```

Flags:
- `--dry-run` (default): no writes; emits per-row trace.
- `--apply`: performs writes.
- `--only-rejig-user-id=<id>`: scope to a single row or repeated values; useful for replay.
- `--limit=N`: stop after N rows (testing).
- `--include-review`: include rows where `needs_review=Y`. Default: skip them.

**Inputs:**
- The audit CSV from §4-5.
- `HUBSPOT_STATIC_TOKEN`, `STRIPE_LIVE_SECRET_KEY` (or `STRIPE_SECRET_KEY`).
- `POSTGRES_URL_NON_POOLING`.
- `LAUNCHPAD_BACKFILL_CONFIRM=2026-05-15` env var required to enable `--apply`. Hard fence.

**Per-row execution:**

```
For each csv_row:
  // Step 0 — Idempotency check
  IF an LP customer exists with rejig_user_id == csv_row.rejig_user_id:
    Reuse that customer (resume mode); skip Step 4.
  ELSE:
    Use csv_row.lp_customer_id (pre-generated UUID) as the to-be PK.

  // Step 1 — HS Contact upsert
  IF csv_row.hs_contact_id is empty:
    contactId = createContact({ email, firstName, lastName, phone, companyId: B2B-only })
  ELSE:
    contactId = csv_row.hs_contact_id
    updateContactProperties(contactId, {
      launchpad_customer_id: csv_row.lp_customer_id,
      stripe_customer_id: csv_row.stripe_customer_id,
      rejig_user_id: csv_row.rejig_user_id,
      rejig_brokerage_channel: <hs enum value>,
      rejig_payment_mode: <pre-paid / setup-intent-at-intake>,
    })

  // Step 2 — Company association (B2B only)
  IF csv_row.proposed_hubspot_company_id is non-empty:
    ensureContactCompanyAssociation(contactId, csv_row.proposed_hubspot_company_id)

  // Step 3 — Ticket upsert
  IF csv_row.proposed_ticket_action == 'create_new':
    ticketId = createCustomerJourneyTicket({
      subject: f"{name} - LP",
      stageLabel: csv_row.proposed_ticket_target_stage,
      contactId,
      companyId: csv_row.proposed_hubspot_company_id (B2B only),
    })
  ELIF csv_row.proposed_ticket_action == 'move_stage':
    pushTicketStage(csv_row.hs_ticket_id, csv_row.proposed_ticket_target_stage)
    ticketId = csv_row.hs_ticket_id
  ELSE: // 'noop'
    ticketId = csv_row.hs_ticket_id

  // Step 4 — LP customer INSERT (skip if resumed)
  IF new:
    Insert customers row with all known fields, in a transaction:
      - id = csv_row.lp_customer_id
      - name, contact_email, platform_email, phone, business_name, website (from Rejig)
      - type, channel_id (resolved from channel code), workflow_key
      - brokerage_id (B2B only)
      - hubspot_contact_id, hubspot_ticket_id, stripe_customer_id, stripe_subscription_id
      - rejig_user_id
      - subscription_status (per §8 table)
      - current_stage = 'Backfilled'
      - onboarding_state = csv_row.proposed_onboarding_state
      - account_created = TRUE, credentials_sent = TRUE, call_booked = FALSE, call_completed = FALSE
      - created_via = 'backfill'
      - environment = ['prod']

    In same transaction, insert customer_state_transitions:
      - from_state = NULL
      - to_state = csv_row.proposed_onboarding_state
      - change_source = 'lp_admin'
      - source_detail = 'backfill_2026_05_15:rejig=<rejig_user_id>'
      - changed_at = NOW()
      - payload = { backfill_evidence: csv_row.channel_detection_evidence, ... }

    IF csv_row.stripe_sub_id is non-empty AND csv_row.stripe_lookup_status == 'ok':
      Insert customer_subscriptions row (Core only):
        - customer_id = csv_row.lp_customer_id
        - product = 'Core'
        - stripe_subscription_id = csv_row.stripe_sub_id
        - hubspot_deal_id = NULL
        - status = mapStripeSubStatus(csv_row.stripe_sub_status)
        - started_at = sub.start_date (re-fetched at apply time)
        - ended_at = sub.ended_at if cancelled, else NULL
        - mrr = NULL

  // Step 5 — Stripe metadata MERGE
  IF csv_row.stripe_lookup_status == 'ok':
    Re-fetch sub and customer (FRESH read at apply time).
    Compute merged metadata for the CUSTOMER:
      merged_customer_md = {
        ...current_customer.metadata,        // PRESERVE existing keys
        launchpad_customer_id: csv_row.lp_customer_id,
        rejig_user_id: csv_row.rejig_user_id,
        hubspot_contact_id: contactId,
      }
    stripe.customers.update(csv_row.stripe_customer_id, { metadata: merged_customer_md })

    Same MERGE for SUBSCRIPTION:
    stripe.subscriptions.update(csv_row.stripe_sub_id, { metadata: merged_sub_md })

  // Step 6 — Rebind orphan signals
  UPDATE customer_usage_signals
     SET customer_id = csv_row.lp_customer_id
   WHERE customer_id IS NULL
     AND rejig_user_id = csv_row.rejig_user_id;

  // Step 7 — Append-only progress log
  Append row to scripts/data/backfill-apply-log-2026-05-15.jsonl
```

**Per-row error handling:**
- Any HS write failure → log; do NOT roll back LP rows.
- Any Stripe write failure → log; do NOT roll back. Retry via `--only-rejig-user-id`.
- Any LP DB transaction failure → row rolled back; logged.
- Script never aborts en masse.

**Rate limiting:**
- HS: 100ms inter-call gap. ~10/s, under HS's ~100/s limit.
- Stripe: 50ms gap, ~20/s.
- Total expected runtime for 694 rows: ~10 minutes upper bound.

---

## 11. Architect-decision section — resolutions to (A)-(K)

### A. customer_state_transitions seeding — synthetic origin row: YES

Insert exactly ONE row per backfilled customer:
- `from_state = NULL`
- `to_state = proposed_onboarding_state` (Active or Churned)
- `change_source = 'lp_admin'`
- `source_detail = 'backfill_2026_05_15:rejig=<rejig_user_id>'`
- `changed_at = NOW()`
- `payload = { kind: 'backfill', evidence: <channel_detection_evidence>, signals_score: <score> }`

### B. Fuzzy email match policy: case-insensitive trim ONLY (strict)

`email_match_mode` is one of `exact` | `case_normalized` | `none`. Nothing else. No Levenshtein, no plus-addressing strip.

### C. customer_subscriptions rows: YES for Core, when Stripe confirms; SKIP otherwise

Create one `customer_subscriptions` row per backfilled customer where Stripe lookup succeeded. MRR field stays NULL.

Voice / Avatar `customer_subscriptions` rows: never created in this pass.

### D. Stage consolidation aside: NOTE in §14, PROCEED with current stages now

Backfilled tickets land in `Active` or `Churned`. Consolidation can re-map them later.

### E. HS Tickets for existing-Contact-but-no-Ticket cohort: CREATE in target stage directly

No transition through Pre-Onboarding / Onboarding Scheduled. State the customer is in.

### F. Wrong-stage tickets: MOVE during backfill, NO MANUAL CSM WORK

`pushTicketStage` on every wrong-stage ticket. Audit CSV `notes` captures both stages. Exception: `Lost - Non-Churn` is respected, not moved.

### G. The 63 Rejig-only cohort: full HS Contact + Ticket creation

When creating the HS Contact, include these properties at create time:
- `email`, `firstname`, `lastname`, `phone` (empty)
- `launchpad_customer_id`, `stripe_customer_id`, `rejig_user_id`
- `rejig_brokerage_channel`, `rejig_payment_mode`
- `company` (Rejig `business_name` if present)

Do NOT set `onboarding_no_show_count` (default 0).

### H. Idempotency / resumability — confirmed

Per-row idempotency keys: `rejig_user_id` UNIQUE constraint, HS `findContactByEmail`, HS ticket pre-INSERT SELECT, Stripe MERGE, application-level state_transition dedup.

**Audit assertion before apply**: `SELECT COUNT(*) FROM customers WHERE rejig_user_id IS NOT NULL AND created_via='backfill'` before and after. Delta matches CSV needs_review=N count.

### I. Schema migrations needed — ONLY the rename + UNIQUE index

See §9.

### J. Dry-run + verification gates — four gates, founder-approved between each

```
Gate 0 (env): STRIPE_LIVE_SECRET_KEY, REJIG_API_KEY, HUBSPOT_STATIC_TOKEN in env. DB pointing at staging.

Gate 1 (diagnostic): Run scripts/diagnose-4way-mapping.ts.
  Output: backfill-audit-2026-05-15.csv.
  Founder eyeballs first 50 needs_review=Y rows.

Gate 2 (schema): Apply migration 0009 to staging branch.
  Run npm run db:migrate, npm run lint, npm test.

Gate 3 (dry-run): Run scripts/backfill-rejig-4way.ts --dry-run.
  Output: dry-run-trace-2026-05-15.jsonl.
  Founder eyeballs 5 random of each: D2C, Keyes, BW, churned, rejig-only.

Gate 4 (apply, staging then prod):
  Limited prod apply --limit=10 with --only-rejig-user-id hand-picked.
  Verify all 4 systems by hand.
  Full prod apply with LAUNCHPAD_BACKFILL_CONFIRM=2026-05-15.
  Run verify-rejig-4way.ts.
```

### K. Rollback plan

**LP DB:** DELETE FROM customers WHERE created_via='backfill'. Cascade handles subscriptions + transitions. Set signals back to customer_id=NULL first.

**HubSpot:** Newly-created Contacts archive via API. Existing Contact properties clearable (set to empty string). Newly-created Tickets archive. Stage moves reversible via log + `pushTicketStage`.

**Stripe:** Metadata MERGE; rollback by setting our 3 keys to empty string (Stripe interprets as delete). Other keys untouched.

**Compound rollback:** ~30 minutes via `--rollback` mode flags.

---

## 12. Dry-run, apply, post-apply behaviors

Dry-run uses a single boolean threaded down. Each external call wrapped to log "would" if not in apply mode.

Apply writes. Per-row failures don't abort the batch.

Post-apply: `scripts/verify-rejig-4way.ts` runs; read-only.

---

## 13. Verification checklist — pass/fail criteria

| Check | SQL / API call | Pass threshold |
|---|---|---|
| LP customers count | `SELECT COUNT(*) FROM customers WHERE created_via='backfill'` | = (CSV rows with needs_review=N at apply time). |
| LP customers have rejig_user_id | `... WHERE created_via='backfill' AND rejig_user_id IS NULL` | 0 |
| LP customers have onboarding_state | `... WHERE created_via='backfill' AND onboarding_state IS NULL` | 0 |
| LP customers have hubspot_contact_id | `... WHERE created_via='backfill' AND hubspot_contact_id IS NULL` | 0 |
| LP customers have hubspot_ticket_id | `... WHERE created_via='backfill' AND hubspot_ticket_id IS NULL` | 0 |
| LP B2B customers have brokerage_id | `... WHERE type='B2B' AND created_via='backfill' AND brokerage_id IS NULL` | 0 |
| state_transitions appended | `SELECT COUNT(*) FROM customer_state_transitions WHERE source_detail LIKE 'backfill_2026_05_15%'` | = applied count |
| customer_subscriptions count | `... WHERE customer_id IN (backfilled)` | = (applied - skipped) |
| Orphan signals re-bound | `SELECT COUNT(*) FROM customer_usage_signals WHERE customer_id IS NULL AND rejig_user_id IN (backfilled)` | 0 |
| HS Contacts have launchpad_customer_id | sample 20 contacts | 20/20 |
| HS B2B Contacts have Company association | sample 8 B2B contacts | all match expected brokerage |
| HS Tickets in CJ pipeline | sample 20 contacts | all in pipeline 0 |
| HS Ticket stages match plan | sample 20 contacts | 20/20 |
| Stripe customer metadata merged | sample 20 stripe_customer_ids | 3 keys present in all 20 |
| Stripe sub metadata merged | same, for subs | 20/20 |
| BI cron eligibility | active customers count | ≥ (694 - stripe-no-sub count) |
| Audit invariants | every CSV needs_review=N row matches a jsonl log line | 100% |

Spot checks after verification: open `/admin`, open admin customer page for random B2B-Keyes, check HS UI kanban, check Stripe dashboard metadata.

---

## 14. Stage consolidation aside — separate future workstream

The 17-stage CJ pipeline is over-engineered. Future consolidation pass:
1. Audit all open tickets across 17 stages.
2. Bulk-move check-in stage tickets to Active or Watch.
3. Archive 9 stages.
4. Bulk-rename others per Phase 0b.

Backfill does not depend on consolidation. Same stages get used.

---

## 15. Risks, open questions

### Known risks
- Founder edits B2B row with no `hubspot_company_id` on brokerage → BLOCKING per row.
- Stripe rate limit drift → sequential 50ms gap mitigates.
- Race: CSM moves ticket between diagnostic and apply → script re-reads stage at row time.
- Race: Stripe metadata changes between diagnostic and apply → MERGE re-fetches.
- BI cron fires mid-apply → schedule apply away from Monday 11 UTC.
- HS Contact email dedup heuristic mispicks → `hs_multiple_open_contacts` review reason.
- Synthetic state transition row breaks downstream → defensive read in admin UI.

### Open questions (none blocking)
1. `rejig_payment_mode` for backfilled BW: default `pre-paid` unless override.
2. `hubspot_owner_id` left NULL; CSMs claim manually.
3. `csmTeamMemberId` left NULL.
4. Email-domain mapping for IPRE: deferred.
5. `STRIPE_LIVE_SECRET_KEY` rotation policy: don't rotate during backfill window.
6. HS `rejig_user_id` Contact property writes: overwrite existing values; log if differs.

### Monitor in days after apply
- HS Workflow A fires on backfilled Contact (workflows deferred → no issue today).
- BI cron's first run after backfill takes ~3 min (694 × 250ms); within Vercel cron timeout.
- Stripe webhook firings find LP customer via merged metadata.
- HS CSM accidentally moves backfilled ticket.

---

## 16. Implementation checklist

1. ☐ Reviewer pass on this doc — founder sign-off as v1 spec.
2. ☐ Write `scripts/diagnose-4way-mapping.ts`.
3. ☐ Run Gate 1 diagnostic; produce `scripts/data/backfill-audit-2026-05-15.csv`.
4. ☐ Founder review of CSV; edits applied in place.
5. ☐ Write `src/db/migrations/0009_rejig_user_id_rename_and_unique.sql`.
6. ☐ Update `src/db/schema/customers.ts`.
7. ☐ Update `src/lib/bi/trajectory-job.ts`.
8. ☐ Run Gate 2 (npm run db:migrate against staging).
9. ☐ Write `scripts/backfill-rejig-4way.ts`.
10. ☐ Write `scripts/verify-rejig-4way.ts`.
11. ☐ Gate 3: dry-run on staging.
12. ☐ Gate 4: 10-row limited prod apply.
13. ☐ Gate 4: full prod apply.
14. ☐ Verification + sign-off.

---

## 17. Files this plan affects

**To be authored:**
- `scripts/diagnose-4way-mapping.ts`
- `scripts/backfill-rejig-4way.ts`
- `scripts/verify-rejig-4way.ts`
- `src/db/migrations/0009_rejig_user_id_rename_and_unique.sql`

**To be modified:**
- `src/db/schema/customers.ts` — rename property; add unique index declaration.
- `src/lib/bi/trajectory-job.ts` — 2 references to `rejigAccountId`.

**Read-only references:** see §17 reference list in agent output.

---

## §18 Validation memo: Mongo _id + subscription columns

Status: ARCHITECT VALIDATION — pre-build sign-off (2026-05-15).
Scope: validates additions to §5 / §9 / §10 / §11 — using Mongo `_id` timestamp as a renewal anchor, and adding new columns to `customer_subscriptions`. **This section supersedes earlier sections where they conflict.**

### Round 1: Mongo `_id` timestamp approach

#### 1. Batch-loaded B&W agents — SUPERSEDED

Founder confirmation (2026-05-15): B&W accounts were created by humans one at a time in Rejig. No CSV upload, no bulk-create. Cluster detection and the `_id_batch_cluster` CSV column are NOT needed. The `current_period_start_source` column is still added for provenance tracking.

#### 2. Drift between `_id` and "first paid" date — LOW likelihood, LOW impact

B&W doesn't trial; `_id` ≈ account-creation ≈ first-engagement, close enough for 6-month window. No action needed.

#### 3. Re-signed customers — LOW likelihood, LOW impact

New `_id` carries re-signup timestamp — exactly what we want. The existing `multiple_hs_contacts_same_email` review reason handles email-collision case. No action.

#### 4. Malformed `_id` values — LOW likelihood, BLOCKING-per-row impact

Defensive parsing:
- Length: exactly 24 hex chars
- Charset: hex only (case-insensitive)
- Timestamp extraction: `parseInt(_id.substring(0, 8), 16) * 1000`
- Sanity range: between `2020-01-01` and `today + 1 day`

On failure: `current_period_start = NULL`, `current_period_start_source = 'unparseable'`, review reason `mongo_id_unparseable` (BLOCKING).

#### 5. Time zone — LOW likelihood, LOW impact

Use `date-fns addMonths()` for month arithmetic (clamps to last day of month — matches Stripe behavior).

#### 6. Alternative anchors — DECISION

- B&W: Mongo `_id` only signal available (Rejig's `plan_expiry_date` is sentinel 2027-12-31)
- D2C-no-Stripe: Mongo `_id` for period_start, Rejig `plan_expiry_date` for period_end (real for D2C)
- Stripe customers: Stripe `current_period_start/end` (authoritative). `_id` never used here.

### Round 2: Schema additions to `customer_subscriptions`

#### Per-column readability impact

Verified by grep: existing readers of `customer_subscriptions` are only `closedwon-handler.ts` (writer) and the schema index re-export. **No admin/workspace UI consumers**. Adding 5-6 nullable columns is safe.

#### Final column list (6, not 5)

| # | Column | Type | Nullable | Source |
|---|---|---|---|---|
| 1 | `current_period_start` | timestamptz | yes | Stripe `current_period_start` / Mongo `_id` |
| 2 | `current_period_end` | timestamptz | yes | Stripe `current_period_end` / `_id + 6mo` / Rejig `plan_expiry_date` |
| 3 | `current_period_start_source` | text | yes | `'stripe' \| 'mongo_id' \| 'rejig_expiry' \| 'unparseable'` |
| 4 | `last_invoice_status` | text | yes | `'paid' \| 'open' \| 'uncollectible' \| 'void' \| NULL` |
| 5 | `last_invoice_url` | text | yes | Stripe `hosted_invoice_url` |
| 6 | `payment_source` | pgEnum (`payment_source_enum`) | yes (nullable) | `'stripe' \| 'invoice'` ; NULL for unknown/demo |

`payment_source` as pgEnum (not text) — matches the codebase pattern.

**`last_invoice_*` writers:** Stripe webhook on `invoice.paid` / `invoice.payment_failed` / `invoice.finalized` (when status=open) / `invoice.voided`. **Do not derive from `customer.subscription.updated`** — subscription status and invoice status are independent in Stripe.

**Index:** add `idx_customer_subscriptions_current_period_end` defensively. Future-proof; cost is 8KB.

#### Per-cohort payment_source breakdown

D2C-no-Stripe (75 rows) splits into two sub-cohorts:

**Sub-cohort 1: Historically Stripe-paid, now cancelled.** Rejig dropped `stripe_subscription_id` when they churned, but they paid via Stripe historically.
- `payment_source = 'stripe'` (historical truth)
- `current_period_start = Mongo _id timestamp`
- `current_period_end = Rejig plan_expiry_date` (real date for D2C)
- `current_period_start_source = 'mongo_id'`
- `status = 'Cancelled'`

**Sub-cohort 2: True demos / data anomalies (active, no sub).** Examples: `lisa@treugroup.com` (data anomaly per memory), UniqueCollective demo accounts.
- `payment_source = NULL` (no known payment arrangement)
- `current_period_start = Mongo _id timestamp`
- `current_period_end = Rejig plan_expiry_date` if populated, else NULL
- `current_period_start_source = 'mongo_id'`
- `status = 'Active'`
- New review reason: `payment_source_unknown` (informational, not blocking)

#### Trialing customers (Keyes) — no change

Stripe `status='trialing'` means a subscription exists but is unbilled. All 44 trial customers have a real `stripe_subscription_id` and flow through the standard Stripe path. `payment_source='stripe'`, period_start/end from Stripe.

#### B&W UX semantics

When `payment_source='invoice'` AND `last_invoice_status IS NULL`: HS card renders "Direct invoice (B&W master agreement)". Suppress payment-status indicator.

When `payment_source IS NULL`: HS card renders "No active payment arrangement — review" — surfaces demos and data anomalies for CSM eyeball.

### Round 3: BI cron derivation change

Six consumers of `daysUntilExpiry` identified (state-mapper, outcome-predictor ×2, action-recommender A14, HS Contact property push, HS card). **Semantics stay the same; only the source changes.** No consumer breaks; all get more accurate data.

**New `daysUntilExpiry` derivation in `src/lib/bi/context.ts`:**
```
1. If customer_subscriptions.current_period_end IS NOT NULL:
     return floor((current_period_end - now) / MS_PER_DAY)
2. Else if customer_usage_signals 'rejig.days_until_expiry' latest row exists:
     return that value (legacy fallback)
3. Else: return null
```

This makes rollout incremental: backfill populates `current_period_end` for all 694; new customers (post-backfill) get it from Stripe webhook; legacy fallback still works.

### Round 4: Backwards compatibility

- TypeScript inferred types: 6 nullable additions — `$inferInsert` makes them optional. No call-site changes.
- `POST /api/customers` route: doesn't write to `customer_subscriptions`. Not affected.
- Drizzle migration: clean. `timestamptz` matches existing pattern. pgEnum is standard.

### Critical schema change: relax `stripe_subscription_id NOT NULL`

The §11.C decision (create `customer_subscriptions` row only for Stripe customers) is **superseded** by §18. **Always create a row for ALL backfilled customers**, regardless of payment source. Requires:

```sql
ALTER TABLE customer_subscriptions ALTER COLUMN stripe_subscription_id DROP NOT NULL;
DROP INDEX customer_subscriptions_stripe_subscription_unique;
CREATE UNIQUE INDEX customer_subscriptions_stripe_subscription_unique
  ON customer_subscriptions (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;
```

This is a more invasive schema change than originally specified. Flagged for founder visibility.

### Final verdict

**Go-with-changes.** Required adjustments to integrate into the main plan body:

1. **§5 (CSV columns):** Add `proposed_current_period_start`, `proposed_current_period_end`, `proposed_current_period_start_source`, `proposed_payment_source`, `_id_batch_cluster` boolean
2. **§9 (Migration):** Add 6 nullable columns + 1 pgEnum + 1 index + relax NOT NULL on `stripe_subscription_id` + partial unique
3. **§10 (Backfill Step 4):** Always insert `customer_subscriptions` row, cohort-correct period fields
4. **§11.C (Decision):** "Create `customer_subscriptions` row for ALL backfilled customers"
5. **§7 / §11.K (Rollback):** Clear 6 new columns on partial rollback
6. **§4 (Diagnostic):** `_id`-cluster detection (≥5 B&W rows in 60s = flagged)
7. **`src/lib/bi/context.ts`:** New `daysUntilExpiry` derivation with two-step fallback
8. **`src/app/api/webhooks/stripe/route.ts`:** Write the 5 invoice/period columns on `customer.subscription.updated` + 4 invoice events
9. **HS Engagement card UX** (deferred to post-backfill): render `payment_source` + `last_invoice_status` semantics

### Files affected

- `scripts/diagnose-4way-mapping.ts` — `_id` cluster detection, timestamp parser, 5 new CSV columns
- `scripts/backfill-rejig-4way.ts` — always insert `customer_subscriptions` row
- `src/db/schema/customerSubscriptions.ts` — 6 new columns, partial unique index, relax notNull
- `src/db/schema/enums.ts` — new `payment_source_enum`
- `src/db/migrations/0010_subscription_columns.sql` — new migration
- `src/app/api/webhooks/stripe/route.ts` — new invoice + sub-update handler (~50 lines)
- `src/lib/bi/context.ts` — new `daysUntilExpiry` derivation (~15 lines)
- `launchpad-integration/src/app/cards/EngagementCard.jsx` — deferred UX update

---

End of plan.
