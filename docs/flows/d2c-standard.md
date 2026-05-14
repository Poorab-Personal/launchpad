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

> **Cross-flow comparison:** See [README.md](./README.md) before reading this doc end-to-end. It captures the forks between this flow and B2B-Keyes / B2B-BW (design-approval gate, parallel vs sequential Prepare-for-Onboarding, payment model, customer record creation source).

## Overview

- **Workflow Key:** `D2C-Standard`
- **Customer Type:** D2C
- **Channel:** Standard (all D2C channels use this flow unless a channel-specific fork is created)
- **Total Tasks:** 11 (from templates, post-Phase-1) + dynamic revision tasks
- **Stages:** 3 + Launched (post-Phase-1: Getting Started → Review Your Designs → Prepare for Onboarding → Launched)
- **Distinctive feature:** Rejig creates custom designs the agent must approve before they can book the onboarding call. After approval, Prepare-for-Onboarding (account creation, credentials, watch video, sign in) runs **in parallel** with the agent scheduling the call.
- **Post-launch lifecycle (2026-05-14):** Once the customer hits `Launched`, all subsequent state (CSM tasks, attention reasons, check-ins) lives in HubSpot. The portal shows a permanent handy page. See `docs/plans/post-launch-migration.md`.

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

### ⚠️ Parallel-track UX caveats (D2C-specific)

Because the customer-side "Schedule Onboarding Call" task (Stage 2) and the team-side Prepare-for-Onboarding chain (Stage 3) both gate on design approval, the customer can end up with **active tasks across two stages at once**:

```
Stage 2 (Review Your Designs):   🟢 Schedule Your Onboarding Call (Client)
Stage 3 (Prepare for Onboarding): 🟢 Watch Setup Video (Client)
                                  🟢 Sign In & Reset Password (Client)
```

The portal's default stage selection currently shows `customer.currentStage`, which advances based on stage-order logic. If `currentStage` is still "Review Your Designs" when the customer gets the "Send Credentials" email, clicking the email link lands them on the Schedule task — not the Watch Video / Sign In tasks they expected.

This is **by design** (parallel tracks are intentional, see above) but the portal UX needs to either (a) auto-advance `currentStage` when Stage 3 customer tasks activate, or (b) deep-link emails to specific tasks rather than the stage default. **Neither is built today.**

B2B flows don't hit this issue because their Prepare-for-Onboarding is sequential — only one stage has active customer tasks at a time.

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

## Stage 4 (terminal): Launched

When both `Watch Setup Video` and `Sign In & Reset Password` (the last two tasks in Stage 3 "Prepare for Onboarding") are Completed, Auto 2's "no next stage" branch sets `Customer.currentStage = 'Launched'` and pushes the HubSpot Ticket from `Pre-Onboarding` → `Onboarding Scheduled` (best-effort).

**The customer's portal switches surface:** `/r/[token]` now renders `<PortalHandyPage>` instead of the task list. The handy page is a permanent home base with:
- Link to the product (app.rejig.ai)
- "Book a support session" (HubSpot Meetings round-robin link — separate from the onboarding meeting page, has 15/30/45-min slot options)
- Email support link
- Account summary (sign-in email, business name, onboarding date)

**No more LaunchPad tasks after Launched.** Post-launch lifecycle (CSM follow-ups, check-ins, attention-state management) lives entirely in HubSpot:
- HubSpot Workflow A: Meeting outcome `Completed` → Ticket → `Active`
- HubSpot Workflow B: Meeting outcome `No-show` → Ticket → `Pre-Onboarding` + email cadence
- HubSpot Workflow C: Meeting outcome `Partial` → similar
- HubSpot Workflows F + G: handle meeting-scheduled transitions + auto-create CSM tasks
- (Future) BI cron in LaunchPad writes to HubSpot ticket stage + attention reason from usage signals

**No-show handling now in HubSpot.** If the customer no-shows on their onboarding meeting, HS Workflow B handles email cadence + eventual escalation to `Watch` stage. LaunchPad doesn't track no-show count on its own anymore.

---

## Deleted in Phase 1 (2026-05-14)

These tasks/stages USED to exist but were removed by migration `0006_post_launch_truncate.sql`:

- Stage 4 (Onboarding Call) and its task `Mark Onboarding Call Complete`
- Stage 5 (Post Onboarding): `Send Zoom Recording`, `Send Follow-Up Email`, `Provide Onboarding Feedback`
- Stage 6 (Review & Grow): `Schedule Check-In 1`, `Schedule Check-In 2`

Their responsibilities moved to HubSpot. See `docs/plans/post-launch-migration.md` Phase 1.

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
