# Plan — Pre-Launch Drop-off Reminder Cron

**Status:** Draft, pending architect review.
**Author:** Claude (LaunchPad)
**Date:** 2026-08-05

**Relationship to `payment-mode-dropoff.md`:** That doc's Phase 2 ("Reminder cron + At Risk fields") specced a version of this and was never built. This plan supersedes that Phase 2 section: it drops the `atRisk`/CSM-kanban escalation model (decided against — see Decision 4) and drops the hardcoded per-task-name trigger list (decided against — see Decision 1) in favor of a state-based rule that works across every current and future workflow. Everything else in that doc (payment mode config, SetupIntent flow, Calls-driven sub creation) is shipped and untouched by this plan.

---

## Problem

Customers stall pre-`Launched` and nobody notices until someone runs a manual audit (see the `scripts/audit-stuck-customers.ts` one-off from 2026-08-04). Two flavors:
- **Customer-side stalls**: an Active client-facing task sits untouched (design approval, call booking, intake form, card capture, etc.) — found via manual audit: a D2C customer stuck 50 days on brand-kit approval, two B2B-IPRE customers stuck 18–26 days on call booking.
- **Team-side stalls**: an Active internal task (design work, account creation, sending credentials) sits untouched. Not audited yet but the same failure mode.

Nothing currently reminds either side, and nothing escalates when reminders don't work.

---

## Design

### Decision 1 — State-based detection, not a hardcoded task list

The cron does not maintain a list of task names to watch. It asks: does this non-`Launched` customer have any task sitting `status = 'Active'` past a day threshold? That's it — no `taskName IN (...)` filter.

**Why:** Live `workflow_templates` audit (2026-08-05) shows task names are already reused across workflows (`Schedule Your Onboarding Call` appears in D2C-Standard, B2B-Keyes, B2B-IPRE, B2B-BW), but the *sets* differ per workflow (B2B-RUHL has no call-booking task at all — it's an intake-only pilot). A hardcoded list needs updating every time a brokerage's flow changes shape, which is exactly what CLAUDE.md's "don't hardcode workflow logic, new workflow = new `workflow_templates` rows" rule exists to prevent. State-based detection covers every current workflow and every future one seeded via templates, with zero code change.

**Consequence for email copy:** since the stalled task isn't a known quantity, the reminder email is generic, built from the task's own `instructions` field (already populated per-template at creation), falling back to the task title if blank. One template, not one per task.

**Stopping condition falls out for free:** once a customer has no Active client-facing task, they're either `Launched` or between tasks — the cron simply stops finding them. No explicit "is this Launched" branch needed (kept as a filter for query efficiency, not correctness).

### Decision 2 — Schedule: day 2 / 5 / 8, uniform across every workflow

Same three thresholds for every workflow (D2C, Keyes, IPRE, BW, Ruhl, future). No per-task or per-workflow variation — matches the original architect ruling on `payment-mode-dropoff.md` ("cut per-task reminder threshold variation... tune from data only when needed"), extended to also mean no per-workflow variation until there's data to justify it.

Reminder tiers, computed off `tasks.activatedAt`:
- Day 2 → reminder 1
- Day 5 → reminder 2
- Day 8 → reminder 3 (final)

After day 8: no more reminder emails to the customer/assignee. The task just sits — surfaced only via the escalation tracks below (D2C real-time, B2B weekly digest), never via a customer-facing `atRisk` flag.

**Storage:** reuse `tasks.lastReminderAt` (already exists, currently unused — schema-only since the field was added pre-migration and never wired up). No new counter field, matching the original review's ruling against `Reminder Count`. Each cron run: compute which tier is due (`highest threshold ≤ daysSinceActivation`), compare against the tier implied by `lastReminderAt`'s age since `activatedAt`; send only if a new tier just became due.

### Decision 3 — Customer + team reminders (Tracks 1 and 5)

**Track 1 — Customer reminders.** `taskType = 'Client' AND visibleToClient = true AND status = 'Active'`. Recipient: `customer.contactEmail`. Skips: `createdVia = 'backfill'`, `environment @> '{test}'`, no email on file — same guards `triggerCustomerEmail` already uses.

**Track 5 — Team reminders.** `taskType = 'Team' AND status = 'Active' AND assignedToTeamMemberId IS NOT NULL`. Recipient: the assignee's `team_members.email`. Tasks with no assignee are skipped (logged, not escalated — there's a partial precedent here: `notify-assignee.ts` already sends a one-time "task assigned" email on activation; this is a repeating version of the same idea, not a new pattern). Day 8, if still Active: escalate to the fixed internal trio (`success@/poorab@/matt@rejig.ai`) — same recipients `daily-checks` already uses, no per-role routing table for v1.

### Decision 4 — Escalation, split by segment (Tracks 2, 3, 4)

Explicitly **not** using the `atRisk`/`atRiskReason` fields or the `/workspace/book` kanban — decided against per 2026-08-05 discussion. `atRisk` stays exactly as it is today (manually settable, read-only in the UI, no automated writer).

**Track 2 — D2C escalation (real-time).** Day 8, on top of (not instead of) the final customer reminder: one email to `customer.salesRepEmail` (deal owner captured at HubSpot closedwon — already on the customer row, already used to CC the Welcome email). Greeting is plain — "Hey `{email}`" — no name lookup (`getOwnerEmailById` only fetches email today; deliberately not extending it to fetch name, per 2026-08-05 discussion — internal email, doesn't need to be personalized). CC: Matt + Poorab (confirmed temporary — revisit who's permanently on this CC once the pattern is proven out).

*Why real-time is fine for D2C but not B2B:* each D2C deal has a different rep, so escalations fan out across many inboxes. Real-time doesn't create a concentrated noise problem the way it would for a small team catching every ping.

**Track 3 — B2B escalation (weekly digest).** No real-time per-customer escalation — folded into the existing Sunday `weekly` cron (`src/app/api/cron/weekly/route.ts`) as a new section, same pattern as that route already sequencing `importRejigSnapshot` → `runAllActiveSyncs` → BI dispatch. One email to `success@rejig.ai` (+ Matt/Poorab), a table of B2B customers currently sitting in the day-2/5/8+ buckets, grouped by brokerage and which task they're stuck on. Stateless/derived like `daily-checks` — a customer who's still stuck next Sunday just reappears; no dedupe, no "already told you" tracking.

**Track 4 — B2B hot case (card saved, call not booked).** No separate trigger. Detected the same way as everything else, purely from state: workflow's payment mode is `setup-intent-at-intake` (Keyes, IPRE — this field already exists on `workflow_templates`, shipped in the original payment-mode plan) AND the customer's stuck task is `Schedule Your Onboarding Call` (implying `Capture Payment Method` already completed, since it gates the call-booking task via `task_dependencies`). These rows get a visual highlight inside Track 3's digest table — reusing the red-tint convention already in `scripts/funnel-audit.ts` (`background:#fff5f5;color:#a00` for stuck rows) — not a separate email or a separate code path.

---

## Where the code lives

- **New file:** `src/lib/automations/dropoff-reminders.ts` — the actual detection + send logic for Tracks 1, 2, 5. Config (day thresholds, escalation targets) as a small in-code object, not a DB table, per Decision 2.
- **Wired into `/api/cron/daily-checks`:** new first step, ahead of the existing internal digest (per 2026-08-04 discussion — customer/team-facing sends should fire before the internal report, not mixed into it).
- **New section in `/api/cron/weekly`:** Track 3 + 4 (B2B digest with hot-case highlighting). Needs a rendering piece (new digest section, following `daily-digest.tsx`'s existing multi-section pattern) and a query (B2B customers with a stalled Active client task, joined to workflow payment mode).
- **No new cron entries.** Confirmed via Vercel's current docs (Hobby allows up to 100 cron jobs/project, the only real restriction is ≤1x/day per job) that job-count was never actually the constraint — but bundling into the two existing crons is still the right call: it matches the daily/weekly cadences these need anyway, and keeps one audit surface instead of proliferating cron routes. (Note: `weekly/route.ts`'s comment claiming "Hobby caps the number of active cron jobs" is stale and should be corrected while touching this file.)

---

## Required fix (not optional): reactivation must clear `lastReminderAt`

Found while tracing the design-revision loop: when a customer requests changes, `Review & Approve Your Brand Kit` is **reactivated on the same task row** (`activatedAt` reset to now — see `activate-dependents.ts` and `design-approval.ts`), not recreated as a new row. `lastReminderAt` is not cleared on reactivation.

Without a fix, round 2's reminder timer is corrupted by round 1's leftover `lastReminderAt` — e.g., round 1 sent its day-8 reminder, round 2 reactivates immediately after, and the stale `lastReminderAt` (8 days old relative to nothing) could cause round 2 to skip straight to a later tier or misfire the escalation on day 1.

**Fix:** every reactivation code path (there are at least two in `activate-dependents.ts`, plus the revision-cascade path in `design-approval.ts`) must set `lastReminderAt: null` in the same update that sets `activatedAt: new Date()`. Worth centralizing into one helper so a future third reactivation path doesn't miss it.

This also means Track 2/5 escalation naturally resets per round — since escalation piggybacks on "day-8 tier just became due" (see Decision 2's dedupe logic), and `lastReminderAt` resets to null on reactivation, a customer who got escalated in round 1 can get escalated again in round 2 without any extra state needed.

---

## Edge cases / misfire protections

1. **Race with the customer/team member acting same-day.** Re-read the task immediately before sending; skip if `status != 'Active'` anymore.
2. **Double-send on cron re-run same day** (redeploy, retry). Covered by the tier-vs-`lastReminderAt` comparison in Decision 2 — idempotent by construction, no separate guard needed.
3. **Backfill / test customers.** Excluded via the same `createdVia = 'backfill'` and `environment @> '{test}'` checks the existing trigger emails use.
4. **No email on file** (customer or team member). Skip + log, same as today's pattern in `triggerCustomerEmail`.
5. **Team task with no assignee.** Skip Track 5's day-2/5/8 nudge (nobody to send it to); does NOT suppress the day-8 escalation, which goes to the fixed ops trio regardless of whether there was ever an assignee to nudge.
6. **Reactivated tasks.** Covered above — `lastReminderAt` must be nulled on every reactivation path.

---

## Open questions for architect review

1. **Escalation dedupe via `lastReminderAt` alone** (Decision 2's tier-comparison logic, no new counter/flag field) — sanity-check this is actually sufficient given `payment-mode-dropoff-review.md`'s original ruling favored minimal state. Is there a hole in "escalate exactly once when tier 3 first becomes due" that a dedicated `escalatedAt` timestamp would close and this doesn't?
2. **Bundling Track 3/4 into the existing `weekly` cron** — that route already chains `importRejigSnapshot` → `runAllActiveSyncs` → BI dispatch (`maxDuration: 300`). Does adding a B2B-digest query + email risk timeout or ordering conflicts, or is it clean to append?
3. **Centralizing the reactivation fix** — is a shared helper (e.g. `reactivateTask(taskId, { clearReminderState: true })`) the right shape, or should each of the ~3 call sites just add the field inline?
4. Anything in the five-track split (customer reminders / D2C real-time escalation / B2B weekly digest / B2B hot-case highlight / team reminders+escalation) that reads as over-engineered for a v1, per the project's general bias toward cutting speculative branches until data justifies them?
