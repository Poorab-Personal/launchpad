# B2B Keyes — Onboarding Flow

> **Status:** Vetted and approved. This is the source of truth for the B2B-Keyes workflow.
> If any changes are made to stages, tasks, or dependencies, update this file immediately.

## Overview

- **Workflow Key:** `B2B-Keyes`
- **Customer Type:** B2B
- **Channel:** Keyes
- **Total Tasks:** 13 (from templates) + dynamic reschedule tasks
- **Stages:** 5 + Done
- **Key differences from D2C:** No design phase, data pre-populated from roster, includes Stripe trial, CSM assigned at call booking

## Entry Point

```
Agent visits onboarding.rejig.ai/keyes (branded landing page)
  → Enters email
  → System checks email against Roster table (filtered by Keyes brokerage)
  → If NOT found: "Contact your broker admin" error
  → If found + already has Customer Record: redirect to existing portal
  → If found + no Customer Record:
      1. Send verification code to agent's email
      2. Agent enters code
      3. Create Customer record (one-time copy from Roster):
         - Name, Email, Phone, License, Website, Bio, Service Areas,
           MLS IDs, Topics, Hashtags, GMB Name from Roster fields
         - Photo URL → Agent Photo, Logo URL → Business Logo
         - Type = B2B, Channel = Keyes
         - Brokerage = link to Keyes brokerage record
         - Roster Record = link to roster entry
      4. Roster.Onboarding Status → "In Progress"
      5. Roster.Customer Record → link to new Customer
      6. Auto 1 fires → 13 tasks generated from B2B-Keyes templates
      7. Agent redirected to portal (/r/{customer-id})
```

**Key rule:** Roster → Customer is a ONE-TIME COPY. Future roster syncs do not overwrite customer data.

---

## Stage 1: Getting Started (Stage Order: 1)

| # | Task | Type | Assigned | Status | Depends On | Attach | Notes |
|---|---|---|---|---|---|---|---|
| 1 | Confirm Your Information | Client | — | Active | — | Form | Pre-populated from roster copy. Agent reviews, edits if needed, submits. Fields write back to Customer record. |
| 2 | Start Your Trial | Client | — | Draft | Confirm Your Information | Embed | Stripe Checkout. Credit card required. 30-day trial. |
| 3 | Schedule Your Onboarding Call | Client | — | Draft | Start Your Trial | Embed | Calendly embed. No internal work starts until this is done. |

**Why sequential:** We don't invest internal effort (account creation, etc.) until the agent has:
1. Confirmed their info (we have correct data)
2. Started their trial (skin in the game — credit card down)
3. Booked their call (committed to showing up)

**Stripe integration:**

```
Agent clicks "Start Trial" in portal
  → Portal calls POST /api/stripe/checkout
  → API looks up Customer.Brokerage → Brokerages.Stripe Price ID + Trial Days
  → Creates Stripe Checkout Session:
      - Price: from Brokerage config
      - Trial period: from Brokerage config (30 days for Keyes)
      - Customer email: pre-filled
      - success_url: /r/{token}?payment=success
      - cancel_url: /r/{token}?payment=cancelled
      - metadata: { customerId, taskId }
  → Agent redirected to Stripe Checkout page
  → Agent enters credit card, submits
  → Stripe redirects back to portal
  → Stripe fires webhook → POST /api/stripe/webhook
  → Webhook handler:
      - Customer.Stripe Payment ID = subscription ID
      - Customer.Payment Status = "Trial"
      - Task "Start Your Trial" → Completed
  → Auto 2 fires → activates "Schedule Your Onboarding Call"
  → Agent books call in same session
```

**Customer experience:**
- Sees pre-filled form → reviews and submits
- Sees trial signup → enters credit card → redirected back
- Sees Calendly → books call → done with Getting Started
- All in one session, no gaps

---

## Stage 2: Prepare for Onboarding (Stage Order: 2)

| # | Task | Type | Assigned | Status | Depends On | Attach | Notes |
|---|---|---|---|---|---|---|---|
| 4 | Create Customer Account | Team → Ops | Draft | Schedule Your Onboarding Call | None | Only starts AFTER call is booked. Due date: call date - 2 days. |
| 5 | Send Credentials | Team → Ops | Draft | Create Customer Account | None | Due date: call date - 2 days. |
| 6 | Watch Setup Video | Client | — | Draft | Send Credentials | Embed | Loom/video embed. |
| 7 | Sign In & Reset Password | Client | — | Draft | Send Credentials | None | Agent logs into app.rejig.ai. |

**Calendly booking triggers (via Zapier):**
- Customer.Call Date → date from Calendly
- Customer.Call Booked → true
- Customer.CSM Assigned → Team Member matched by Calendly assignee email
- Task "Schedule Your Onboarding Call" → Completed
- Due dates set on "Create Customer Account" and "Send Credentials" (call date - 2 days)

**Customer experience:**
- After booking call, sees locked tasks with message: "We're setting up your account. You'll receive your login credentials shortly."
- Gets email when credentials are sent
- Watches video and signs in before their call

---

## Stage 3: Onboarding Call (Stage Order: 3)

| # | Task | Type | Assigned | Status | Depends On | Attach | Notes |
|---|---|---|---|---|---|---|---|
| 8 | Mark Onboarding Call Complete | Team → CSM (specific) | Draft | — | None | CSM assigned via Calendly round-robin. |

**No-show handling:**
- CSM sets status to "No Show"
- Automation creates "Reschedule Your Onboarding Call" task (Client, Embed)
- Customer.No Show Count incremented
- Customer stays in Stage 3
- Agent sees reschedule task with Calendly embed

**Customer experience:**
- Portal shows: "Your onboarding call is scheduled for [date]. Join link: [URL]"
- No active tasks — informational display
- If no-show: sees reschedule task

---

## Stage 4: Post Onboarding (Stage Order: 4)

| # | Task | Type | Assigned | Status | Depends On | Attach | Notes |
|---|---|---|---|---|---|---|---|
| 9 | Send Zoom Recording | Team → CSM | Draft | Mark Onboarding Call Complete | None | Due: 1 day after activation. |
| 10 | Send Follow-Up Email | Team → CSM | Draft | Mark Onboarding Call Complete | None | Due: 1 day after activation. |
| 11 | Provide Onboarding Feedback | Client, Form | — | Draft | Mark Onboarding Call Complete | Form | Standalone — does not gate check-ins. |

**Customer experience:**
- Sees one task: feedback form
- Reminders nudge if not completed

---

## Stage 5: Review & Grow (Stage Order: 5)

| # | Task | Type | Assigned | Status | Depends On | Attach | Notes |
|---|---|---|---|---|---|---|---|
| 12 | Schedule Check-In 1 | Client | — | Draft | Mark Onboarding Call Complete | Embed | Independent of feedback. |
| 13 | Schedule Check-In 2 | Client | — | Draft | Schedule Check-In 1 | Embed | — |

**Customer experience:**
- Books check-in calls via Calendly
- After Check-In 2 → Done

---

## Done

- Customer.Current Stage → "Done"
- Roster.Onboarding Status → "Completed"
- Portal shows: "You're all set! Access your account at app.rejig.ai"

---

## Schema Requirements

### Brokerages table (new fields)
| Field | Type | Example (Keyes) |
|---|---|---|
| Stripe Price ID | Single line text | `price_abc123` |
| Trial Days | Number | 30 |

### Customers table
Uses existing fields:
- Stripe Payment ID — set by Stripe webhook
- Payment Status — set to "Trial" by webhook
- Call Date, Call Booked, CSM Assigned — set by Calendly/Zapier
- No Show Count — incremented on no-show

### Verification (new, for landing page)
Verification codes are short-lived and don't need a permanent table. Options:
- Store in-memory in the Next.js app (simple, lost on restart)
- Use a lightweight store (Redis, or even a temp Airtable table)
- For PoC: in-memory Map with TTL

---

## Automations

### Existing (shared with D2C)
- **Auto 1:** New Customer → Generate Tasks (uses B2B-Keyes templates)
- **Auto 2:** Task Completed → Activate Dependents + Advance Stage

### To Build (shared with D2C)
- **Auto 4:** Client Task Activated → Email Customer
- **Auto 6:** No Show → Create Reschedule Task
- **Auto 7:** Reminder Scheduler

### Keyes-Specific
- **Stripe webhook handler:** `POST /api/stripe/webhook` — verifies signature, updates Customer + Task
- **No new Airtable automations needed** — Stripe integration is in Next.js code

---

## API Routes Needed

| Route | Purpose |
|---|---|
| `GET /api/brokerage/[slug]` | Landing page: get brokerage config (name, branding) |
| `POST /api/verify-agent` | Email lookup against Roster, send verification code |
| `POST /api/verify-agent/confirm` | Verify code, create Customer from roster copy |
| `POST /api/stripe/checkout` | Create Stripe Checkout Session with brokerage-specific pricing |
| `POST /api/stripe/webhook` | Handle Stripe webhook, update Customer + complete task |

---

## Landing Page UI (`/[slug]`)

```
┌─────────────────────────────────────────┐
│                                         │
│         [Keyes Logo]                    │
│                                         │
│   Welcome to Rejig Onboarding           │
│                                         │
│   Enter your email to get started:      │
│   ┌─────────────────────────────────┐   │
│   │ agent@keyes.com                 │   │
│   └─────────────────────────────────┘   │
│                                         │
│   [ Continue → ]                        │
│                                         │
│   ┌─────────────────────────────────┐   │
│   │ Enter verification code:        │   │
│   │ ┌───┐ ┌───┐ ┌───┐ ┌───┐       │   │
│   │ │ 4 │ │ 7 │ │ 2 │ │ 1 │       │   │
│   │ └───┘ └───┘ └───┘ └───┘       │   │
│   │                                 │   │
│   │ [ Verify & Start Onboarding → ] │   │
│   └─────────────────────────────────┘   │
│                                         │
└─────────────────────────────────────────┘
```

Branded per brokerage — logo, colors pulled from Brokerage record (future: add branding fields).

---

## Reminder Configuration

| Task | Remind After | Max Reminders |
|---|---|---|
| Confirm Your Information | 3 days | 3 |
| Start Your Trial | 2 days | 3 |
| Schedule Your Onboarding Call | 2 days | 4 |
| Watch Setup Video | 3 days | 2 |
| Sign In & Reset Password | 3 days | 2 |
| Provide Onboarding Feedback | 5 days | 2 |
| Schedule Check-In 1 | 5 days | 3 |
| Schedule Check-In 2 | 5 days | 3 |

---

## Differences from D2C-Standard

| Aspect | D2C | Keyes |
|---|---|---|
| Entry point | HubSpot deal → Zapier | Landing page → email verification |
| Data entry | Customer fills blank form | Pre-populated from roster, customer confirms |
| Payment | Before entering system (sales sends Stripe link) | In-portal Stripe trial during onboarding |
| Design phase | Full: create → review → approve/reject loop | None |
| Stages | 6 | 5 |
| Tasks | 17 + revisions | 13 + reschedule |
| CSM assignment | Calendly round-robin at call booking | Same |
