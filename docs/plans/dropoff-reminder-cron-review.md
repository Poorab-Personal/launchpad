# Review — Pre-Launch Drop-off Reminder Cron

**Status:** Architect review of `docs/plans/dropoff-reminder-cron.md`.

**Reviewer:** Architect (read-only review pass)
**Reviewing:** `/Users/poorabshah/dev/rejig-ai/launchdeck/docs/plans/dropoff-reminder-cron.md`
**Date:** 2026-08-05

Verdict legend: **OK ship as-is** / **CHANGE X** / **SCRAP and rethink**.

---

## 1. State-based detection, not a hardcoded task list

**Verdict: CHANGE — the design is right, but it's not uniformly safe across every Team task. Carve out an explicit exception for vendor-processing tasks.**

The core call is correct and matches the project's own rule ("new workflow = new `workflow_templates` rows, no hardcoded task-name branching"). I pulled every workflow's live template rows to stress-test it:

```
D2C-Standard, B2B-Keyes, B2B-IPRE, B2B-BW, B2B-RUHL — all Client tasks (Confirm Your
Information, Capture Payment Method, Schedule Your Onboarding Call, Review & Approve
Your Brand Kit, Watch Setup Video, Sign In & Reset Password) are genuinely "customer
needs to act" states. Active really does mean "customer is behind" for every one of
these. Decision 1's claim holds for Track 1.
```

It does **not** hold uniformly for Track 5 (Team tasks). Two rows in the live templates break the "Active on a Team task = someone is behind" assumption:

- `Addon-Voice` → **Create Voice Clone in ElevenLabs** (`assignedRole: Account Creator`)
- `Addon-Avatar` → **Create Voice Clone in ElevenLabs** / **Create Avatar in HeyGen**

These are kick-off-then-wait tasks: the assignee starts a vendor job (ElevenLabs voice clone render, HeyGen avatar render) and then the task legitimately sits `Active` for as long as the vendor takes — which is not sub-24h. Day-2/5/8 nudges to the assignee are harmless noise, but the **day-8 escalation to `success@/poorab@/matt@rejig.ai`** ("hey, this task has been stuck for a week") is a false alarm every single time an add-on customer books Voice or Avatar, unless the vendor happens to be unusually fast. `Review Designs` (senior-designer gate, `hasTeamReview: true`, present in every B2B workflow) is a softer version of the same issue — legitimately multi-day during a busy week, not necessarily neglect.

This isn't a reason to reintroduce a task-name allowlist for Track 1 (customer side is clean). It is a reason to add one narrow, documented exception list for Track 5's *escalation* tier only — e.g. tasks whose `instructions` field indicates external-vendor wait, or simpler: just exclude the two Addon-Voice/Addon-Avatar vendor-kickoff tasks by name from the day-8 escalation (keep the day-2/5/8 assignee nudge, since "did you remember to kick this off" is still a valid nudge — just don't escalate to the ops trio for a vendor's SLA). A 2-3-entry exclusion list for escalation only is proportionate; don't let this become an argument for going back to a full allowlist.

---

## 2. Schedule: day 2/5/8, `lastReminderAt`-only dedupe

**Verdict: CHANGE — the tier-vs-timestamp math is fine in isolation, but it silently depends on `activatedAt` being trustworthy, and Section "Required fix" (which is supposed to guarantee that) targets the wrong code. See Section 5 below — this is the most important finding in this review.**

Setting that dependency aside for a moment: is there a hole in "escalate exactly once when tier 3 first becomes due," assuming `activatedAt`/`lastReminderAt` behave as the plan expects? I tried to construct one and couldn't find a double-send or skip in the pure timer logic — the tier bucketing is monotonic and self-referential (both "tier due" and "tier implied by last send" are computed off the same `activatedAt` anchor), so a missed cron run (Vercel outage, redeploy) just catches up to the highest currently-due tier on the next run, and a same-day re-run is a no-op because the tier doesn't change within a day. That part of Decision 2 is sound *as a piece of arithmetic*.

Where it actually breaks is covered in Section 5.

---

## 3. Customer + team reminders (Tracks 1 and 5)

**Verdict: CHANGE — the "same guards `triggerCustomerEmail` already uses" claim is inaccurate. Fix the citation, and decide the `environment @> '{test}'` guard deliberately rather than by reference to code that doesn't have it.**

I read `src/lib/automations/trigger-email.ts` end to end. It checks exactly two things: `createdVia === 'backfill'` and a missing `contactEmail`. There is **no `environment @> '{test}'` check anywhere in `trigger-email.ts` or `notify-assignee.ts`** — that filter only exists in ad-hoc scripts (`funnel-audit.ts`, `daily-checks.ts`'s cutoff-date approach, `cleanup-test-customers.ts`, etc.), never in the live automation trigger path. So when the plan says Track 1's skip list is "same guards `triggerCustomerEmail` already uses," that's not true for the test-environment piece — it's new logic the cron has to add on its own, which is fine, just say so. Small thing, but worth fixing before someone goes looking for a shared helper that doesn't exist and either skips the guard or reinvents it inconsistently with the scripts convention.

Track 5's team-reminder design (assignee nudge on 2/5/8, escalate to ops trio at day 8 regardless of whether there was ever an assignee to nudge) is reasonable and matches `notify-assignee.ts`'s existing pattern, modulo the Section 1 exception.

---

## 4. Escalation split by segment (Tracks 2, 3, 4)

**Verdict: OK ship as-is, with one addition — see Section 6 on the failure-mode between Track 1/2/5 stamping.**

Not writing to `atRisk`/`atRiskReason` is the right call and consistent with the original architect ruling (`payment-mode-dropoff-review.md` §4/§7/§8: don't add automated writers to fields nothing reads yet). D2C real-time vs. B2B weekly-digest is a defensible split given the fan-out argument (many D2C reps vs. one small internal team). Track 4's "no separate trigger, just a highlight inside Track 3's table" is correctly minimal, and the dependency chain it leans on (`setup-intent-at-intake` gates `Capture Payment Method` before `Schedule Your Onboarding Call` via `task_dependencies`) is real — confirmed in the live `B2B-Keyes` template dump.

The red-tint reuse claim checks out exactly as described: `scripts/funnel-audit.ts:675` — `` `${td}background:#fff5f5;color:#a00;` `` — is the literal convention to lift.

---

## 5. "Required fix": reactivation must clear `lastReminderAt`

**Verdict: SCRAP the fix as written and rethink it. The plan's own claim ("the code reactivates the SAME task row for design-revision rounds — see `activate-dependents.ts` and `design-approval.ts`") is false. The actual bug lives in a third file the plan never mentions, and it's worse than what the plan describes.**

Traced every `status: 'Active'` write in the codebase. Here's what actually happens:

**`design-approval.ts`'s `handleDesignChangesRequested` never touches "Review & Approve Your Brand Kit"'s status at all.** It creates three brand-new task rows (`Revise Design (Round N)`, `Review Revision (Round N)`, `Upload Revised Proof (Round N)`) and wires `task_dependencies` between *those*, but never references the customer-facing review task. Confirmed independently by a comment in `src/app/api/workspace/design-proof/route.ts:212-214`: "Revision-round upload → trigger design-ready email (initial round 0 is fired by the activation event for 'Review & Approve Your Brand Kit'; for round 1+ **that task is already Active**, so we fire here)." That comment only makes sense if the task never leaves `Active` across rounds — it stays continuously Active from round 0 through however many revision rounds happen, transitioning only once more, to `Completed`, when the customer finally approves.

**`activate-dependents.ts`'s two `activatedAt: new Date()` sites (lines 143, 458) are not "reactivation."** Both are guarded by `WHERE status = 'Draft'` — they're the generic once-per-task Draft→Active dependent-activation cascade that runs the first time a task's dependencies clear. Since the customer-facing review task never returns to `Draft`, this code path cannot fire for it a second time. There is no reactivation here to fix.

**The one genuine same-row reactivation in the entire codebase is `reactivateReviewDesigns()` in `src/app/workspace/customers/[id]/actions.ts:71-79`** — a file the plan doesn't cite anywhere:

```ts
async function reactivateReviewDesigns(customerId: string) {
  const tasks = await getTasksForCustomer(customerId);
  const reviewTask = tasks.find((t) => t.taskName === 'Review Designs');
  if (!reviewTask) return;
  await updateTaskFields(reviewTask.id, {
    status: 'Active',
    activatedAt: new Date(),
  });
}
```

This fires from `markTaskComplete` when a `Revise Design (Internal Round N)` task completes, re-activating the **internal** senior-designer `Review Designs` task (parked to `Draft` by `design-review-reject/route.ts` when the senior rejects a junior's work). This *is* exactly the bug pattern described — `activatedAt` resets, `lastReminderAt` doesn't — but it's on a Team-only task in a workspace server action, not on the customer-facing task the plan's narrative and "Required fix" section are built around.

**Consequence:** fixing "every reactivation code path... at least two in `activate-dependents.ts`, plus the revision-cascade path in `design-approval.ts`" as literally proposed would (a) touch two sites that don't need it (they're not reactivation), (b) miss the one site that does (`actions.ts`), and (c) leave the actual, more consequential bug on "Review & Approve Your Brand Kit" completely unaddressed — because that task's problem isn't a missed reset-on-reactivation, it's that **`activatedAt` is frozen at round-0's timestamp for the task's entire multi-round lifetime.**

That second bug is worse than what the plan describes, and it's silent in the opposite direction from what the plan worries about. Concrete scenario: a D2C customer takes 9 days to first respond to their brand kit (tier 3 fires, day-8 reminder sent, Track 2 escalates to their sales rep, `lastReminderAt` stamped). They then request changes three separate times over the following three weeks — round 2 takes 12 days, round 3 takes 6 days. Because `activatedAt` never moves off round 0's timestamp, every cron run for the rest of that customer's design-approval lifecycle computes `daysSinceActivation` as ever-increasing and permanently ≥ 8, i.e. "tier 3 is due" forever — but `lastReminderAt`'s implied tier is also permanently 3 (it was set once, back on day 9). `3 is not > 3`, so the tier-comparison dedupe correctly suppresses a resend — except this suppression is now *wrong*: rounds 2 and 3's genuinely fresh 12-day and 6-day stalls never generate a single reminder or a single escalation, ever, because the task's clock stopped advancing in any way the dedupe logic can detect.

**Fix should be:** add explicit `activatedAt: new Date(), lastReminderAt: null` resets directly inside `handleDesignChangesRequested` (the actual point where a new round begins for the customer-facing task), *and* separately fix `reactivateReviewDesigns()` in `actions.ts` to clear `lastReminderAt` in the same update (that one genuinely is a reactivation and genuinely is missing the clear). These are two different fixes in two different files for two different tasks, not one shared helper across three call sites as the plan assumes. Recommend re-auditing with `grep -rn "status: 'Active'"` (six real hits, three are inserts/first-activations, three are the ones discussed above) before finalizing, rather than reusing the general phrase "reactivation" for two unrelated situations.

---

## 6. Ordering between Track 1 (final reminder) and Track 2/5 (escalation) on the same day-8 pass

**Verdict: CHANGE — the plan doesn't specify write ordering, and the natural implementation (single `lastReminderAt` stamp covering both "reminder sent" and "escalation sent") has a silent-loss failure mode.**

`lastReminderAt` is being asked to do double duty: it's both "when did we last nudge the customer/assignee" and (implicitly, via the tier-3 check) "have we escalated yet." If the day-8 cron pass sends the Track 1 customer reminder successfully, then attempts the Track 2 D2C escalation and that send fails (Resend hiccup, `salesRepEmail` null, network blip) — what happens to `lastReminderAt`?

- If the code stamps `lastReminderAt = now()` once, after attempting both sends (success or fail), the next day's run sees tier 3 already "sent" and never retries the escalation. The sales rep silently never finds out. There's no separate `escalatedAt` to fall back on, and Track 2 has no other trigger — it's the same-pass side effect of the tier crossing, one-shot.
- If instead the stamp only reflects the customer reminder (Track 1) and Track 2/5 use their own success/failure signal, that's a second implicit state variable the plan's "just reuse `lastReminderAt`, no new field" framing explicitly tries to avoid — undermining the minimal-state argument the plan leans on.

This is not a transaction/deadlock concern (there's no transaction here — these are independent best-effort email sends against a single Postgres row, matching the existing best-effort pattern in `trigger-email.ts`/`notify-assignee.ts`). It's a **partial-failure/idempotency** concern specific to conflating "reminder tier" and "escalation fired" into one timestamp. Given escalation is explicitly meant to be the important, once-per-episode signal (not a routine nudge), it deserves its own dedicated boolean/timestamp guard, decoupled from the reminder-tier arithmetic. This directly answers Open Question 1: yes, there is a hole a dedicated field would close — just not the one the plan originally worried about (double-escalation); it's silent single-escalation loss on partial send failure.

---

## 7. Bundling Track 3/4 into the existing `weekly` cron

**Verdict: CHANGE — architecturally the bundling instinct is right (matches cadence, one audit surface), but the plan understates the actual headroom risk given what's already in that route.**

`src/app/api/cron/weekly/route.ts` already: (1) awaits `importRejigSnapshot()`, (2) awaits `runAllActiveSyncs()`, (3) inside `after()`, **awaits a full BI chunk-0 fetch** — and the route's own comment explains this was changed from fire-and-forget specifically because the un-awaited version reliably failed (cold BI route, Vercel killed the parent before the TLS handshake completed). The comment estimates that awaited BI chunk-0 call alone takes ~150s. `maxDuration` is already set to 300s. Stacking a new B2B-digest query + email generation + send as a fourth synchronous step (or worse, inside the same `after()` block ahead of or behind the BI fetch) leaves uncomfortably little margin, especially since `importRejigSnapshot`/`runAllActiveSyncs` durations aren't bounded in the code shown.

The repo already runs *two* cron routes (`weekly` and `daily-checks` — confirmed in `vercel.json`), which directly contradicts `weekly/route.ts`'s own comment ("the SINGLE Vercel cron entry on the Hobby plan"). That comment was already stale before this plan, independent of the Vercel-docs question the earlier session resolved — worth fixing regardless of whether a third digest email gets added inside it. Recommend either (a) chain Track 3/4 the same way BI is chained — its own route, dispatched via `after()` fetch from `weekly`, so a slow digest doesn't block/extend the parent's wall-clock budget, or (b) measure actual current `importRejigSnapshot` + `runAllActiveSyncs` + BI-chunk-0 duration in production logs before deciding it's safe to inline.

---

## 8. Open questions — direct verdicts

**Q1: Is `lastReminderAt`-alone dedupe sufficient, or does a hole exist a dedicated `escalatedAt` would close?**

**Yes, there's a hole — two, in fact.** (a) Per Section 5: the dedupe logic is only as good as `activatedAt`'s integrity, and `activatedAt` is not reliably reset across design-revision rounds today — fixing that is a prerequisite, not optional. (b) Per Section 6: conflating "last reminder tier sent" and "escalation fired" into one field creates a silent-loss failure mode on partial send failure that a dedicated `escalatedAt` (set only on confirmed escalation send, independent of the reminder-tier stamp) would close. Recommend a minimal addition: keep `lastReminderAt` for the tier arithmetic, add one nullable `tasks.escalatedAt` for the one-shot escalation signal. That's still "minimal state," just not zero-state — the original ruling's "cut `Reminder Count`" logic doesn't extend to "cut every field," and this one earns its keep because two genuinely different events (routine nudge vs. one-time escalation) are being asked to share a single timestamp.

**Q2: Does bundling Track 3/4 into `weekly` risk timeout/ordering conflicts, or is it clean to append?**

**Real risk, not clean to just append** — see Section 7. The existing route is already close to its `maxDuration` ceiling by its own comments. Chain it the same way BI is chained (own route + `after()` dispatch) rather than inlining.

**Q3: Is a shared `reactivateTask(taskId, { clearReminderState: true })` helper the right shape, or should each call site add the field inline?**

**A shared helper is right in principle, but only once you've correctly identified all the call sites** — which, per Section 5, the plan currently hasn't. There are exactly two places that need this: `reactivateReviewDesigns()` in `actions.ts` (a true reactivation) and the new-round entry point in `handleDesignChangesRequested` (which isn't a reactivation of an existing row today, but needs the equivalent behavior — reset the still-Active review task's timer when a new round starts). A shared helper is worth it for two call sites if a third is plausible later (any future "internal review gets rejected and looped" pattern), but don't build it speculatively beyond what these two actually need.

**Q4: Does the five-track split read as over-engineered for v1?**

**No — this is the one part of the plan that's appropriately scoped**, and cutting further would likely reintroduce the exact problem the predecessor plan got flagged for (Track 4 in particular is a *derived highlight*, not a new code path — it's the cheapest possible version of "surface the hot case," reusing an existing visual convention). The five tracks collapse to two real code surfaces (`dropoff-reminders.ts` for 1/2/5, a digest query+render addition for 3/4) and no new tables, no new enum values, no new cron entries. If anything is over-scoped it's the false confidence in the "required fix" (Section 5) and the implicit two-jobs-in-one-timestamp design (Section 6) — both correctness gaps, not scope-creep.

---

## Top 3 changes I'd make

1. **Rewrite the "Required fix" section from scratch based on actual code.** The cited bug (reactivation-without-clearing-`lastReminderAt` in `activate-dependents.ts`/`design-approval.ts`) doesn't exist where claimed. The real bugs are: (a) `reactivateReviewDesigns()` in `src/app/workspace/customers/[id]/actions.ts` — a genuine reactivation missing the `lastReminderAt` clear; (b) "Review & Approve Your Brand Kit" never reactivates at all across revision rounds, so its `activatedAt` is frozen at round-0's value forever, which — combined with the tier-dedupe logic — means any stall in round 2+ silently gets zero reminders and zero escalations once tier 3 has fired once. Fix both, in their actual locations. (Section 5.)

2. **Give escalation its own one-shot signal, separate from the reminder-tier timestamp.** A single `lastReminderAt` can't safely represent both "which reminder tier was last sent" and "was the one-time escalation fired" — a partial send failure (Track 1 succeeds, Track 2/5 escalation fails) silently and permanently suppresses the escalation retry. Add a nullable `tasks.escalatedAt`, set only on confirmed escalation send. This also directly answers Open Question 1. (Section 6.)

3. **Exclude vendor-kickoff Team tasks from the day-8 escalation tier (not from reminders).** `Create Voice Clone in ElevenLabs` / `Create Avatar in HeyGen` (Addon-Voice/Addon-Avatar) are legitimately multi-day by design — escalating "this has been stuck a week" to the ops trio every time a Voice/Avatar add-on is purchased is a guaranteed false alarm, not a hardcoded-list regression (the customer-facing state-based design should stay intact; this is a two-line named exception on the escalation branch only). (Section 1.)

### Critical Files for Implementation

- `src/app/workspace/customers/[id]/actions.ts`
- `src/lib/automations/design-approval.ts`
- `src/lib/automations/activate-dependents.ts`
- `src/app/api/cron/weekly/route.ts`
- `src/db/schema/tasks.ts`
