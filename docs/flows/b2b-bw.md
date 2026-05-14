# B2B Baird & Warner — Onboarding Flow

> **Status:** Vetted and approved. This is the source of truth for the B2B-BW workflow.
> If any changes are made to stages, tasks, or dependencies, update this file immediately.
>
> **Implementation note (post-cutover 2026-05-12):** the customer journey here is unchanged. The implementation moved from Airtable to Postgres. "Auto N" references in this doc map to `src/lib/automations/`:
> - Auto 1 → `generate-tasks.ts` · Auto 2 → `activate-dependents.ts` · Auto 4 → in `activate-dependents.ts` (Mark Onboarding Call Complete branch) · Auto 5/6 emails → `trigger-email.ts` · Design approval (n/a for B2B-BW — no design phase).
>
> B2B-BW has **no Stripe trial** in the customer-facing flow, but Auto 8 (`handle-call-completed.ts`) still runs on call completion if the workflow template specifies `setup-intent-at-intake`. Today B2B-BW does not.

> **Cross-flow comparison:** See [README.md](./README.md) before reading this doc end-to-end. It captures the forks between this flow and D2C-Standard / B2B-Keyes (design-approval gate, parallel vs sequential Prepare-for-Onboarding, payment model, customer record creation source).

## Overview

- **Workflow Key:** `B2B-BW`
- **Customer Type:** B2B
- **Channel:** BW
- **Total Tasks:** 7 (from templates, post-Phase-1) + dynamic reschedule tasks
- **Stages:** 2 + Launched (post-Phase-1: Getting Started → Prepare for Onboarding → Launched)
- **Key differences from D2C:** No design phase (broker mandates the design), data pre-populated from roster, no payment of any kind (brokerage master agreement), Prepare-for-Onboarding runs **sequentially after** the call is booked (D2C is parallel).
- **Key difference from Keyes:** No Stripe trial. Agent goes straight from confirming info to booking call. No Stripe subscription creation at Ticket → Active (the LP ticket-stage webhook is a no-op for B2B-BW since `paymentMode='none'`).
- **Post-launch lifecycle (2026-05-14):** Once the customer hits `Launched`, all subsequent state lives in HubSpot — see `docs/plans/post-launch-migration.md`.

## Entry Point

Identical to Keyes — see `docs/flows/b2b-keyes.md` for full entry point documentation.

```
Agent visits onboarding.rejig.ai/bw
  → Email verification against Roster (Baird & Warner brokerage)
  → Customer record created from roster copy
  → Auto 1 fires → 12 tasks generated from B2B-BW templates
  → Agent redirected to portal
```

---

## Stage 1: Getting Started (Stage Order: 1)

| # | Task | Type | Assigned | Status | Depends On | Attach | Notes |
|---|---|---|---|---|---|---|---|
| 1 | Confirm Your Information | Client | — | Active | — | Form | Pre-populated from roster. Agent reviews and submits. |
| 2 | Schedule Your Onboarding Call | Client | — | Draft | Confirm Your Information | Embed | Calendly embed. No trial required for B&W. |

**No Stripe step.** B&W agents don't pay — the brokerage has a master deal. Agent confirms info → books call → done with Getting Started.

The Brokerages table for B&W has no `Stripe Price ID` set — the system skips the trial task entirely because it's not in the B2B-BW workflow templates.

**Customer experience:**
- Sees pre-filled form → reviews and submits
- Sees Calendly → books call
- Two steps, done in one session

---

## Stage 2: Prepare for Onboarding (Stage Order: 2)

| # | Task | Type | Assigned | Status | Depends On | Attach | Notes |
|---|---|---|---|---|---|---|---|
| 3 | Create Customer Account | Team → Ops | Draft | Schedule Your Onboarding Call | None | Starts after call is booked. Due: call date - 2 days. |
| 4 | Send Credentials | Team → Ops | Draft | Create Customer Account | None | Due: call date - 2 days. |
| 5 | Watch Setup Video | Client | — | Draft | Send Credentials | Embed | |
| 6 | Sign In & Reset Password | Client | — | Draft | Send Credentials | None | |

Identical to Keyes Stage 2.

---

## Stage 3 (terminal): Launched

Identical to Keyes — see `b2b-keyes.md` "Stage 3: Launched" — except B&W doesn't trigger Stripe subscription creation at Ticket → Active (no trial, no subscription needed).

---

## Deleted in Phase 1 (2026-05-14)

These tasks/stages USED to exist but were removed by migration `0006_post_launch_truncate.sql`:

- Stage 3 (Onboarding Call) and its task `Mark Onboarding Call Complete`
- Stage 4 (Post Onboarding): `Send Zoom Recording`, `Send Follow-Up Email`, `Provide Onboarding Feedback`
- Stage 5 (Review & Grow): `Schedule Check-In 1`, `Schedule Check-In 2`

Their responsibilities moved to HubSpot. See `docs/plans/post-launch-migration.md` Phase 1.

---

## Differences from Keyes

| Aspect | Keyes | B&W |
|---|---|---|
| Trial | Stripe trial (credit card, 30 days) | No trial — brokerage master deal |
| Getting Started tasks | 3 (confirm → trial → book call) | 2 (confirm → book call) |
| Total tasks | 13 | 12 |
| Stripe integration | Required | Not needed |
| Brokerage.Stripe Price ID | Set | Empty |
| Everything else | Identical | Identical |

---

## Automations

All shared with Keyes and D2C — no B&W-specific automations needed.

---

## Reminder Configuration

| Task | Remind After | Max Reminders |
|---|---|---|
| Confirm Your Information | 3 days | 3 |
| Schedule Your Onboarding Call | 2 days | 4 |
| Watch Setup Video | 3 days | 2 |
| Sign In & Reset Password | 3 days | 2 |
| Provide Onboarding Feedback | 5 days | 2 |
| Schedule Check-In 1 | 5 days | 3 |
| Schedule Check-In 2 | 5 days | 3 |
