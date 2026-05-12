# Review — Payment Mode Config + Drop-off Handling

**Status:** Historical — architect review of the v1 payment-mode plan. Decisions captured here were folded into the v2 plan and are now reflected in shipped code. Retained for traceability.

**Reviewer:** Architect (read-only review pass)
**Reviewing:** `/Users/poorabshah/dev/rejig-ai/launchdeck/docs/plans/payment-mode-dropoff.md`
**Date:** 2026-05-06

Verdict legend: **OK ship as-is** / **CHANGE X** / **SCRAP and rethink**.

---

## 1. `D2C-Prepaid` synthetic Brokerage

**Verdict: CHANGE — drop the synthetic brokerage. Put `paymentMode` on `Workflow Templates`, not on `Brokerages`.**

The plan's framing is "we need one branching point in code." That's true — but you don't need a Brokerage row to get there. You need *one place to look up payment mode*. That place should be the workflow, not the brokerage.

Three reasons:

1. **D2C is not a brokerage.** Calling a synthetic Brokerage `D2C-Prepaid` is exactly the polymorphic-Subscriptions move from last time — inventing a parent record so two unrelated concepts can share a column. The cost is real: a migration, a formula change (Open Question 5), backfilling 500 customers, and a new "what does Brokerage mean now?" question for everyone reading the schema. The Brokerages table currently means "a real estate brokerage we have a deal with." Adding a fake row breaks that invariant for one config field.

2. **`paymentMode` is workflow-shaped, not brokerage-shaped.** Today: every B2B-Keyes customer is `setup-intent-at-intake`. Every D2C-Standard customer is `pre-paid`. Every B2B-BW customer is `invoice`. The mode is 1:1 with the workflow key, not the brokerage. Tomorrow's `D2C-Trial` is also a new workflow key. Putting `Payment Mode` (+ `Stripe Price ID`, `Trial Days`) on `Workflow Templates` (header-level — i.e. one row per Workflow Key, or denormalized onto every template row) means D2C just works without any synthetic parent. B2B brokerages already have a `Default Workflow Key` linking them to their workflow.

3. **Open Question 5 is a tell.** The plan recommends rewriting the Workflow Key formula to read from Brokerage, breaking a stable convention so the new field has somewhere to live. When a plan needs a formula change to make a new field reachable, the field is in the wrong table.

What stays: `paymentMode` as a four-value enum is fine. `Stripe Price ID` and `Trial Days` as siblings of it are fine. The B&W `invoice` row and the `none` value are fine. Just don't anchor them on Brokerage.

What dies: synthetic D2C-Prepaid row, the customer backfill, the formula change, half of Phase 4.

(Counter-case to keep in mind: if Poorab actually wants per-brokerage Stripe pricing for the same workflow — Keyes pays $X, IP pays $Y, both on B2B-Keyes-style flow — then `Stripe Price ID` *does* belong on Brokerage. In that world: keep `Payment Mode` on Workflow Templates, keep `Stripe Price ID` + `Trial Days` on Brokerage, and accept that D2C reads price from a different field, e.g. existing `Product Tier`. Either way, no synthetic row.)

---

## 2. Dependency-graph approach to gating

**Verdict: OK ship as-is.**

`Depends On = "Capture Payment Method"` is exactly the right primitive. The Depends On field is *already* the system's "this can't happen yet because of that" channel. Auto 2 already activates downstream tasks the instant their predecessors complete. Everything Stripe-related becomes a normal node in an existing graph.

The "overloading" worry doesn't apply. Depends On doesn't carry payment semantics — the *Capture Payment Method task* does. Depends On still just means "wait for this." The webhook completes the task; Auto 2 doesn't need to know why.

The real elegance: B&W (`paymentMode = invoice`) doesn't get the task generated, so the Depends On line is silently inert. Keyes today doesn't have design tasks, so the gating is also inert there. The day someone wires up IP with both a card capture and a brand kit, the dependency edge already exists in the template — no code change needed. That's reuse paying rent.

One minor tightening: be explicit in the plan that the Depends On reference is by *task name string*, matching CLAUDE.md's existing convention. Don't be tempted to make it a linked-record ID for the Stripe task "to be safe" — the architecture decision against linked-record dependencies is intentional (race conditions).

---

## 3. Reminder cron design

**Verdict: CHANGE — build the cron in Next.js (don't extend Auto 8), but simplify the storage (single `Last Reminder At` field on Tasks, drop `Reminder Count`).**

Two sub-decisions to separate:

**(a) Where the cron lives.** Auto 8 is documented in `production-schema.md` but the actual scripts directory only has `auto1` through `auto4` plus the in-review intercept. So Auto 8 isn't a thing you'd be "extending" — it's a stub. Building the new cron in Next.js (Vercel Cron → API route) is cleaner than adding a 6-hour Airtable scheduled automation, because:
- Email sending will use a Next.js-side SDK anyway (Resend, Postmark, whatever) — Airtable scripting can't send those.
- The cron has to read tasks, hit Stripe IDs eventually for clearing logic, and call your own routes. All of that is JS-native.
- Airtable scheduled triggers have a 5-minute floor and limited debug; Vercel cron logs are first-class.

So: yes, build the new `/api/cron/dropoff-reminders` route. Quietly delete or supersede the `Auto 8` reference in `production-schema.md` so future-you doesn't think it's live.

**(b) The data shape.** `Tasks.Reminder Count` (number) plus `Tasks.Last Reminder At` (date) plus per-task-name threshold arrays in code is more state than you need. Two simpler options:

- **Option A (recommended): just `Last Reminder At`.** Compute reminder number on the fly: `reminderNumber = floor((now - activatedAt) / interval)`. If `reminderNumber >= 3` and customer isn't yet at-risk, flip atRisk and skip. The cron is idempotent (runs once a day, won't double-send because `Last Reminder At` advances).
- **Option B: keep `Reminder Count`, drop the per-task thresholds.** One global "remind every 3 days, max 3" rule. The b2b-keyes.md doc lists per-task remind-after values that vary 2-5 days — but honestly, for a daily cron with thresholds in code that the team can tune, the variance isn't worth a schema field per task type. Pick a reasonable default; tune it once you have data.

Either way, do NOT add `Workflow Templates.Reminder Schedule` (Open Question 2's alternative). That's pre-emptive flexibility for a customization request that hasn't happened.

The Open Question 4 collision (existing `Customers.Reminder Count`) — just delete that field as part of Phase 0. The plan already recommends this; commit to it.

---

## 4. `atRisk` shape: single-select with 5+ stall reasons

**Verdict: CHANGE — make it two fields. Boolean `At Risk` + reason string. Don't make it a separate table.**

The single-select conflates two things: "is this customer at risk" (a flag the kanban filters on) and "why" (a label for the badge). That's fine for v1 if you only ever have one reason per customer at a time, but the proposed enum already mixes severities (`Stalled - X` is automatic, `At Risk - CSM Flagged` is manual, `Churned` is terminal). When you want to filter "show me everyone the cron flagged but the CSM hasn't touched yet," a single-select on a mashed-together value type fights you.

Cleanest minimal change:

- `At Risk` — checkbox (set/cleared by cron, CSM, or webhooks).
- `At Risk Reason` — single-select: `No CC`, `No Booking`, `No Approval`, `No Form`, `CSM Flagged`. Cleared when At Risk goes false.
- `Lifecycle Status` (or repurpose `Current Stage`'s "Done"/"Churned" handling) — for the terminal `Churned` bucket. Churned is not at-risk, it's already gone.

A separate `At Risk Reasons` linked table is overkill — you have one active reason at a time per customer (whichever the cron noticed first). A multi-select is also overkill for the same reason; reasons don't stack in practice (if they didn't capture a card, they also didn't book — but only one of those drives the action).

Two fields beats one because the kanban query becomes `At Risk = true AND Lifecycle Status != Churned`, which is the exact filter the plan wants in section 7. With the single-select, that filter is `atRisk NOT IN ("none", "Churned")`, which is the kind of negative-set query that's annoying in Airtable view formulas and easy to break when you add a value.

---

## 5. Sub creation on `Mark Onboarding Call Complete`

**Verdict: CHANGE — trigger off the Calls table, not off the Mark Onboarding Call Complete task. And add a safety net.**

The existing Calls table (production-schema.md, Table 8) is the better trigger source. Calendly already upserts into it idempotently with status `Completed` / `No Show` / `Rescheduled` / `Canceled`. Auto-creating the sub when `Calls.Status = Completed` AND `Calls.Type = Onboarding` AND no `Customer.Stripe Subscription ID` exists yet means:

- **Reschedules don't false-fire.** A rescheduled call has a new Calls row (or the existing one moves to `Rescheduled`), neither of which trips the trigger.
- **No-shows don't false-fire.** Status is explicitly `No Show`.
- **CSM forgetting to mark the task is no longer fatal.** The CSM marking the call "Completed" in the Calls table (which also unlocks downstream stages) is the same action that creates the sub. One human action, not two.
- **Idempotency is free** because of the `no Stripe Subscription ID yet` guard.

Failure modes if you keep the plan's design:
1. CSM does the call, forgets to mark the task. Customer is on a free trial that never converts. No safety net catches this.
2. Call is rescheduled by checking off the task (some CSMs will do this even though it's wrong), then a new call is booked. Sub is created against the *first* call's date.
3. Manual "complete" of the task by anyone with workspace access creates a real Stripe charge. No second confirmation.

Safety net regardless of trigger source: a weekly audit query (could be a CSM workspace badge) — "customers in Stage 4+ with paymentMode = setup-intent-at-intake and no Stripe Subscription ID." Catches every gap above.

Open Question 3's "trial covers no-show and reschedule naturally" reasoning is true *only if* the trial length always exceeds the worst-case reschedule chain. It's brittle. Trigger off the Call, not the Task.

---

## 6. Phase ordering

**Verdict: CHANGE — kill the migration entirely (per Q1) or move it to Phase 0.5 if you keep it.**

If you take Q1's recommendation (no synthetic D2C-Prepaid Brokerage), Phase 4 mostly evaporates. Existing customers don't need re-parenting. The remaining "migration" is just backfilling `paymentMode` on workflows (one-time setup) and `Stripe Subscription ID` on existing customers (a CSV map, fine to do anytime).

If you keep the synthetic-brokerage idea against my advice in Q1, then yes — Phase 4 (migration) absolutely belongs *immediately after Phase 0*, not at the end. The plan's Phase 1 already calls for the new `Capture Payment Method` task referencing `Brokerages.priceId`. Phase 2 reads `Customer.Brokerage` to find the CSM. Phase 3 acts on `atRisk` which the cron sets per customer-with-a-Brokerage. Every phase between 1 and 3 quietly assumes "every customer has a Brokerage parent."

Three weeks of new code piled on top of half-migrated data is exactly how the production-vs-dev drift happens. If the migration is genuinely one day of work, do it second, not last.

The "lowest risk → goes last" framing is also wrong here. Migrations get *riskier* the longer they wait, because new code keeps adding read-paths that assume the new shape.

---

## 7. Things missing

**Verdict: CHANGE — add four items to the plan.**

The plan does not currently address:

1. **Stripe Customer creation timing.** When does `Customer.Stripe Customer ID` first get populated? The plan says "lazily on first Stripe interaction" in the field description, but doesn't pick a moment. The right moment is **at customer creation** for `setup-intent-at-intake` customers (so the SetupIntent route never has to create-or-fetch). Do it in the same code path that generates the customer record. For `pre-paid` D2C customers, the Stripe Customer is already created upstream (HubSpot/Stripe path) and arrives via `Stripe Payment ID` — backfill from sub on first need. For `invoice` and `none`, never.

2. **Webhook idempotency.** `setup_intent.succeeded` can fire more than once (Stripe retries on 5xx, on dashboard re-sends, on test replays). The plan says "marks task Completed" — fine, but make it explicit that the webhook is a no-op if the task is already Completed. Same for the eventual subscription-creation path: guard on `Customer.Stripe Subscription ID` being empty before creating.

3. **B&W's `invoice` mode is purely informational today.** The plan defines `paymentMode = invoice` and `Brokerages.billingStatus`, but describes zero behavior driven by them. No reminder, no task, no gating. That's fine — but say so explicitly in the plan and don't add the `Billing Status` field until something actually reads it. (Right now nothing does. It's "scaffolding for an imagined future CSM dashboard." Cut it. Add it the day you build a feature that reads it.)

4. **Race between webhook completing the task and the cron sending a 3rd reminder.** Cron runs at 14:00 UTC daily; if the SetupIntent succeeds at 13:59, the cron may see "Active task, threshold exceeded" and send a stale reminder before the webhook lands. Mitigation: in the cron, re-read the task right before sending, and skip if Status changed. Cheap, prevents the "you didn't add a card!" email arriving 30 seconds after they added the card.

Also worth a sentence in the plan: **what does the customer portal show when their only Active task is `Capture Payment Method`?** Does the existing `EmbedTask` renderer handle a Stripe-Elements-bearing iframe at `/r/{token}/payment-setup`, or does Open Question 1 (new `Stripe Setup` Attachment Type) actually need to be answered before Phase 1? Recommend: piggyback on Embed for now, write the Stripe Elements page as a normal page the iframe loads. New attachment type only if you need cross-origin trickery you can't get from an iframe.

---

## 8. Over-engineering

**Verdict: CHANGE — three concrete cuts.**

Track-record context noted. Here's what's pulling weight it doesn't earn:

1. **Synthetic `D2C-Prepaid` Brokerage** (covered in Q1). This is the headliner. It's the same shape as the polymorphic-Subscriptions move — inventing a parent so a polymorphic-looking column has somewhere to live. Cut it; put `paymentMode` on `Workflow Templates`.

2. **`Brokerages.Billing Status`** (covered in Q7, item 3). Nothing reads it. Don't add it.

3. **Per-task reminder threshold map in code.** The plan lists three different schedules for four task types (`2,5,9` vs `3,7,12`). That granularity has no evidence behind it — the b2b-keyes.md flow doc has yet-another-set of values (2-5 day windows). Until reminder fatigue is an observed problem, ship one schedule (e.g. `+3d, +7d, +12d`) for everything. Tune from data. The plan's Open Question 2 already correctly resists adding a `Reminder Schedule` field; go further and resist the in-code variation too.

Honorable mentions — smaller things that nudge toward over-engineering but are individually defensible:

- **`Tasks.Reminder Count` AND `Tasks.Last Reminder At`** — pick one (Q3, Option A).
- **`atRisk` as a 7-value single-select** — split into two fields (Q4).
- **Open Question 1's new `Stripe Setup` Attachment Type** — don't. Use Embed (Q7 closer).
- **Open Question 2's templated reminder schedules** — already correctly punted; keep punting.

What the plan gets right and should NOT be cut:
- `Capture Payment Method` as a real task in the workflow (not a side-channel).
- Dependency-driven gating via `Depends On`.
- A single Vercel cron route, daily cadence.
- Webhook-driven task completion.
- A CSM kanban filter for at-risk customers.

---

## Top 3 changes I'd make

1. **Drop the synthetic `D2C-Prepaid` Brokerage.** Put `paymentMode` (+ `Stripe Price ID`, `Trial Days`) on `Workflow Templates` instead of `Brokerages`. Eliminates the migration, the formula change, and the "what does Brokerage mean" semantic drift. (Sections 1, 6, 8.)

2. **Trigger sub creation off the `Calls` table, not the `Mark Onboarding Call Complete` task.** Watch `Calls.Status = Completed` AND `Type = Onboarding` AND `Customer.Stripe Subscription ID` empty. Survives reschedules, no-shows, and CSM forgetfulness for free, with idempotency built in. (Section 5.)

3. **Cut three speculative fields/branches: `Brokerages.Billing Status`, the per-task reminder threshold map, and the dual `Reminder Count`+`Last Reminder At` storage.** Replace with: nothing, one global `+3/+7/+12d` schedule, and just `Last Reminder At` (compute the rest). (Sections 3, 4, 8.)
