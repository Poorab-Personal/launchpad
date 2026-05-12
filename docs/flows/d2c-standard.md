# D2C Standard — Onboarding Flow

> **Status:** Vetted and approved. This is the source of truth for the D2C Standard workflow.
> If any changes are made to stages, tasks, or dependencies, update this file immediately.
>
> **Implementation note (post-cutover 2026-05-12):** the customer journey here is unchanged. The implementation moved from Airtable to Postgres. Where this doc says "Auto N", read the corresponding port in `src/lib/automations/`:
> - Auto 1 → `generate-tasks.ts` (called inline from `POST /api/customers`)
> - Auto 2 → `activate-dependents.ts` (`handleTaskCompleted`, called from `updateTaskStatus`/`updateTaskFields`)
> - Auto 4 → in `activate-dependents.ts` (Mark Onboarding Call Complete branch)
> - Auto 5/6 (emails) → `trigger-email.ts`
> - Auto 8 (Stripe sub) → `handle-call-completed.ts`
> - Design approval → `design-approval.ts`

## Overview

- **Workflow Key:** `D2C-Standard`
- **Customer Type:** D2C
- **Channel:** Standard (all D2C channels use this flow unless a channel-specific fork is created)
- **Total Tasks:** 17 (from templates) + dynamic revision tasks
- **Stages:** 6 + Done

## Entry Point

HubSpot deal closes → Zapier creates Customer record in Airtable → Auto 1 generates tasks → Customer receives email with portal link.

---

## Stage 1: Getting Started (Stage Order: 1)

| # | Task | Type | Assigned | Status | Depends On | Attach | Notes |
|---|---|---|---|---|---|---|---|
| 1 | Complete Your Onboarding Form | Client | — | Active | — | Form | Multi-step form: business info (name, address, bio, service areas, website, license, topics, hashtags, GMB, MLS IDs, special instructions) + file uploads (logo, headshot, brand assets). All fields write to Customer record. |
| 2 | Create Designs | Team | Designer | Draft | Complete Your Onboarding Form | None | Designer pulls assets and info from Customer record. |
| 3 | Review Designs | Team | Senior Designer | Draft | Create Designs | None | Senior reviews design work. If rejected, adds notes — designer revises and resubmits. |

**Customer experience:**
- Sees one active task: the onboarding form
- After submitting, sees locked "Review & Approve Your Brand Kit" (Stage 2) with message: "Our team is creating your brand kit (2-3 business days). We'll email you when it's ready."
- Gets email notification when proof is ready

---

## Stage 2: Review Your Designs (Stage Order: 2)

| # | Task | Type | Assigned | Status | Depends On | Attach | Notes |
|---|---|---|---|---|---|---|---|
| 4 | Upload Proof to Customer | Team | Designer | Draft | Review Designs | None | Designer uploads approved design files for customer review. |
| 5 | Review & Approve Your Brand Kit | Client | — | Draft | Upload Proof to Customer | Proof | Customer sees proof image, can Approve or Request Changes with feedback. |
| 6 | Schedule Your Onboarding Call | Client | — | Draft | Review & Approve Your Brand Kit | Embed | Calendly embed. Shown immediately after approval so customer books in the same session. |

**Design revision loop (if customer requests changes):**
- Customer.Design Approval → "Changes Requested"
- Customer.Design Feedback → feedback text
- Customer.Design Revision Count → incremented
- If count ≤ 3: automation creates 3 new tasks:
  - "Revise Design (Round N)" → Designer, Active
  - "Review Revision (Round N)" → Senior Designer, depends on Revise Design
  - "Upload Revised Proof (Round N)" → Designer, depends on Review Revision
  - When Upload Revised Proof completes → "Review & Approve Your Brand Kit" reactivates with new proof
- If count > 3: escalate to CSM, no new tasks created
- Customer stays in Stage 2 throughout revision rounds
- All revision tasks are preserved for history/audit

**Customer experience:**
- Sees proof, approves or requests changes
- If changes requested: sees "Revision in progress" message, gets email when new proof is ready
- After approval: immediately sees Calendly embed to book their call

---

## Stage 3: Prepare for Onboarding (Stage Order: 3)

| # | Task | Type | Assigned | Status | Depends On | Attach | Notes |
|---|---|---|---|---|---|---|---|
| 7 | Move Designs to Production | Team | Designer | Draft | Review & Approve Your Brand Kit | None | Runs in parallel with customer booking call. |
| 8 | Create Customer Account | Team | Ops | Draft | Move Designs to Production | None | Due date set by Calendly booking (call date - 2 days). |
| 9 | Send Credentials | Team | Ops | Draft | Create Customer Account | None | Due date set by Calendly booking (call date - 2 days). |
| 10 | Watch Setup Video | Client | — | Draft | Send Credentials | Embed | Loom/video embed. |
| 11 | Sign In & Reset Password | Client | — | Draft | Send Credentials | None | Customer logs into app.rejig.ai. |

**Parallel tracks after design approval:**
- Customer track: Books call (Stage 2, task 6) → waits for credentials → watches video, signs in
- Team track: Move to prod → create account → send credentials
- Both tracks must complete before the onboarding call

**Customer experience:**
- After booking call, sees locked tasks with message: "We're setting up your account. You'll receive your login credentials shortly."
- Gets email when credentials are sent
- Watches video and signs in before their call

**Calendly booking triggers (via Zapier):**
- Customer.Call Date → date from Calendly
- Customer.Call Booked → true
- Customer.CSM Assigned → Team Member matched by Calendly assignee email
- Task "Schedule Your Onboarding Call" → Completed
- Due dates set on Create Customer Account and Send Credentials (call date - 2 days)

---

## Stage 4: Onboarding Call (Stage Order: 4)

| # | Task | Type | Assigned | Status | Depends On | Attach | Notes |
|---|---|---|---|---|---|---|---|
| 12 | Mark Onboarding Call Complete | Team | CSM (specific, from Customer.CSM Assigned) | Draft | — | None | CSM marks complete after call. |

**No-show handling:**
- CSM sets status to "No Show" (not Completed)
- Automation creates "Reschedule Your Onboarding Call" task (Client, Embed)
- Customer.No Show Count incremented
- Customer stays in Stage 4
- Reschedule task activates for customer with Calendly embed

**Customer experience:**
- Portal shows: "Your onboarding call is scheduled for [date]. Join link: [URL]"
- No active tasks to complete — just information display
- If no-show: sees reschedule task

---

## Stage 5: Post Onboarding (Stage Order: 5)

| # | Task | Type | Assigned | Status | Depends On | Attach | Notes |
|---|---|---|---|---|---|---|---|
| 13 | Send Zoom Recording | Team | CSM | Draft | Mark Onboarding Call Complete | None | Due: 1 day after activation. |
| 14 | Send Follow-Up Email | Team | CSM | Draft | Mark Onboarding Call Complete | None | Due: 1 day after activation. Summary of call, outstanding items, next steps. |
| 15 | Provide Onboarding Feedback | Client | — | Draft | Mark Onboarding Call Complete | Form | Standalone — does NOT gate check-ins. Feedback measures CSM performance. |

**Customer experience:**
- Sees one task: feedback form
- Reminder system nudges if not completed (configurable per task)

---

## Stage 6: Review & Grow (Stage Order: 6)

| # | Task | Type | Assigned | Status | Depends On | Attach | Notes |
|---|---|---|---|---|---|---|---|
| 16 | Schedule Check-In 1 | Client | — | Draft | Mark Onboarding Call Complete | Embed | Independent of feedback. May be scheduled during the onboarding call itself. |
| 17 | Schedule Check-In 2 | Client | — | Draft | Schedule Check-In 1 | Embed | — |

**Customer experience:**
- Books check-in calls via Calendly
- After Check-In 2 completes → all tasks done → stage advances to Done

---

## Done

- Customer.Current Stage → "Done"
- Portal shows completion message: "You're all set! Access your account at app.rejig.ai"
- No more tasks, no more reminders

---

## New Schema Fields Required

### Workflow Templates (new fields)
| Field | Type | Purpose |
|---|---|---|
| Reminder After Days | Number | Days before first reminder for stalled tasks |
| Max Reminders | Number | Cap before CSM escalation |
| Due Days After Activation | Number | Auto-set due date when task activates |

### Customers (new fields)
| Field | Type | Purpose |
|---|---|---|
| Call Date | Date (w/ time) | Actual onboarding call date from Calendly |
| Design Revision Count | Number | Tracks revision rounds, caps at 3 |
| No Show Count | Number | Tracks onboarding call no-shows |

---

## Automations (post-cutover state)

All automations live in `src/lib/automations/` as inline TS that runs inside the same request/transaction as the trigger. No external automation engine.

### Built
- **Auto 1 — `generate-tasks.ts`** — New Customer → Generate Tasks from Templates. Atomic with customer insert via `db.transaction`.
- **Auto 2 — `activate-dependents.ts` (`handleTaskCompleted`)** — Task Completed → Activate Dependents + Advance Stage + log events. Race-guarded conditional UPDATE.
- **Auto 4 — `activate-dependents.ts`** — Mark Onboarding Call Complete → set Customer.csm_team_member_id + stamp Check-In Calendly URLs + bridge to Auto 8.
- **Auto 5 — `trigger-email.ts`** — Welcome email on customer create, fire-and-forget after tx commits.
- **Auto 6 — `trigger-email.ts`** — Design Ready email when Review & Approve task activates.
- **Auto 8 — `handle-call-completed.ts`** — Onboarding call completed (Calls.status flips) → create Stripe subscription with trial for setup-intent-at-intake workflows.
- **Design approval — `design-approval.ts`** — `handleDesignApproved` (complete review task, cascade revisions) + `handleDesignChangesRequested` (3-task revision chain in single tx).

### Not yet built
- **No Show automation** — when a CSM marks the Onboarding Call as `No Show`, create a Reschedule task + increment Customer.noShowCount. Currently no-show handling is manual.
- **Stalled-task reminder cron** — Vercel cron scanning Active tasks past their `+3d / +7d / +12d` thresholds; sets `Customer.at_risk` per the payment-mode plan. See `docs/plans/payment-mode-dropoff.md` Phase 2+.

### Retired
- **Auto 3 (In Review Interception)** — was never enabled; design review now flows through the explicit Review Designs task.

---

## Portal UI Requirements

| Scenario | What customer sees |
|---|---|
| Locked task waiting on team work | Lock icon + waiting message + ETA (e.g., "Our team is creating your brand kit. 2-3 business days.") |
| Design revision in progress | "Revision in progress — we'll email you when the updated proof is ready." |
| Onboarding call scheduled | Call date, time, join link (from Customer.Call Date) |
| No active tasks in current stage | Informational display (call details, "account being set up", etc.) |
| All tasks complete | "You're all set! Access your account at app.rejig.ai" |
| Task activated after wait | Email notification sent to customer |

---

## Reminder Configuration (default values)

| Task | Remind After | Max Reminders |
|---|---|---|
| Complete Your Onboarding Form | 3 days | 3 |
| Review & Approve Your Brand Kit | 2 days | 3 |
| Schedule Your Onboarding Call | 2 days | 4 |
| Watch Setup Video | 3 days | 2 |
| Sign In & Reset Password | 3 days | 2 |
| Provide Onboarding Feedback | 5 days | 2 |
| Schedule Check-In 1 | 5 days | 3 |
| Schedule Check-In 2 | 5 days | 3 |
