# Ruhl: pilot → launch, and the Self-Post / Done-For-You fork

**Date:** 2026-10-15, revised 2026-10-16 after architect review
**Status:** ✅ **SHIPPED 2026-10-18.** Live on `main` (commits `a369df7`,
`7dbd8f6`, `068e313`, `c91365b`). Kept for the rationale and the review trail;
the flow as built is documented in [`docs/flows/b2b-ruhl.md`](../flows/b2b-ruhl.md),
which is the doc to trust if the two disagree.

Two things changed during the build and are **not** reflected in the plan body below:

1. **The booking task closes at intake submission, not at Send Credentials.**
   The plan's timing would have shown a brokerage-managed agent an onboarding
   step for days. Caught in testing on 2026-10-18.
2. **The terminal client tasks (`Watch Setup Video`, `Sign In & Reset Password`)
   are also auto-closed** for brokerage-managed agents, carrying them to
   `Launched`. The plan left them open, which would have stranded every
   brokerage-managed agent at `Prepare for Onboarding` — the same stranding the
   pilot cohort had to be rescued from manually.

Also note the onboarding meeting link in the plan body is Mario's; it was
replaced brokerage-wide on 2026-10-18 (see below).

_Original status: PLAN — reviewed (`ruhl-service-options-review.md`), decisions settled, ready to build._
**Workflow:** `B2B-RUHL` (brokerage `RuhlHomes`, slug `ruhl`, id `b6e138ee-63b4-400f-9f88-8643ea3e22f9`)
**Driver:** Ruhl has moved off pilot. Submitted agents are real customers, invoiced
to the brokerage at intake-submission date. Ruhl sells two tiers; LaunchPad
cannot currently tell them apart.

## Goal

| Ruhl's name for it | Who runs the account | Onboarding call |
|---|---|---|
| **Self Post — Agent Access** | The agent | Yes — agent books and attends |
| **Done For You Posts & Content** | Ruhl's marketing team | No |

`B2B-RUHL` has 6 tasks and **no onboarding-call task** — a pilot-era shape. Every
other live flow has one.

## Decisions

### D1 — One slug, one workflow key. No clone.

`/ruhl` stays the only landing page; `B2B-RUHL` stays the only workflow key. The
fork is a field on the customer.

Rejected, with reasons:

- **Second `brokerages` row + `/ruhl-managed`.** `brokerage_roster`'s unique key is
  `(brokerage_id, source_user_id)` and `lookupByEmail` is scoped by `brokerage_id`,
  so a twin row forces a second full copy of Ruhl's 330 roster rows and a 6th
  parallel DMG pull inside the 300s Hobby ceiling. It halves the denominator in
  `branch-funnel-report.ts:341` — the report we email the brokerage. A new channel
  code has no entry in `CHANNEL_CODE_TO_HUBSPOT_ENUM` (`intake-handler.ts:48-56`),
  so HubSpot tickets stop being created (`:188-193` returns `{kind:'error'}`).
- **Second workflow key on one brokerage.** Avoids roster duplication but splits
  every report mapping brokerage → single key (`funnel-audit.ts:125-137`,
  `monthly-cohort-digest.ts:210-218`, `branch-funnel-report.ts:392-393`), and
  `getBrokerageByDefaultWorkflowKey` (`db.ts:1266-1273`) returns `null` for the
  second key, nulling `brokerage_id` and breaking the ticket push.
- **Roster column from a list Ruhl maintains.** Nothing populates it today and DMG
  exposes no field meaning "done for you" (checked `Privilege`, `AccountType`,
  `Designation`, `MyPortfolioBranding`, ~50 others).

**Consequence:** one workflow key means no report breaks. That is the point.

### D2 — Reference flow is `B2B-BW`, not `B2B-Coach`.

Structurally identical, but BW is proven (~365 customers through BW+Keyes).
Coach went live 2026-09-18 and is unproven. Copy BW.

### D3 — The person filling the form picks the tier.

Ruhl confirmed in writing: Self Post agents submit their own form; Ruhl staff
submit for Done For You agents. **Credentials go to the agent in both cases** —
Ruhl's marketing team is CC'd, not substituted. `contact_email` stays the agent
throughout.

### D4 — Nothing gates on the booking.

Verified across all live flows; the booking task is a leaf everywhere:

| Flow | Gates account creation | Booking a gate? |
|---|---|---|
| D2C-Standard | Brand kit approval | No |
| B2B-Keyes / B2B-IPRE | Capture Payment Method | No |
| B2B-BW / B2B-Coach / B2B-RUHL | Nothing | No |

Of 104 Keyes+IPRE customers with designs completed, 99 completed designs *after*
booking, 4 before, 1 never booked — emergent timing, not enforcement.

**Decision: add no gate.** Ruhl has agents under contract before we see them.
We do the design and account work and send credentials whether or not they book.

### D5 — The booking task stays in `Getting Started`.

**User decision, 2026-10-16.** Agents are asked to book right after submission,
in parallel with account creation, with reminders chasing them. Credentials
arriving is the real prompt. Review proposed moving it to `Prepare for
Onboarding`; **rejected**.

### D6 — `Send Credentials` advances a stuck customer's stage.

This is what makes D5 safe, and it resolves both review blockers.

**Problem:** stage advancement needs every task in a stage `Completed`
(`activate-dependents.ts:308-315`). An unbooked Self Post agent's booking task
pins them in `Getting Started` forever, while account creation and credentials
proceed on task dependencies. They end up live and billed but reading as
"Getting Started" in every report. One IPRE customer is in this state now.

**Fix:** when `Send Credentials` completes, if `currentStage` is still
`'Getting Started'`, set it to `'Prepare for Onboarding'`.

Why that label is honest: it says preparing *for* onboarding — access granted,
call not yet held. LaunchPad already draws this line. At the Launched terminal
branch the code pushes HubSpot to "Onboarding Scheduled" rather than "Active",
commented: *"the customer has credentials + signed in but the actual onboarding
meeting hasn't happened yet, so 'Active' would be wrong."*

Safe on later booking: completing the stage-1 booking task when `currentStage`
is already `Prepare for Onboarding` hits the `currentStage = completedTaskStage`
guard and no-ops. No backward move.

**It also unblocks step 6.** `advanceToLaunchedFromHsActive` early-returns unless
`currentStage === 'Prepare for Onboarding'` (`advance-to-launched-from-hs.ts:50-52`).
Without D6 an unbooked agent never reaches that stage, so clearing a stale
booking task at launch could never fire (0 rows matched in production). With D6
it works.

**Accepted side effect:** `funnel-audit-labels.ts:53` gives `B2B-RUHL: 'stage'`
(onboarded = past Getting Started), so an agent flips to Onboarded when
credentials go out rather than when they book. Matches the intent — credentials
sent means done from our side. `monthly-cohort-digest` uses `'signed-in'` for
Ruhl and is unaffected.

### D7 — Done For You auto-completes the booking task at intake submission.

Not at credentials — a task left open holds the stage, so a Done For You agent
would read as stalled for days. Completing it when the choice is made keeps
progression identical to a Self Post agent who books immediately.

**Known cost:** `monthly-cohort-digest.ts:66` maps the task to `'Booked'`, so
auto-completed agents are stamped Booked. Filter on `service_option` for any real
booking count.

### D8 — The CC rides on an explicit `cc`, not `other_emails`.

**Review finding B1:** `customers.other_emails` is **write-only**. Nothing in
`src/` reads it for any email, B2B or D2C. The only `cc`/`bcc` sites are
hardcoded internal addresses plus `trigger-email.ts:81` (welcome → salesRepEmail,
with a comment explicitly excluding credentials-sent). Appending
`marketing@ruhlhomes.com` there would CC nobody.

**Review finding B2:** `Send Credentials` is programmatic. The Account Creator
clicks a button; `src/app/api/workspace/send-credentials/route.ts:97` sends via
Resend to `contactEmail` with no `cc`. The UI exposes only a temp-password box.

**Fix:** store the address on the brokerage, resolve it at send time, pass an
explicit `cc`. Do not touch `other_emails`.

## Implementation

Ordered. Each step independently shippable.

### 0. Launch Sara, Bob and Jeramy *(independent — do first)*

They are already live in reality; LaunchPad's records are behind. All three sit
at `currentStage='Prepare for Onboarding'` with `accountCreated=true`, stranded
on `Watch Setup Video` (Jeramy also `Sign In & Reset Password`) — tasks **already
in** `TERMINAL_CLIENT_TASKS`. A one-off `advanceToLaunchedFromHsActive` re-run
launches all three. Not blocked on anything below.

Root cause (standing, Ruhl-specific): `SEND_CREDENTIALS_TICKET_PUSH` has LP push
the ticket to Active itself, and the returning webhook is dropped by LP's own
loop prevention (`webhooks/hubspot/route.ts:290-294`), so the `Active` branch
never fires for Ruhl. See step 8.

### 1. Template — add the booking task

One `workflow_templates` row for `B2B-RUHL`, copied from `B2B-BW`:

```
stage = 'Getting Started', stageOrder = 1, taskOrder = 2
taskTitle = 'Schedule Your Onboarding Call'
taskType = 'Client', dependsOn = 'Confirm Your Information'
initialStatus = 'Draft', visibleToClient = true
```

`Create Designs` shifts taskOrder 2 → 3. Review confirms **nothing keys off
taskOrder** (N2), and existing customers' task rows are unaffected.

**Calendly URL:** `brokerages.default_calendly_url` is NULL for Ruhl.
`generate-tasks.ts:214-217` only overrides `embedUrl` when set. Keyes/BW/IPRE all
use `https://meetings-na2.hubspot.com/poorab/social-media-onboarding`. (The plan originally said `mario-giron/onboarding-meeting-link`; Mario left and the link was repointed brokerage-wide on 2026-10-18.)
Open question 1.

### 2. Switch Ruhl to invoice billing

`payment_mode` `'none'` → `'invoice'` on **all** `B2B-RUHL` template rows (now 7).

Verified safe — nothing branches on it, no Stripe objects created
(`handle-call-completed.ts:79-86` bails unless `setup-intent-at-intake`;
`payment-setup/route.ts:74-78` 400→400; `dropoff-b2b-digest.ts:110` false→false).
Only delta: `intake-handler.ts:226,287` pushes `'invoice'` to the HubSpot Contact
property. Matches BW/Coach.

**All rows in one go** — `dropoff-b2b-digest.ts:88-95` uses `selectDistinct`; a
half-migrated key returns two values.

### 3. Schema — two additive nullable columns

Hand-authored migration (`db:generate` is broken: ALTER `.sql` + `_journal.json`
entry, then `db:migrate`).

```sql
ALTER TABLE customers   ADD COLUMN service_option    text;
ALTER TABLE brokerages  ADD COLUMN managed_cc_email  text;
```

`service_option`: `'self-post'` | `'done-for-you'` | `NULL`.
`managed_cc_email`: `marketing@ruhlhomes.com` for Ruhl only.

Both nullable and additive — no other workflow affected.

### 4. Intake form — the question

`FormTask.tsx`, **Account Access** step (index 3, before Review). Gate on
`customer.workflowKey === 'B2B-RUHL'` (available on the prop type,
`src/types/index.ts:100`).

```
Label:  Selected Service Option
        ( ) Self Post — Agent Access
        ( ) Done For You Posts & Content
```

**No default** (review S6). A pre-selected value lets a Ruhl staffer submit
without choosing, recording a guess as fact — the same failure shape as the
roster blank-name bug. Make it required for Ruhl.

Also needed (review S7): a line in `emptyForm()` (`:82-99`) and in the `useState`
hydration (`:167`), or the choice silently resets if an agent returns to a
part-completed form. Review summary row goes in the **step-3** `ReviewSection`,
not the step-1 one at `:1369`.

### 5. Persist and apply the choice

**Two additive changes. No shared behaviour is altered.**

a) Add `'serviceOption'` to the `ALLOWED` set in
`src/app/api/customers/[id]/route.ts:7-60`. Unknown keys are dropped **with no
error** (`:76`), so without this the field appears to save and writes nothing.
Additive — no existing field changes.

b) A new named-task branch in `handleTaskCompleted` section 2
(`activate-dependents.ts:174-205`, alongside the existing `Create Customer
Account` / `Send Credentials` branches). On `Confirm Your Information` completing,
if `service_option === 'done-for-you'`, call `updateTaskStatus` on the booking
task. Runs after section 1 has activated it, so ordering is deterministic. Fires
only for Ruhl Done-For-You customers; every other brokerage is untouched.

Review confirms no race between the two Auto-2 runs in one request (N3).

### 6. `Send Credentials` → stage nudge + CC

In the same `Send Credentials` branch:

- If `currentStage === 'Getting Started'`, set `'Prepare for Onboarding'` (D6).
- `src/app/api/workspace/send-credentials/route.ts:97` — add `cc` resolved from
  `brokerages.managed_cc_email` via `customer.brokerageId`, when
  `service_option === 'done-for-you'`.

### 7. Clear a stale booking task at launch

Add `'Schedule Your Onboarding Call'` to `TERMINAL_CLIENT_TASKS`
(`advance-to-launched-from-hs.ts:29-32`). Viable only because of D6.

Blast radius across BW/Keyes/IPRE/Coach is **zero rows today** (review N4).

### 8. Backfill

Read the Ruhl cohort **from the database at run time** — it grew from 12 → 14
during planning (Kurt Johnson 2026-10-16 02:50, Nathan Stout 2026-10-16 03:25).
Report any `B2B-RUHL` row with `service_option IS NULL` so new arrivals surface.

Confirmed: **Jeramy Jennings = Self Post** (user). From Ruhl's sheet, pending
confirmation: Laura Custis, Ashley Block, Sara Carlson = Self Post; Rachel
Anderson, Otto Nobis = Done For You. No sheet entry: Mary Schoon, Megan
Stopulos, Bob Kelly, Carrie Lamb, Hannah Peart, Alexis Anderson, Kurt Johnson,
Nathan Stout.

Sets `service_option` only. **Do not** retro-add the booking task to anyone
already `Launched`.

`.env.local` points at the production database — dry-run first.

### 9. Comment fix

`monthly-cohort-digest.ts:82-86` says Ruhl "has no onboarding call at all", which
step 1 falsifies. The rule value (`'signed-in'`) stays correct. Fix in the same
commit so nobody later "fixes" the rule.

### 10. Deferred — HubSpot ticket timing

`SEND_CREDENTIALS_TICKET_PUSH` (`activate-dependents.ts:49-51,196-203`) is
deliberate pilot config, not a bug. Once a booking task exists the ticket flips
Active *before* the call. An entry also suppresses the Launched → "Onboarding
Scheduled" branch (`:382-395`). Decide after the rest ships.

## Risks

- **R1** — `other_emails` carries an alternate DMG address for 6 of 14 Ruhl
  customers. D8 means we no longer write to it, so this is now informational.
- **R2** — hidden and auto-completed tasks still count for stage advancement
  (no `visibleToClient` filter at `:308-315`). Why D7 completes rather than hides.
- **R3** — `.env.local` is the production database.
- **R4** — UI change on a live system: preview and sign-off before push.
- **R5** — 9 build-inert commits (scripts/docs/CLAUDE.md) are unpushed and will
  ship with the first `src/` push. Verified: none touch `src/`.

## Open questions

1. Is Mario Giron the right onboarding-call host for Ruhl?
2. Take the 5 service options from Ruhl's sheet, or wait for confirmation?
3. Bob Kelly, Carrie Lamb, Hannah Peart, Kurt Johnson, Nathan Stout — which tier?
4. Alexis Anderson (started 2026-08-05) and Kurt Johnson (2026-10-16) both landed
   without submitting. Chase or drop?
5. Backfill the existing HubSpot Contacts' payment-mode property to `'invoice'`?

## Out of scope

- `B2B-Coach` missing from both `ONBOARDED_RULE` tables
  (`funnel-audit-labels.ts:50-54`, `monthly-cohort-digest.ts:89-93`) — no Coach
  customer counts as Onboarded in any report. Pre-existing.
- `STUCK_WORKFLOW_KEYS` includes `'B2B-Coach'` (`db.ts:1459`) but the `counts`
  object at `:1523-1524` omits it.
