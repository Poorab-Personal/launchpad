# B2B RuhlHomes — Onboarding Flow

**Workflow Key:** `B2B-RUHL`
**Landing page:** `/ruhl`
**Billing:** `invoice` — the brokerage pays; agents never see Stripe
**Template tasks:** 7 (verified live 2026-10-19)

Ruhl began as a `B2B-BW` clone. It has since diverged in one significant way:
**it is the only workflow that forks per agent**, on `customers.service_option`.
Read `README.md` (Fork 5) first; this doc is the detail.

> Pilot history: the first cohort onboarded before the fork existed and is all
> `Self-Managed`. Their service options were backfilled from Ruhl's own planning
> sheet. That sheet is **Ruhl's**, not LaunchPad truth — its "Request Submitted"
> column does not mean our intake was submitted.

---

## Overview

| | |
|---|---|
| Entry | Agent identifies themselves on `/ruhl`, matched against `brokerage_roster` |
| Customer row created | **On landing**, before the form is answered |
| Submission | `Confirm Your Information` → `Completed` (this fires the Slack alert) |
| Design approval | None — designs are brokerage-mandated |
| Payment | None per agent — `payment_mode = 'invoice'` |
| Onboarding call | Yes, for `Self-Managed` only (added 2026-10-18) |
| Terminal stage | `Launched` |

## Stage 1: Getting Started

| Order | Task | Type | Depends on |
|---|---|---|---|
| 1.1 | Confirm Your Information | Client | — |
| 1.2 | Schedule Your Onboarding Call | Client | Confirm Your Information |
| 1.3 | Create Designs | Team (Designer) | Confirm Your Information |

`Confirm Your Information` is where the fork is decided. The intake form shows
"Who will be managing Rejig?" only when `workflowKey === 'B2B-RUHL'`
(`FormTask.tsx`), with two options:

- *I'll manage it myself* → `service_option = 'Self-Managed'`
- *Ruhl Marketing Team* → `service_option = 'Brokerage-Managed'`

The field is **required** for Ruhl and absent everywhere else. It is enforced in
three places: the form's per-step required-field map, the closed-set check in
`PATCH /api/customers/[id]`, and the `service_option` Postgres enum.

On submission, `activate-dependents.ts` branches:

- `Self-Managed` → `Schedule Your Onboarding Call` activates normally.
- `Brokerage-Managed` → that task is immediately auto-`Completed`, so the agent
  never sees a booking step at all.

## Stage 2: Prepare for Onboarding

| Order | Task | Type | Depends on |
|---|---|---|---|
| 2.1 | Create Customer Account | Team (Account Creator) | Create Designs |
| 2.2 | Send Credentials | Team (Account Creator) | Create Customer Account |
| 2.3 | Watch Setup Video | Client | Send Credentials |
| 2.4 | Sign In & Reset Password | Client | Send Credentials |

Note that internal work gates on **Create Designs**, not on the booking task —
so a `Brokerage-Managed` agent whose booking task was auto-closed still flows
through account creation normally.

On `Send Credentials` completing:

- Credentials email goes to the agent, and for `Brokerage-Managed` **also** to
  `brokerages.managed_cc_email` (`marketing@ruhlhomes.com`). Both, not either —
  the agent keeps their own copy.
- `Brokerage-Managed` → `Watch Setup Video` + `Sign In & Reset Password` are
  auto-`Completed` and the customer advances to `Launched`.
- It also re-runs the booking close as a safety net, for rows created before the
  fork shipped.

## Stage 3 (terminal): Launched

`Self-Managed` reaches `Launched` the normal way — the agent signs in, or the
HubSpot ticket flips to `Active` after the onboarding meeting and
`advanceToLaunchedFromHsActive` carries them.

`Brokerage-Managed` reaches `Launched` at Send Credentials, with **no onboarding
call and no agent sign-in**. This is intentional: there is no agent-side work
left to wait for.

---

## Why the tasks are created and then closed

The customer row is created when the agent lands on `/ruhl`, which is **before**
the form that decides the fork is answered. `generate-tasks.ts` therefore cannot
know the service option, and every Ruhl agent gets the full 7-task set.

The alternative — generating tasks at submission instead of landing — would have
meant rewriting entry for all six workflows. Closing tasks after the fact was the
contained change.

Two mechanical rules follow, and getting either wrong is silent:

1. **Close the booking task via `handleTaskCompleted`, not a raw UPDATE.** Stage
   advance only re-evaluates the stage of the task that triggered the run
   (`fresh.filter((t) => t.stage === completedTaskStage)`). The booking task sits
   in a different stage from the trigger, so a raw UPDATE closes the row and
   pins the customer at `Getting Started` forever.
2. **The terminal tasks *are* safe to close with a plain UPDATE**, because they
   share a stage with `Send Credentials`. The outer stage check picks them up and
   carries the customer to `Launched`. Routing these through
   `handleTaskCompleted` would recurse for no benefit.

## Automations

| Trigger | Effect |
|---|---|
| Landing on `/ruhl` | Customer + 7 tasks created atomically (`generate-tasks.ts`) |
| `Confirm Your Information` completed | Slack intake alert; HubSpot Contact + Ticket pushed; booking task closed if `Brokerage-Managed` |
| `Send Credentials` completed | Credentials email (+ `managed_cc_email` when brokerage-managed); terminal tasks closed and `Launched` if brokerage-managed |
| HubSpot ticket → `Active` | `advanceToLaunchedFromHsActive` for self-managed agents |

## Known gaps

- **`onboarding_state` drifts.** LP's own `pushTicketStage` call does not log a
  transition via `applyStateTransition()`, so when LP moves the ticket itself,
  HubSpot is right and LP's mirror stays behind. This stranded the first cohort;
  `scripts/fix-ruhl-stale-onboarding-state.ts` repairs it and **will be needed
  again**. See CLAUDE.md → Known Data Hazards.
- **Reporting treats sign-in as the onboarded signal** for Ruhl
  (`ONBOARDED_RULE` in `monthly-cohort-digest.ts`), because invoice billing gives
  no Stripe signal. For brokerage-managed agents that sign-in is now
  auto-completed, so it attests to credentials being sent rather than to the
  agent actually using the product.
- **Ruhl is excluded from the annual prepay plan** (pilot pricing).

## Scripts

| Script | Purpose |
|---|---|
| `scripts/ruhl-submission-status.ts` | Submitted vs landed-only — the real submission count |
| `scripts/ruhl-launch-service-options.ts` | The launch migration: booking task, invoice mode, service-option backfill |
| `scripts/fix-ruhl-stale-onboarding-state.ts` | Re-sync `onboarding_state` from HubSpot |
| `scripts/backfill-stranded-launched.ts` | Launch customers whose HS ticket is Active but LP never advanced |

Plan + review: `docs/plans/ruhl-service-options.md`, `docs/plans/ruhl-service-options-review.md`.
