# Adversarial review — `ruhl-service-options.md`

**Date:** 2026-10-15
**Reviewed against:** live code at `main` (b41cb9a) + live Neon production DB.
**Verdict:** the *shape* of the plan (D1–D4) is sound and well-argued. Three of
the eight implementation steps do not work as written. One of them (step 6)
cannot work at all for the case it was designed for, and that same mechanism
hides a pre-existing B2B-RUHL bug the plan mis-attributes to step 8.

Reference flow used throughout: **`B2B-BW`** (per instruction; Coach treated as
corroborating evidence only, never as the model).

---

## BLOCKERS

### B1 — Nothing in the codebase reads `other_emails`. Step 5's CC mechanism does not exist.

This is R3, and it resolves against the plan.

`other_emails` is **write-only**. Every reference in `src/`:

| Site | What it does |
|---|---|
| `src/db/schema/customers.ts:190` | column definition |
| `src/app/api/agent-lookup/route.ts:166` | written at B2B create (alternate DMG email) |
| `src/app/api/agent-lookup/route.ts:347` | written as `null` on the `/[slug]/test` path |
| `src/lib/db.ts:168`, `:340` | mapper read → `Customer.otherEmails` |
| `src/components/tasks/FormTask.tsx:1198` | D2C-only form field |
| `src/components/tasks/FormTask.tsx:1369` | D2C-only review row |
| `src/app/api/customers/[id]/route.ts:41` | PATCH allowlist entry |
| `src/app/workspace/customers/[id]/page.tsx:602` | displayed as a `CopyableField` |

There is **no email path that reads it** — not for B2B, and not for D2C either,
despite the helper text. `grep` for `cc:`/`bcc:` across `src/` returns only:

- `src/lib/email/send.ts:209` — hardcoded `bcc: 'poorab@rejig.ai'` for
  customer-facing templates (`CUSTOMER_EMAIL_BCC`, `send.ts:41`).
- `src/lib/automations/trigger-email.ts:81` — `cc = template === 'welcome' ? customer.salesRepEmail : null`.
  Explicitly comments that design-ready and credentials-sent *skip* the CC.
- `src/lib/automations/dropoff-reminders.ts:339,356` — `D2C_ESCALATION_CC` (internal, hardcoded).
- `src/lib/automations/dropoff-reminders.ts:514,532` — `OPS_ESCALATION_CC` (internal, hardcoded).
- `src/app/api/cron/dropoff-digest/route.ts:66` — `DIGEST_CC` (internal).

`sendEmail()` accepts a `cc` param (`send.ts:181,207`), so the plumbing is
there. Nothing wires `other_emails` into it.

**Consequence:** step 5's "Append `brokerages.managed_cc_email` to
`customers.other_emails`" copies Ruhl's marketing team onto **nothing**. The
plan's own line — *"Reminders already CC nobody but `contact_email`; the
marketing address riding in `other_emails` is what gets them copied"* — is
false. The reminder send (`dropoff-reminders.ts:294-303`) passes `to:
customer.contactEmail` and no `cc` at all.

**Alternative (recommended).** Drop `other_emails` from the design entirely and
make the CC an explicit, typed parameter at each send site. Two sites matter:

1. `src/app/api/workspace/send-credentials/route.ts:97` — add
   `cc: managedCcEmail` (resolved from the customer's brokerage when
   `service_option === 'done-for-you'`).
2. `src/lib/automations/dropoff-reminders.ts:294` — same, if Ruhl marketing
   should get reminder copies. (Note: a Done-For-You agent auto-completes the
   booking task under D5, so the only reminder they could receive is on
   `Watch Setup Video` / `Sign In & Reset Password`. Decide whether that is
   even wanted before wiring it.)

Resolve the address from `brokerages.managed_cc_email` at send time via
`customer.brokerageId` (populated for **13/13** Ruhl customers — verified). The
new `brokerages` column from step 3 is still the right place to store it; only
the *delivery* mechanism changes. Keep `other_emails` out of it — writing a
third-party address into a field the workspace labels "Other Emails" and that
`agent-lookup` also writes creates an ambiguity with no reader to disambiguate it.

### B2 — "Send Credentials" is a fully programmatic email with no recipient UI. The human never sees a CC field.

Finding 2 in the brief. The plan assumes *"a human Account Creator sends it
manually and would see the CC address."* They do not.

`src/app/api/workspace/send-credentials/route.ts:97-107` calls
`sendEmail({ template: 'credentials-sent', to: customer.contactEmail, data: {...} })`.
No `cc`, no `bcc` beyond the global `CUSTOMER_EMAIL_BCC`.

The workspace UI (`src/app/workspace/customers/[id]/SendCredentialsAction.tsx`)
exposes exactly **two** controls: a read-only Platform Email display and an
editable temp-password box. The POST body is `{ taskId, customerId, password }`
(`SendCredentialsAction.tsx:44`). There is no recipient input, so an Account
Creator cannot add an address even if they wanted to.

`triggerCustomerEmail` also hard-refuses this template
(`trigger-email.ts:27-33`), confirming the workspace route is the only sender.

**Consequence:** the CC must be a code change at
`send-credentials/route.ts:97`. It is not an operational/process fix. This is
the concrete form of B1's recommendation.

### B3 — Step 6 is a no-op for the exact failure it is meant to prevent.

`TERMINAL_CLIENT_TASKS` (`advance-to-launched-from-hs.ts:29-32` — anchor
**correct**) is consumed by `advanceToLaunchedFromHsActive`, which early-returns
unless the customer is at a specific stage (`advance-to-launched-from-hs.ts:50-52`):

```ts
if (customer.currentStage !== 'Prepare for Onboarding') {
  return { kind: 'skipped', reason: `currentStage="${customer.currentStage}" — only advance from "Prepare for Onboarding"` };
}
```

The booking task lives in **`Getting Started`** for every B2B workflow (verified
in `workflow_templates`):

| Workflow | Booking task stage | stage_order / task_order |
|---|---|---|
| B2B-BW | Getting Started | 1 / 2 |
| B2B-Coach | Getting Started | 1 / 2 |
| B2B-IPRE | Getting Started | 1 / 3 |
| B2B-Keyes | Getting Started | 1 / 3 |
| D2C-Standard | Review Your Designs | 2 / 3 |

Stage advancement requires **every** task in the stage to be `Completed`
(`activate-dependents.ts:308-310` — anchor **correct**, the plan's `308-315` is
a 5-line range over a 3-line expression). So a customer with an open
`Getting Started` booking task is, by construction, still at
`currentStage = 'Getting Started'` — never at `Prepare for Onboarding`.
`advanceToLaunchedFromHsActive` therefore skips them, and adding the task name
to `TERMINAL_CLIENT_TASKS` changes nothing.

The two names already in that list (`Sign In & Reset Password`,
`Watch Setup Video`) are both `Prepare for Onboarding` tasks. The list is
implicitly scoped to that stage. Adding a `Getting Started` task to it is a
category error.

**Empirical confirmation.** Across the whole production DB, customers at
`Prepare for Onboarding` with an `Active` `Schedule Your Onboarding Call` task:
**0 rows.** Not because the case is rare — because it is structurally impossible.

### B4 — Adding the booking task to `B2B-RUHL` introduces a permanent stage-stall for Self Post agents who never book. Nothing in the plan addresses it.

This is the consequence B3 leaves uncovered, and it is the single largest risk
in the plan.

D4 is right that *task dependencies* never gate on the booking (verified: no
`workflow_templates` row anywhere has `depends_on` matching
`Schedule Your Onboarding Call` — it is a leaf in all six workflows; and
`Create Customer Account <- Create Designs` in all five B2B keys). The team can
design, create the account and send credentials regardless.

But the **stage field** does gate on it. A Self Post Ruhl agent who never books:

- `Confirm Your Information` ✓, `Create Designs` ✓, booking task **Active**
- → `Getting Started` never completes → `currentStage` stuck at `Getting Started`
- → meanwhile `Create Customer Account` → `Send Credentials` → agent signs in,
  because those run off task deps, not stage
- → the customer is live, billed, and reads as **Getting Started** in every
  report forever
- → `advanceToLaunchedFromHsActive` cannot rescue them (B3)
- → they receive drop-off reminder emails on the booking task indefinitely

That last point: `runCustomerTrack` (`dropoff-reminders.ts:214-225`) filters on
`taskType='Client' AND visible_to_client AND status='Active' AND currentStage != 'Launched'`.
There is **no `customer.type` filter** — B2B is in scope. Tiers cap the volume
(`dueTier > sentTier`), but the customer never reaches `Launched`, so the
suppression never kicks in.

Today Ruhl has **no** booking task, which is precisely why its 13 customers
reach `Prepare for Onboarding` / `Launched` cleanly. Step 1 removes that
property. Ruhl is also the brokerage where this bites hardest: agents are under
contract before we see them, so booking compliance is the weakest of any flow.

Note the pattern already exists upstream — **1 B2B-IPRE customer** is in exactly
this stall right now (`Active` booking task, `currentStage='Getting Started'`).
It is tolerable at IPRE because a card-capture gate precedes it. Ruhl has no gate.

**Options, in order of preference:**

1. **Move the Ruhl booking task to `Prepare for Onboarding`** (`stage_order 2`,
   after `Send Credentials`). Then `TERMINAL_CLIENT_TASKS` genuinely works,
   step 6 becomes correct as written, and "book your call" lands *after* the
   agent has credentials — arguably better sequencing for a brokerage that
   bills by invoice. Cost: diverges from `B2B-BW`'s shape, which D2 wants to
   preserve. Worth the divergence; D2's reason for copying BW is correctness,
   and BW's placement is not correct for a no-card flow.
2. Keep it in `Getting Started` and relax the
   `currentStage === 'Prepare for Onboarding'` guard in
   `advanceToLaunchedFromHsActive` to accept any non-terminal stage. Touches
   BW/Keyes/IPRE/Coach behaviour — bigger blast radius than step 6 claims.
3. Auto-complete the booking task on `Send Credentials` for **both** tiers.
   Loses the booking signal entirely; contradicts D6's purpose.

Either way, **this must be decided before step 1 ships**, because step 1 alone
creates the stall.

---

## SHOULD-FIX

### S1 — `service_option` will be silently dropped by `PATCH /api/customers/[id]`.

`src/app/api/customers/[id]/route.ts:7-60` is a hard allowlist (`ALLOWED`). Any
key outside it is dropped with **no error** (`:76` — `if (!ALLOWED.has(key)) continue;`).
`FormTask.handleSubmit` writes the customer via exactly this route
(`FormTask.tsx:983`).

Step 3/4/5 must add `'serviceOption'` to that set, or the form field will
appear to work and write nothing. Silent-failure class; easy to miss in a
manual test if the tester only checks that the form submits.

### S2 — There is no server-side "intake submit path" for step 5 to live in.

Step 5 says *"In the intake submit path (not the route — business logic belongs
in `src/lib/`)"*. No such function exists. The intake submit is **client-driven
and split across two independent requests** (`FormTask.tsx:909-1000`):

```
PATCH /api/customers/{id}      → field writes          (FormTask.tsx:983)
PATCH /api/tasks/{taskId}      → status: 'Completed'   (FormTask.tsx:994)
```

So "write `service_option`, then auto-complete the booking task" has nowhere
natural to go. A third client `fetch` would be bypassable and would put business
logic in the browser.

**Recommended home:** a named-task branch in `handleTaskCompleted` section 2
(`activate-dependents.ts:174-205`, alongside the existing
`'Create Customer Account'` / `'Send Credentials'` / `'Mark Onboarding Call Complete'`
branches). On `completedTask.taskName === 'Confirm Your Information'`, read
`customers.service_option`; if `'done-for-you'`, call
`updateTaskStatus(bookingTaskId, 'Completed')`. This runs *after* section 1 has
already activated the booking task `Draft → Active`, so ordering is deterministic
and server-side. It satisfies the plan's own "no `db.update(tasks)` directly" rule.

### S3 — The plan's Ruhl cohort is stale: there are **13** customers, not 12.

A 13th landed after the plan was written:

```
2026-10-16 02:50 UTC | Kurt Johnson | KurtJohnson@RuhlHomes.com
  stage=Getting Started | via=b2b_landing | other_emails=kurtjohnson713@gmail.com
```

He is absent from the step-7 backfill table and from Open Question 3. R1's count
is likewise now **6 of 13** carrying an alternate DMG address, not 5 of 12
(Mary Schoon, Alexis Anderson, Laura Custis, Ashley Block, Otto Nobis, Kurt
Johnson). R1's two cited examples (`ottognobis@gmail.com`,
`kevincustis@ruhlhomes.com`) are **both correct**.

Takeaway beyond the arithmetic: the cohort grows while the plan is open. Step 7
should re-derive the list from the DB at execution time rather than from the
frozen table, and the backfill script should report any `B2B-RUHL` row with
`service_option IS NULL` so new arrivals surface instead of being silently missed.

### S4 — Step 8's "related" paragraph is wrong, and it hides a real root cause.

The plan says Sara Carlson, Bob Kelly and Jeramy Jennings *"have every client
task completed but sit at `Prepare for Onboarding`"* and need a re-run *"once
step 8 is settled."* Both halves are wrong.

Live task state:

| Customer | Watch Setup Video | Sign In & Reset Password |
|---|---|---|
| Sara Carlson | **Active** | Completed |
| Bob Kelly | **Active** | Completed |
| Jeramy Jennings | **Active** | **Active** |

They are not "every client task completed" — they are stranded on tasks that are
**already in `TERMINAL_CLIENT_TASKS`**, at `currentStage='Prepare for Onboarding'`,
with `accountCreated=true`. That is precisely
`advanceToLaunchedFromHsActive`'s target case. A one-off re-run would launch all
three **today**. It is not blocked on step 8 or on anything else in this plan.

**Why they got stranded (root cause, not in the plan).** For `B2B-RUHL`,
`SEND_CREDENTIALS_TICKET_PUSH` (`activate-dependents.ts:49-51`) has LP itself
call `pushTicketStage(ticketId, 'Active')` at `:196-203`. The webhook that
HubSpot sends back for that change arrives as
`changeSource=INTEGRATION, sourceId=<LP app id>` and is **dropped by LP's own
loop prevention** (`src/app/api/webhooks/hubspot/route.ts:290-294`, predicate at
`:87`). The `stageLabel === 'Active'` branch that calls
`advanceToLaunchedFromHsActive` (`route.ts:508-510`) therefore **never fires for
Ruhl** — LP pushed the stage, so LP never hears about it.

This is a standing `B2B-RUHL`-specific defect, independent of the service-option
work: every Ruhl customer who gets credentials will strand at
`Prepare for Onboarding` unless a human intervenes or a CSM moves the ticket by
hand in the HS UI (which *would* arrive as `CRM_UI` and pass the filter).

It also makes step 8 more consequential than "deferred, not blocking": the same
`SEND_CREDENTIALS_TICKET_PUSH` entry is what makes HS flip to `Active` before the
call happens **and** what suppresses the `Launched → "Onboarding Scheduled"`
branch at `:382-395` (anchor **correct**). The plan is right that it is a
deliberate pilot config, right that the flip becomes premature, and right to
defer the *decision* — but it should record that the entry is currently causing
live stage-stall, so "deferred" does not read as "harmless".

### S5 — `monthly-cohort-digest`'s B2B-RUHL rule and its comment both go stale.

The plan's headline claim — *"because there is one workflow key, no report needs
touching"* — is true for *breakage* and false for *semantics*.

- `src/lib/automations/monthly-cohort-digest.ts:66` —
  `'Schedule Your Onboarding Call': 'Booked'`. Once Ruhl has the task,
  auto-completed Done-For-You agents will be stamped **Booked** in the monthly
  digest. The plan flags the inflated count in D5's "Known cost" but does not
  name this as the report that carries it.
- `src/lib/automations/monthly-cohort-digest.ts:82-86` — the `ONBOARDED_RULE`
  comment reads *"Ruhl's flow has no onboarding call at all … so 'call-held'
  could never fire"*. After step 1 that is factually wrong. The rule value
  (`'signed-in'`, `:92`) is still the right one for an invoice-billed flow with
  no Stripe signal — only the comment needs correcting. Worth doing in the same
  commit so the next reader does not "fix" the rule.
- `scripts/funnel-audit-labels.ts:53` gives `B2B-RUHL: 'stage'` — unaffected.

### S6 — The new form field: step index, Review section, and the Ruhl gate.

Three small corrections to step 4:

1. **The step index is right but the precedent cited is on a different step.**
   `STEPS` is `business(0) / brand(1) / content(2) / account(3) / review(4)`
   (`FormTask.tsx:53-59`), so "Account Access, index 3, the step before Review"
   is correct. But the `{!isB2B && ...}` Other Emails field at
   `FormTask.tsx:1198` (anchor **correct**) sits in `case 1` — *You & Your
   Brand*, not Account Access. Fine as a pattern reference; just don't copy its
   neighbours' placement.
2. **The Review summary row goes in the step-3 `ReviewSection`, not the step-1
   one.** `FormTask.tsx:1369` (anchor **correct**) is inside the
   `stepIndex={1}` section. Adding the new row there would make the Edit button
   jump to the wrong step.
3. **"Render only for Ruhl" is feasible** — `Customer.workflowKey` exists on the
   prop type (`src/types/index.ts:100`) and `TaskRenderer` passes the full
   `customer` through (`TaskRenderer.tsx:37`). Gate on
   `customer.workflowKey === 'B2B-RUHL'`, not on `channel`, and not on slug
   (the portal has no slug).

Also: `REQUIRED_FIELDS` (`FormTask.tsx:62-67`) has no entry for the new field.
Since the plan specifies a default of *Self Post*, that is consistent — but it
means a Ruhl staffer filling the form for a Done-For-You agent can submit
without ever touching the control. **Recommend no default and an explicit
required radio** for Ruhl: the whole value of D6 is that the choice is recorded
deliberately, and a silent default reintroduces exactly the "blank on the sheet"
ambiguity that Open Question 3 is about. (Cf. the roster blank-name bug — a
field with no human checkpoint.)

### S7 — Partially-completed form survival.

Asked in the brief. `FormTask` hydrates from `customer` on mount
(`FormTask.tsx:167`: `otherEmails: customer.otherEmails || ''`) and there is a
`?test=fill` style re-entry path at `:707-740` that PATCHes customer + task. A
Ruhl agent who abandons mid-form and returns will re-render from the customer
row. **So the new field survives only if it is persisted to
`customers.service_option` and read back in the same hydration block** —
i.e. it needs a line in the `useState` initialiser at `:167` *and* in
`emptyForm()` at `:82-99`, plus S1's allowlist entry. Otherwise it silently
resets to the default on re-entry, which (with S6's default) means a
Done-For-You selection can be lost without trace.

---

## NICE-TO-KNOW

### N1 — The Calendly question is already settled by precedent.

`generate-tasks.ts:215-216` (plan's `214-217` — close enough) is correctly
described: the brokerage default only overrides when set, and Ruhl's
`brokerages.default_calendly_url` is `NULL` (verified). What the plan misses is
that **the template row is the established answer for exactly this case**:

| Workflow | template `embed_url` | brokerage `default_calendly_url` |
|---|---|---|
| B2B-BW | mario-giron link | mario-giron link |
| B2B-Keyes | mario-giron link | mario-giron link |
| B2B-IPRE | mario-giron link | mario-giron link |
| **B2B-Coach** | **mario-giron link** | **NULL** |
| D2C-Standard | mario-giron link | — |

Coach — a brokerage with no `default_calendly_url` — carries the link on the
template row. So "stamp `embed_url` on the template row" is the existing
convention, not a fork. Open Question 1 (is Mario the right host) remains a
genuine product question; the *mechanism* is decided.

### N2 — Step 1's `taskOrder` renumbering is safe. Nothing keys off the number.

Asked in the brief. Verified:

- `workflow_templates` has **no unique constraint** on `(workflow_key, task_order)`.
  Only `workflow_templates_pkey` on `id`, plus a **non-unique**
  `workflow_templates_lookup_idx (workflow_key, stage_order, task_order)`.
  A duplicate `task_order` would not error — so renumbering is a cosmetic
  correctness matter, not a constraint matter.
- `tasks.task_order` is copied from the template at generation time
  (`generate-tasks.ts:224`) and is only ever used for **display ordering**.
- The 13 existing Ruhl customers keep `Create Designs` at `task_order = 2`
  (verified in `tasks`), while new customers get it at `3`. Because sorting is
  per-customer, there is **no cross-customer inconsistency** in the portal or
  workspace. An old customer shows `Confirm(1), Create Designs(2)`; a new one
  shows `Confirm(1), Schedule(2), Create Designs(3)`. Both read correctly.
  `Create Designs` is `visible_to_client=false` anyway, so the portal never
  shows it.

No action needed. Do **not** retro-update existing `tasks.task_order`.

### N3 — D5's race concerns are unfounded. The existing guards hold in both orderings.

Asked in the brief (item 3). I walked both orderings; neither double-fires.

The transition guard in `updateTaskStatus` (`db.ts:846-849`) is
`ne(tasks.status, status)` — *not* `status = 'Active'`. So a `Draft → Completed`
jump is permitted, and a lost race returns the existing row **without**
re-firing `handleTaskCompleted` (`db.ts:857-865`). Same guard in
`updateTaskFields` (`db.ts:779-787`).

**Order A — `Confirm Your Information` completes first (the normal case):**
section 1 activates the booking task `Draft → Active`; `3b` fires the HubSpot
intake push once (`activate-dependents.ts:283-287`, keyed on
`completedTask.taskName === 'Confirm Your Information'`); `3c` fires the Slack
alert once (`:295-299`). Then the booking task completes → its own Auto 2 runs:
section 1 finds nothing, `3b`/`3c` don't match its name, so **no second HS push
and no second Slack post**.

**Order B — booking task completed first (if the client fires out of order):**
the booking task goes `Draft → Completed` directly. Its Auto 2 runs; section 4
sees `Confirm` still `Active` → no advance. Then `Confirm` completes; section 1
skips the booking task (`if (draft.status !== 'Draft') continue;`,
`:128`); `3b`/`3c` fire exactly once.

**No double stage-advance in either order**, because `Create Designs` is a
`Getting Started` **Team** task that is still `Active`/`Draft` when both client
tasks complete. Section 4's `allStageComplete` check fails, so it returns early
both times. The conditional `UPDATE ... WHERE currentStage = completedTaskStage`
(`:396-404`, `:425-434`) is a second belt.

**One real artifact of Order B:** the booking task would end up with
`completedAt` set and `activatedAt = NULL`. Nothing crashes
(`dropoff-reminders.ts:230` and `dropoff-b2b-digest.ts:99` both skip rows with
no `activatedAt`), but it is an inconsistent row and would make
`monthly-cohort-digest`'s milestone timeline odd. S2's recommendation (do it
server-side in `handleTaskCompleted` section 2) makes Order B impossible.

**Verdict on D5's mechanism: sound.** Use `updateTaskStatus`, as the plan says;
just move *where* it is called from (S2).

### N4 — Step 6's blast radius today is zero rows. The plan over-warns on R6 and under-warns on B3.

Asked in the brief (item 5). Complete production distribution of
`Schedule Your Onboarding Call`:

| Workflow | Status | Customer stage | n |
|---|---|---|---|
| B2B-BW | Draft | Getting Started | 1 |
| B2B-BW | Completed | Launched | 14 |
| B2B-Coach | Completed | Launched | 3 |
| B2B-Coach | Completed | Prepare for Onboarding | 3 |
| B2B-IPRE | Draft | Getting Started | 24 |
| B2B-IPRE | **Active** | Getting Started | **1** |
| B2B-IPRE | Completed | Launched | 50 |
| B2B-IPRE | Completed | Prepare for Onboarding | 6 |
| B2B-Keyes | Draft | Getting Started | 51 |
| B2B-Keyes | Completed | Getting Started | 1 |
| B2B-Keyes | Completed | Launched | 45 |
| B2B-Keyes | Completed | Prepare for Onboarding | 3 |
| D2C-Standard | Draft | Getting Started | 4 |
| D2C-Standard | Draft | Review Your Designs | 3 |
| D2C-Standard | **Active** | Review Your Designs | **1** |
| D2C-Standard | Completed | Launched | 20 |
| D2C-Standard | Completed | Prepare for Onboarding | 2 |

`advanceToLaunchedFromHsActive` only touches rows that are `Active` **and**
`visible_to_client` **and** whose customer is at `Prepare for Onboarding`.
Matching rows across BW/Keyes/IPRE/Coach: **0**. So R6 and Open Question 5 are
answerable: *"it changes nothing for anyone today."*

That is also why step 6 is useless (B3) — the same guard that makes it harmless
makes it inert. The two facts are one fact.

### N5 — The `/[slug]/test` path needs the new field too, and is currently off.

Asked in the brief (item 6). `src/app/[slug]/test/page.tsx` exists and is gated
on `settings.b2b_test_route_enabled === 'on'`; the live value is **`off`**
(verified), so `/ruhl/test` currently 404s. It must be flipped on to test this
work, and off again after (per the pre-launch-checklist habit).

Two things to know:

- The test create path (`agent-lookup/route.ts:333-348`) calls the **same**
  `createRosterCustomer` with the same `channelCode`, so the test customer gets
  `workflow_key = 'B2B-RUHL'`. S6's `customer.workflowKey === 'B2B-RUHL'` gate
  therefore works identically in test mode. Good.
- It passes `otherEmails: null` (`:347`) and `environment: ['test']`. If the
  design had kept `other_emails` as the CC carrier (B1), the test path would
  have silently diverged from prod. Another reason to abandon that mechanism.
- Both `dropoff-reminders.ts:236` and `dropoff-b2b-digest.ts:105` skip
  `environment` containing `test`, so a test Ruhl customer will not generate
  reminder noise.

### N6 — Workspace UI: the Account Creator has no way to see the tier.

Asked in the brief (item 6). `src/app/workspace/customers/[id]/page.tsx` renders
an "Intake Form Details" section; `other_emails` already shows there as a
`CopyableField` (`:602`). There is **no** display for `service_option`.

Given B2 (the credentials email is programmatic and the CC must be in code),
the AC does not strictly *need* to see it. But the Designer and AC working a
Done-For-You account are working an account the agent will never log into, and
nothing on screen says so. **Recommend one `CopyableField` for Service Option**
in that section — one line, and it makes the fork visible to the humans doing
the work. Low cost, meaningful for ops.

### N7 — `docs/flows/` is thinner than the brief assumed.

The brief notes `docs/flows/` has no `b2b-ruhl.md` "while every other flow has a
vetted map." Actual contents: `README.md`, `b2b-bw.md`, `b2b-keyes.md`,
`d2c-standard.md`. **IPRE and Coach have no map either.** So the gap is real but
Ruhl is the third brokerage missing one, not the first. Writing `b2b-ruhl.md`
as part of this work is worthwhile (it is the flow being changed, and the
service-option fork needs documenting somewhere), but it is not closing a
Ruhl-specific anomaly.

### N8 — Should `service_option` be pushed to HubSpot?

Asked in the brief (item 6). Against the lean-properties principle
(only ID anchors or BI signals actively used in the HS UI), I would say
**not yet** — but the question is sharper than it looks, because HubSpot is
where the CSM lives post-launch, and "this agent will never attend an
onboarding call" is exactly the sort of thing that mis-fires a CSM workflow.

Note that `rejig_payment_mode` is already pushed
(`intake-handler.ts:287`), and after step 2 all Ruhl contacts will read
`'invoice'` — which does **not** distinguish the two tiers. If any HS workflow
enrolls Ruhl contacts on a meeting-outcome condition, Done-For-You agents will
sit in it forever with no meeting. Worth a deliberate check of the Ruhl HS
workflows before deciding; if any such workflow exists, the property earns its
place and this moves to SHOULD-FIX.

### N9 — Minor naming collision.

`customers` already has `service_areas`. A new `service_option` column sits one
character from it in autocomplete and in any `ilike '%service%'` audit query.
`service_tier` or `ruhl_service_option` would read less ambiguously. Cosmetic.

### N10 — D1's second rejection argument is weaker than stated (conclusion unchanged).

The plan rejects "second workflow key on one brokerage" partly because it
*"splits every report that maps brokerage → single workflow key
(… `branch-funnel-report.ts:392-393`)"*. That anchor actually reads:

```ts
.where(or(
  eq(schema.customers.workflowKey, workflowKey),
  eq(schema.customers.brokerageId, brokerage.id),
))
```

The `brokerageId` arm would have caught the second key. The `funnel-audit.ts:125-137`
and `monthly-cohort-digest.ts:210-218` anchors **are** single-key and **do**
verify as described, and the `getBrokerageByDefaultWorkflowKey` argument
(`db.ts:1266-1273`, anchor **exact**) is correct and decisive on its own. So
D1's conclusion stands; one of its three supports does not. Flagging only
because a future reader may rely on the wrong one.

---

## Anchor audit

Every file:line in the plan, checked. Most are good.

| Plan anchor | Verdict |
|---|---|
| `activate-dependents.ts:33-39` INTAKE_PUSH_TRIGGER_TASK | ✅ exact (33-39) |
| `activate-dependents.ts:49-51` SEND_CREDENTIALS_TICKET_PUSH | ✅ exact |
| `activate-dependents.ts:61-68` SLACK_INTAKE_TRIGGER_TASK | ✅ exact |
| `activate-dependents.ts:196-203` ticket push | ✅ correct |
| `activate-dependents.ts:308-315` stage-advance check | ⚠️ logic is at **308-310**; 311-315 is the early return. Harmless. |
| `activate-dependents.ts:382-395` Launched suppression | ✅ correct (`!SEND_CREDENTIALS_TICKET_PUSH[workflowKey]` at `:385`) |
| `advance-to-launched-from-hs.ts:29-32` TERMINAL_CLIENT_TASKS | ✅ exact |
| `generate-tasks.ts:214-217` embedUrl override | ⚠️ actually **215-216**. Harmless. |
| `intake-handler.ts:48-56` CHANNEL_CODE_TO_HUBSPOT_ENUM | ⚠️ actually **51-58** (3-line drift). `RUHL: 'b2b_ruhl'` already present. |
| `intake-handler.ts:188-193` `{kind:'error'}` | ⚠️ actually **189-194**. Harmless. |
| `intake-handler.ts:226,287` payment-mode push | ✅ both exact |
| `db.ts:1266-1273` getBrokerageByDefaultWorkflowKey | ✅ exact |
| `db.ts:1459` STUCK_WORKFLOW_KEYS | ✅ exact |
| `db.ts:1523-1524` counts object | ✅ exact — and see O2 below |
| `handle-call-completed.ts:79-86` payment-mode bail | ✅ correct |
| `payment-setup/route.ts:74-78` 400 | ✅ correct (73-79) |
| `dropoff-b2b-digest.ts:88-95` selectDistinct | ✅ correct (89-95) |
| `dropoff-b2b-digest.ts:110` isHotCase | ✅ correct (108-110) |
| `branch-funnel-report.ts:341` brokerage filter | ✅ correct |
| `branch-funnel-report.ts:392-393` | ⚠️ see N10 |
| `funnel-audit.ts:125-137` | ✅ correct |
| `monthly-cohort-digest.ts:210-218` | ✅ correct |
| `funnel-audit-labels.ts:50-54` ONBOARDED_RULE | ✅ exact |
| `monthly-cohort-digest.ts:89-93` ONBOARDED_RULE | ✅ exact |
| `FormTask.tsx:1198` `{!isB2B && ...}` | ✅ exact — but see S6 (it's on step 1, not 3) |
| `FormTask.tsx:~1369` Review row | ✅ exact — but see S6 (step-1 section) |

Also verified as described and **safe**, per step 2: nothing branches on
`payment_mode` for a non-`setup-intent-at-intake` flow, and the live distinct
values are clean per key (`B2B-RUHL: {none}`, `B2B-BW: {invoice}`,
`B2B-Coach: {invoice}`, `B2B-IPRE`/`B2B-Keyes: {setup-intent-at-intake}`,
`D2C-Standard: {pre-paid}`). The "must be all rows in one go" warning is
correct — `selectDistinct` with a `limit 1` consumer (`intake-handler.ts:221-226`)
would read a nondeterministic value mid-migration.

---

## Out-of-scope items — confirmed real, one is worse than described

Asked in the brief (item 7). Both Coach bugs verify. Not expanding scope.

**O1 — Coach missing from both `ONBOARDED_RULE` tables.** Confirmed.
`scripts/funnel-audit-labels.ts:50-54` and
`src/lib/automations/monthly-cohort-digest.ts:89-93` both list
IPRE/Keyes/BW/RUHL and omit `B2B-Coach`. Both default unlisted keys to
`'subscription'` (`funnel-audit-labels.ts:56-58`). Coach is invoice-billed with
no per-agent Stripe sub, so no Coach customer can ever satisfy
`'subscription'` → **no Coach customer counts as Onboarded in any report.**
Correctly described.

**O2 — `STUCK_WORKFLOW_KEYS` / `counts` mismatch.** Confirmed, and the
consequence is worse than "omits it". `db.ts:1459` includes `'B2B-Coach'`;
`db.ts:1523-1524` initialises `counts` without it. The increment at `db.ts:1536`
is:

```ts
if (days >= threshold) counts[threshold][wk] += 1;
```

With `wk = 'B2B-Coach'`, that is `undefined += 1` → the key is set to **`NaN`**,
not left absent. So the admin stuck tile can render `NaN` for Coach rather than
a missing row. `B2B-RUHL` **is** present in both, so Ruhl is unaffected.

**O3 — Nathan Stout.** Confirmed absent: no `customers` row matches, under
`workflow_key = 'B2B-RUHL'` or `brokerage_id = b6e138ee…`. Chase with Ruhl, as
the plan says.

---

## What the plan gets right

Stated briefly, so the signal above is readable as signal.

- **D1 (one slug, one workflow key)** is the correct call, and the
  `getBrokerageByDefaultWorkflowKey` argument is decisive. The roster-duplication
  cost is real: Ruhl has **330** roster rows and a twin brokerage would need a
  second full copy plus a sixth DMG pull inside the 300s Hobby ceiling.
- **D2 (copy BW, not Coach)** — BW and Coach are indeed structurally identical
  (verified row-for-row in `workflow_templates`, modulo Coach's own quirks), and
  BW is the one with volume behind it.
- **D4 (do not gate on the booking)** is correct *as a dependency claim*: the
  booking task is a leaf in all six workflows — verified, no
  `workflow_templates.depends_on` anywhere references it — and
  `Create Customer Account <- Create Designs` in all five B2B keys. The
  stage-level consequence is what D4 misses (B4).
- **D5's mechanism** (auto-complete via `updateTaskStatus`, not a raw
  `db.update`) is right, and the reasoning about hidden tasks counting for stage
  advancement (R2) is exactly correct — `activate-dependents.ts:308-310` has no
  `visibleToClient` filter.
- **R1** is accurate (modulo the 12→13 count).
- **R4** is accurate and worth taking seriously: `.env.local` does point at
  production.
- **Step 2** verifies clean on every claim.
- **Step 7's** refusal to retro-add the booking task to anyone already
  `Launched` is right — and more right than the plan knew, since B3 means
  `TERMINAL_CLIENT_TASKS` would never have cleared it.

---

## Suggested resequencing

1. **Decide B4** (booking-task stage placement) — blocks step 1.
2. **Fix S4's root cause** or accept manual intervention — independent of this
   plan, affects every Ruhl customer today. The one-off
   `advanceToLaunchedFromHsActive` re-run for Sara / Bob / Jeramy can happen
   immediately; it is not blocked on step 8.
3. Step 3 (schema) + **S1** (PATCH allowlist) together.
4. Step 2 (payment mode) — independently shippable, verified safe.
5. Step 4 + **S6/S7** (form field, Ruhl gate, no silent default, hydration).
6. Step 5 reworked per **B1/B2** (explicit `cc` at `send-credentials/route.ts:97`)
   and **S2** (logic in `handleTaskCompleted` section 2).
7. Step 1 (template row) — last among the code steps, since it is what arms B4.
8. Step 7 backfill, re-derived live (**S3**).
9. **Drop step 6**, or replace it with whatever B4 resolves to.
10. Step 8 decision, now informed by S4.
