# LaunchPad post-launch architectural simplification — Plan (Pass 1)

> **Status:** Pass 1 plan completed 2026-05-14 by the architect/Plan agent. Open questions in Section 6 must be resolved with the user before Phase 1 execution. Phases 2-10 are high-level; each will get a dedicated Plan pass before execution.

## 1. Architectural overview

The shift is sound. LaunchPad's surface area collapses from "lifecycle CSM workspace" to "intake + pre-launch orchestrator + post-launch BI engine driving HubSpot ticket state." The post-launch lifecycle moves out — into HubSpot ticket stages — where CSMs already work. LaunchPad's job ends the moment a D2C or B2B customer has credentials + a first sign-in, at which point the portal renders a permanent "handy page" and the workflow_templates rows below that boundary cease to exist.

What this buys: one source of truth per concern (HubSpot owns post-launch ticket state; LaunchPad owns pre-launch workflow + BI rules; Stripe owns billing). The cost it has to manage carefully: a bi-directional sync between two systems that both write to ticket state (HubSpot Workflows + LaunchPad BI cron). The design hangs on `change_source` discipline, an authoritative-writer-per-rule contract that gets refined in Phase 9 once we've seen real conflicts.

**Two architectural risks the original brief didn't name explicitly:**

- **Schema bifurcation: `customers.currentStage` is the pre-launch progression; HubSpot ticket stage is the post-launch progression.** They are intentionally disjoint sets, but they live in the same column today (Done is the only post-launch value LaunchPad sets). The mental model is cleaner if pre-launch and post-launch states live in different columns from the start. (Scrutiny point 7 lands here.)
- **The "handy page" is a permanent post-launch portal surface; today `/r/[token]` is a workflow-driven page that withers when there are no active tasks left.** The handy page needs to be a routed, durable, branded surface separate from the task pipeline UI, otherwise CSMs and customers will keep hitting the workflow shell after launch. The handy page is the customer's permanent home base, not a "thanks for finishing" screen.

The plan below is structured so Phase 1 produces value on its own (truncated workflow, terminal stage, handy page) even if Phases 2-10 slip.

## 2. The 14 scrutiny points — architect recommendations

**1. `customer_state_transitions` vs existing `events` table overlap.** `events` is the right place for human-readable audit ("Stage Changed", "Task Completed"). `customer_state_transitions` should be narrower and structurally typed: a row per (customer_id, from_state, to_state, change_source, change_reason, ticket_id, occurred_at). Different query shape — BI cron + admin dashboards filter on (customer_id, change_source) ranges; `events` is per-customer narrative. **Keep both; don't merge.** Write the same transition to both (one structured, one human-readable), with the events row carrying the transition row's id in `details.transition_id` for join.

**2. `customer_usage_signals` schema flexibility — tall-skinny.** Agree with the lean. Wide-table would require a migration per new signal type; tall-skinny lets Rejig pipe Phase 9 add signals without schema churn. Concrete shape: `(id, customer_id, rejig_user_id, signal_type, signal_value_numeric, signal_value_jsonb, observed_at, source, ingested_at)` — separate numeric column for time-series math, jsonb for richer payloads.

**3. Stripe signal ingestion — yes, both, but with one writer per fact.** Stripe webhook continues updating `customers.subscriptionStatus` (the current state — fast read path). Stripe webhook also writes a `customer_usage_signals` row with `signal_type='stripe.subscription.status_changed'` (the time-series). Wrap both in one db.transaction in the webhook handler.

**4. BI rule structure — TS functions, not DB rows.** Strongly agree. Rules need branching logic, conditional message generation, and unit tests. TS functions live in `src/lib/bi/rules/*.ts`; a `src/lib/bi/registry.ts` exports them as an ordered array; the cron loops customers × rules.

**5. Loop prevention edge cases.** Two race classes. Same-direction race (both writers same value): idempotent. Opposite-direction race: **the dangerous case is reading-stale** — BI reads `customers.onboardingState='Active'`, decides to move to `Watch`, but in the meantime HS Workflow B moved the ticket to `Pre-Onboarding`. Mitigation: BI cron writes are conditional UPDATE `WHERE onboarding_state = <expected>` (same pattern Auto 2 already uses).

**6. In-flight customers during Phase 1 deploy — auto-complete with notes.** Any task whose `(customerId, taskName)` belongs to a deleted template should be auto-Completed (not Cancelled) with `notes = 'Auto-completed during post-launch migration 2026-05-XX'`. Drop those tasks from `task_dependencies` (both directions). Bypass Auto 2 — raw `db.update`. Add an event row per customer summarizing what was cleaned up.

**7. `currentStage` vs `onboardingState` distinction — yes, name them separately.** `currentStage` = LP pre-launch progression terminal at `Launched`. `onboardingState` = post-launch HubSpot mirror (Pre-Onboarding/Onboarding Scheduled/Active/Watch/At-Risk/Critical/On Hold/Churned). **They never share a value.** Two columns, two state machines, one transition point (the Launched moment).

**8. Test data purge script safety.** Standard set: `--dry-run` default-on, `NODE_ENV !== 'production'` check, env-based allowlist, require explicit `--confirm-i-know-this-is-destructive` flag, hard-bail if affected rows exceed configurable max.

**9. Rejig client design.** Auth: bearer token in env. Pagination: `?page=N&per_page=200` assumed. Retry: exponential backoff (1s,2s,4s,8s,16s), 5 attempts. Rate limit: ≤2 req/s default. Fields: the 22 columns in the existing CSV. Lives in `src/lib/integrations/rejig/client.ts` mirroring the HubSpot client pattern.

**10. Identity mapping safety.** Email is the join key, case-insensitive, trimmed. **No silent merges** — when multiple matches exist across systems, write to a `customer_identity_conflicts` log. Unmatched LP customers → gap report. Multiple Rejig users sharing an email: surface in gap report with a deterministic tiebreaker (latest activity), but never silently merge.

**11. Brokerage detection rules for backfill.** Three-tier: (a) HS Contact's associated Company matches Keyes/B&W by ID. (b) Email domain heuristic (`@keyes.com` → Keyes; `@bairdwarner.com` → B&W). (c) Rejig's `Broker ID` column when populated. Fallback for ambiguous: default to D2C with `attentionReason='manual_review_brokerage_unknown'`.

**12. `customer_usage_signals` cardinality.** 2.5M/year × ~10 years = 25M rows. Postgres handles easily. Required indexes: `(customer_id, signal_type, observed_at DESC)` for BI cron read; `(observed_at)` partial for dashboards. Don't prune for v1; revisit at 50M rows.

**13. Stripe signal taxonomy.** Initial 8 signal types: `stripe.subscription.{created,activated,past_due,cancelled,trial_will_end}`, `stripe.invoice.{payment_failed,payment_succeeded}`, `stripe.setup_intent.succeeded`.

**14. Customer-type inference for Rejig super-set.** (a) Email domain → known brokerage. (b) Rejig's `Broker ID` field → brokerage. (c) Default to D2C with `attentionReason='manual_review_customer_type_inferred'`. Don't be clever; surface ambiguity for admin to confirm.

## 3. Phase 1 detailed plan

### 3.1 Schema changes

Single Drizzle migration `0006_*.sql`. **No new columns** — `onboardingState/attentionReason/attentionSetAt/createdVia` land in Phase 2 (behavior-neutral). Phase 1 is intentionally minimal — only the truncation + handy page + the `Launched` terminal value + cleanup. The `customers_workflow_key_format` CHECK stays.

### 3.2 `workflow_templates` row deletions

The post-launch rows to delete (by `workflow_key` + `task_title`):

**D2C-Standard** (6 rows from Stages 4, 5, 6):
- `Mark Onboarding Call Complete` (stage `Onboarding Call`)
- `Send Zoom Recording`, `Send Follow-Up Email`, `Provide Onboarding Feedback` (stage `Post Onboarding`)
- `Schedule Check-In 1`, `Schedule Check-In 2` (stage `Review & Grow`)

**B2B-Keyes** (6 rows): same 6 task titles, stages `Onboarding Call`, `Post Onboarding`, `Review & Grow`.

**B2B-BW** (6 rows): same 6 task titles, stages `Onboarding Call`, `Post Onboarding`, `Review & Grow`.

Total: 18 rows deleted via `DELETE FROM workflow_templates WHERE workflow_key IN (...) AND task_title IN (...)` in the migration.

**Re-numbering check:** verified during planning — no remaining templates depend on deleted task names.

### 3.3 No new "Launched" workflow_templates row

`Launched` is a terminal stage with zero tasks — it's a string value `currentStage` can hold, written by Auto 2. Change the existing Auto 2 "no next stage" terminal value from `'Done'` to `'Launched'` **only for `product === 'Core'`**. Voice/Avatar add-on workflows keep `'Done'` as their terminal.

### 3.4 Launched trigger location

Already the natural fall-through of `handleTaskCompleted` when the final stage's last task completes. After Phase 1 deletions, the final stage for each workflow becomes `Prepare for Onboarding`. When both `Watch Setup Video` and `Sign In & Reset Password` complete, the stage advance writes `currentStage = 'Launched'`. **No new code path needed.**

### 3.5 HubSpot ticket stage push on Launched

When Auto 2 writes `currentStage = 'Launched'`, also push the HS ticket to `Onboarding Scheduled` (the renamed stage HS already has). Workflow F's job is then to move it from there as meetings happen. Helper `pushTicketStage()` goes in `src/lib/integrations/hubspot/client.ts`. Failures log and do not throw — HS push is best-effort, the LP-side `Launched` is the canonical signal. Phase 3 will add retries.

### 3.6 Portal handy page

`src/components/PortalHandyPage.tsx` — durable post-launch surface separate from `TaskList`. Router check in `src/app/r/[token]/page.tsx`: if `customer.currentStage === 'Launched'`, render `<PortalHandyPage>`; else render `<TaskList>`.

Sections: Primary (Go to Rejig + Reset password if applicable), Support (Book call, Chat, Email), Account (Sign-in email, Brokerage if B2B, Onboarding completed date).

Per-workflow link variation in a `HANDY_PAGE_LINKS` constant map.

### 3.7 HubSpot Workflows F and G — user builds in HubSpot UI

**Workflow F — "Meeting created → set ticket to Onboarding Scheduled"**
- Trigger: Contact has associated Meeting where `hs_created` is known
- Enrollment filter: Contact's Ticket status = `Pre-Onboarding`
- Action: Set associated Ticket's `hs_pipeline_stage` → `Onboarding Scheduled`

**Workflow G — "Meeting created → create CSM task 'Send Zoom recording'"**
- Trigger: same
- Enrollment filter: Contact's Ticket status = `Pre-Onboarding` OR `Onboarding Scheduled` (defensive)
- Action: Create HubSpot Task — Title `Send Zoom recording — {Contact: firstname} {Contact: lastname}`, assigned to Meeting host, due `hs_meeting_start_time` + 1 day, associated to Contact + Ticket

### 3.8 One-time cleanup script

`scripts/phase-1-cleanup-orphaned-tasks.ts`. Idempotent, dry-run default.

Logic: identify deleted-template task titles, find non-Completed tasks matching, per-customer transaction: UPDATE tasks SET status='Completed' + notes; DELETE from task_dependencies; INSERT event row. For customers whose current_stage is a deleted post-launch stage, advance to `Launched` directly. **Does NOT call `handleTaskCompleted`** — raw `db.update`.

Smoke-test cohort: Poorab LP Two (`f2d70da2-03a4-48c2-b86e-2624174c5401`), Matt Keyes (`75667fd2-54b5-4343-ac17-95d7546d61b7`), Mansi D2C (`65fda732-de06-4ae3-8d99-0a2af1d9b074`).

### 3.9 Doc updates

- `docs/flows/{d2c-standard,b2b-keyes,b2b-bw}.md` — delete Stages 4-6 (D2C) / 3-5 (B2B); new terminal "Launched" section; task count updates
- `docs/flows/README.md` — task count column; rewrite rule-of-thumb #2
- `docs/integrations/hubspot-integration.md` — add Workflow F + G to Step 5; note LP-ends-at-Launched
- `CLAUDE.md` — add LP-ends-at-Launched note

### 3.10 Test plan (manual verification gates)

1. Schema state: workflow_templates row counts D2C=11, Keyes=7, BW=6 (down from 17/13/12)
2. Cleanup script dry-run on Poorab LP Two; verify manifest; --apply; verify `currentStage='Launched'`
3. Fresh test D2C customer end-to-end → Launched
4. HS ticket stage push verified
5. HS Workflows F+G fire correctly
6. Full B2B-Keyes regression
7. Handy page renders correctly

### 3.11 Phase 1 risks

Biggest risk: silently breaking the `Mark Onboarding Call Complete` deletion for customers whose Calendly webhook hasn't fired yet. Mitigation: Calendly webhook code reassigns this task; once the task doesn't exist, that block becomes a silent no-op. Secondary risk: customers mid-Stage-2 (D2C) at deploy time who haven't booked their call still have the `Schedule Your Onboarding Call` task — they continue working via existing Calendly/HubSpot Meetings webhook → Auto 2 path. No data loss.

## 4. Phases 2-10 high level

(See sections in the Plan agent's original response — kept here only as a summary for reference, not for execution detail.)

| Phase | What | Risk to watch |
|---|---|---|
| 2 | Schema foundation: new columns + tables; suppression flags | `change_source` enum values locked here |
| 3 | Bi-directional sync via HS webhook handler | Stage-name vs stage-id mapping drift |
| 4 | BI v1 rules using Stripe + time-based signals only | Rule ordering priority |
| 5 | Lock usage signal taxonomy; one-shot Rejig CSV import | Snapshot signals are point-in-time, not time-series |
| 6 | Identity mapping (Rejig ↔ LP ↔ HS ↔ Stripe) | Legacy email changes / collisions |
| 7 | E2E validation on 1-2 fully-connected customers | Sample may not exercise all rules |
| 8 | Mass backfill: HS tickets for orphan Rejig users | Brokerage detection mis-categorization |
| 9 | Live Rejig pipe + conflict policy checkpoint | CRM card extension permissions |
| 10 | HS pipeline migration; archive legacy stages | Hidden tickets in legacy stages |

## 5. Cross-cutting risk register

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | Loop between HS Workflow writes and LP BI writes | High | `change_source` discipline + conditional UPDATE + own-echo filter |
| 2 | `customer_state_transitions` cardinality explosion | Medium | Daily cron in v1; retention pruning at 50M rows |
| 3 | Rejig CSV import stale data treated as fresh | Medium | Import sets `observed_at` to CSV export date; BI uses observed_at |
| 4 | Email-collision identity merges | High | No silent merges; gap report for ambiguity |
| 5 | HS Workflow F/G race with LP Auto 2 around Launched | Low | Workflow F's enrollment filter accepts both Pre-Onboarding AND Onboarding Scheduled |
| 6 | Phase 1 cleanup script corrupts mid-flight customer | High | Dry-run default, per-customer transaction, idempotent, no Auto 2 cascades |
| 7 | `currentStage` vs `onboardingState` confusion | Medium | Explicit per-column docstrings; never `WHERE x OR y` |
| 8 | Stripe webhook double-write non-atomic | Low | Single db.transaction; 500 on partial → Stripe retries |
| 9 | BI rule priority ambiguity | Medium | Registry is ordered array; first match wins |
| 10 | Handy page link maintenance dumping ground | Low | Lock taxonomy at 3 sections; reject additions without product review |

## 6. Open questions — resolved 2026-05-14

1. **Launched stage value** ✅ `'Launched'` for Core; Voice/Avatar add-ons keep `'Done'`.
2. **HS ticket stage at Launched** ✅ Push to `Onboarding Scheduled`. Meeting hasn't happened yet → `Active` would be wrong.
3. **Handy page support meeting URL** ✅ HubSpot **support** round-robin link (separate from the onboarding round-robin, with 15/30/45 minute slot options). User to provide URL when ready.
4. **Smoke-test cohort customer IDs** ✅ Poorab LP Two (`f2d70da2-03a4-48c2-b86e-2624174c5401`), Matt Keyes (`75667fd2-54b5-4343-ac17-95d7546d61b7`), Mansi D2C (`65fda732-de06-4ae3-8d99-0a2af1d9b074`). User may add a fresh test customer.
5. **CSMs no longer mark Onboarding Call Complete** ✅ HS Meeting outcome → Completed (Workflow A) is the equivalent signal.
6. **B2B-Keyes Stripe sub creation** ✅ **Belts and suspenders** — three idempotent layers:
   - **Primary (A):** LP webhook on `ticket.propertyChange:hs_pipeline_stage = Active` → fire Auto 8 (Stripe sub creation). Single, narrow-purpose handler. ~30 LOC.
   - **Secondary:** HubSpot creates a CSM Task ("Activate trial subscription") for B2B-Keyes / IPRE / future trial-mode brokerage customers when ticket → Active. CSM can click an admin button in LP that re-fires Auto 8 manually (still idempotent on Stripe side).
   - **Tertiary:** BI signal in Phase 4: "B2B customer ticket = Active AND no Stripe subscription_id set" → attention reason `trial_not_activated`. CSMs see it on their kanban.
   - **Phase 1 cleanup must also invoke Auto 8** when advancing a B2B-Keyes customer to `Launched` without a Stripe subscription_id already set (rare edge case but real for in-flight customers).
7. **Doc updates** ✅ Bundled with Phase 1 code.
8. **Cleanup dry-run review** ✅ Both — I produce dry-run manifest, user reviews, then `--apply`.
9. **Admin UI Launched sort parity** ✅ Yes — same sort as Done.
10. **Calendly residual** ✅ Template URLs + existing customer tasks already swapped to HubSpot Meetings. Calendly webhook code (`/api/webhooks/calendly/route.ts`) remains as a silent no-op for now; can be deleted in a later cleanup.

**User's reminder on workflow differences:** Stages/workflow differ by D2C, B2B-Keyes, B2B-BW. Cleanup script must be workflow-key-aware. (Stage names happen to be identical across the three for deleted stages — `Onboarding Call` / `Post Onboarding` / `Review & Grow` — but the per-customer workflow_key still drives the right "Launched"-target logic and the B2B-Keyes Stripe trigger.)

## 7. Pass 2+ checkpoints

- **Pass 2 — before Phase 4 (BI rules).** Algorithm discussion materials + rule signature spec + worked examples → lock rule registry contents and priority ordering.
- **Pass 3 — before Phase 6 (identity mapping).** Review Phase 6 gap report after first dry-run; design manual override table if collisions exceed threshold.
- **Pass 4 — before Phase 9 (conflict policy).** Review real conflict scenarios from `customer_state_transitions` between Phases 7-8; design conflict policy from data.
- **Pass 5 — before Phase 10 (HS pipeline migration).** Design bulk re-stage logic with actual HS state at that time.

## 8. Critical files for implementation

- `src/lib/automations/activate-dependents.ts` (modify — Launched terminal value)
- `src/app/r/[token]/page.tsx` (modify — handy page router)
- `src/db/migrations/0006_*.sql` (new — DELETE seed)
- `src/components/PortalHandyPage.tsx` (new)
- `scripts/phase-1-cleanup-orphaned-tasks.ts` (new)
