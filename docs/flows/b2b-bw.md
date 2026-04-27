# B2B Baird & Warner — Onboarding Flow

> **Status:** Vetted and approved. This is the source of truth for the B2B-BW workflow.
> If any changes are made to stages, tasks, or dependencies, update this file immediately.

## Overview

- **Workflow Key:** `B2B-BW`
- **Customer Type:** B2B
- **Channel:** BW
- **Total Tasks:** 12 (from templates) + dynamic reschedule tasks
- **Stages:** 5 + Done
- **Key difference from Keyes:** No Stripe trial. Agent goes straight from confirming info to booking call.

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

## Stage 3: Onboarding Call (Stage Order: 3)

| # | Task | Type | Assigned | Status | Depends On | Attach | Notes |
|---|---|---|---|---|---|---|---|
| 7 | Mark Onboarding Call Complete | Team → CSM (specific) | Draft | — | None | Same no-show handling as Keyes/D2C. |

---

## Stage 4: Post Onboarding (Stage Order: 4)

| # | Task | Type | Assigned | Status | Depends On | Attach | Notes |
|---|---|---|---|---|---|---|---|
| 8 | Send Zoom Recording | Team → CSM | Draft | Mark Onboarding Call Complete | None | Due: 1 day after. |
| 9 | Send Follow-Up Email | Team → CSM | Draft | Mark Onboarding Call Complete | None | Due: 1 day after. |
| 10 | Provide Onboarding Feedback | Client, Form | — | Draft | Mark Onboarding Call Complete | Form | Standalone. |

---

## Stage 5: Review & Grow (Stage Order: 5)

| # | Task | Type | Assigned | Status | Depends On | Attach | Notes |
|---|---|---|---|---|---|---|---|
| 11 | Schedule Check-In 1 | Client | — | Draft | Mark Onboarding Call Complete | Embed | Independent of feedback. |
| 12 | Schedule Check-In 2 | Client | — | Draft | Schedule Check-In 1 | Embed | |

---

## Done

- Customer.Current Stage → "Done"
- Roster.Onboarding Status → "Completed"
- Portal shows completion message

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
