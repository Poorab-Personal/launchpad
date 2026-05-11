# Airtable Automations

These scripts run inside Airtable's built-in automation scripting environment. They are **not** Node.js scripts — paste them directly into Airtable's "Run a script" action editor.

> **Important:** These scripts reference specific table and field names from the production schema. If you rename any tables or fields, update the scripts to match.

## Current automation lineup

| Airtable name | File | Status |
|---|---|---|
| Auto 1 — Generate Tasks | `auto1-generate-tasks.js` | ON |
| Auto 2 — Activate Dependents | `auto2-activate-dependents.js` | ON |
| Auto 3 — In Review Interception | `auto3-in-review-intercept.js` | OFF |
| Auto 4 — Set CSM + Check-In Links | `auto4-call-complete.js` | ON |
| Auto 5 — Email: Welcome | `auto5-7-email-send.js` (shared) | ON |
| Auto 6 — Email: Design Ready | `auto5-7-email-send.js` (shared) | ON |
| Auto 7 — Email: Credentials Sent | `auto5-7-email-send.js` (shared) | **PAUSED — obsolete, see note below** |
| Auto 8 — Stripe Sub Creation | `auto8-stripe-sub-creation.js` | **NOT YET CREATED — see Auto 8 below** |

---

## Auto 1 — New Customer → Generate Tasks

Creates tasks from workflow templates whenever a new customer record is added.

**Trigger:** When a record is created → **Customers** table

**Input variables:**

| Name | Value |
|---|---|
| `recordId` | Record → Airtable record ID |
| `type` | Record → Type |
| `channel` | Record → Channel |
| `firstName` | Record → First Name (optional, for HubSpot path) |
| `lastName` | Record → Last Name (optional) |
| `dealId` | Record → HubSpot Deal ID (optional) |
| `hasVoice` | Record → Has Voice |
| `hasAvatar` | Record → Has Avatar |

**Script:** `auto1-generate-tasks.js`

What it does: builds workflow key `{Type}-{Channel}`, queries Workflow Templates, looks up Team Members by Assigned Role, creates Task records, sets Current Stage + Stage Entered At, links the Customer to the Production Settings row, and resolves the onboarding Calendly URL (Brokerage default → Settings default fallback) onto the Schedule Your Onboarding Call task.

---

## Auto 2 — Task Completed → Activate Dependents & Advance Stage

Activates downstream tasks and advances the customer's stage when tasks are completed.

**Trigger:** When record matches conditions → **Tasks** table → `Status = Completed`

**Input variables:**

| Name | Value |
|---|---|
| `taskRecordId` | Record → Airtable record ID |
| `taskName` | Record → Task Name |
| `customerRecordId` | Record → Customer → Airtable record ID (first linked record) |
| `taskStage` | Record → Stage |

**Script:** `auto2-activate-dependents.js`

What it does: splits Depends On by comma, checks ALL listed prerequisites are completed, activates dependent tasks (Draft → Active, sets Activated At), updates customer flags (Account Created / Credentials Sent), checks if all stage tasks are completed → advances stage, logs Task Completed / Task Activated / Stage Changed events.

---

## Auto 3 — In Review Interception (currently OFF)

Prevents `Has Team Review` tasks from completing directly — redirects them to In Review for senior approval.

**Trigger:** When record matches conditions → **Tasks** table → `Status = Completed AND Has Team Review = true`

**Input variables:**

| Name | Value |
|---|---|
| `taskRecordId` | Record → Airtable record ID |
| `taskName` | Record → Task Name |
| `customerRecordId` | Record → Customer → Airtable record ID |

**Script:** `auto3-in-review-intercept.js`

> Currently OFF in production. The Senior Designer review loop is now handled in-app via `ReviewDesignsAction` + `/api/workspace/design-review-reject` (see Plan section in `docs/plans/payment-mode-dropoff.md`). Re-enable only if you bring back the in-Airtable review flow.

> **Order matters when ON:** must run BEFORE Auto 2 so the status flips to In Review before Auto 2's "Status = Completed" condition matches.

---

## Auto 4 — Mark Onboarding Call Complete → Set CSM + Check-In Links

When the CSM marks the Onboarding Call complete, sets `Customer.CSM Assigned` to whoever completed the task and writes their personal Calendly URL onto the Schedule Check-In 1 / 2 tasks.

**Trigger:** When record matches conditions → **Tasks** table → `Task Name = "Mark Onboarding Call Complete" AND Status = "Completed"`

**Input variables:**

| Name | Value |
|---|---|
| `taskRecordId` | Record → Airtable record ID |
| `customerRecordId` | Record → Customer → Airtable record ID |

**Script:** `auto4-call-complete.js`

What it does: pulls the assignee from the completed task (the CSM who actually ran the call — may differ from the default CSM via Calendly host re-routing), updates Customer.CSM Assigned, looks up that CSM's personal Calendly URL from Team Members, and stamps it onto Schedule Check-In 1 / 2.

---

## Auto 5 / 6 / 7 — Customer Emails (shared script)

Three separate Airtable automations using the same script body — different trigger + different `template` input.

**Script:** `auto5-7-email-send.js` (paste the same content into all three "Run a script" actions)

| # | Airtable name | Trigger | `template` value |
|---|---|---|---|
| 5 | Auto 5 — Email: Welcome | When a Customers record is created | `welcome` |
| 6 | Auto 6 — Email: Design Ready | When a Tasks record matches: `Task Name = "Review & Approve Your Brand Kit" AND Status = "Active"` | `design-ready` |
| 7 | Auto 7 — Email: Credentials Sent | (paused — see note) | `credentials-sent` |

**Common input variables on each:**

| Name | Value |
|---|---|
| `customerId` | Trigger record → Airtable record ID (Auto 5) **or** Trigger record → Customer (linked) → Airtable record ID (Auto 6/7) |
| `template` | Static text — value from the table above |

What it does: POSTs `{ template, customerId }` to LaunchPad's `/api/email/send`. LaunchPad fetches the customer, renders the React Email template, and sends via Resend.

> **Auto 7 is obsolete and should be deleted.** Credentials emails are now sent server-side from `SendCredentialsAction` (Account Creator hits Send → `/api/workspace/send-credentials` → Resend). The Airtable trigger duplicates work and could double-send.

---

## Auto 8 — Onboarding Call Completed → Create Stripe Subscription

**STATUS: NOT YET CREATED IN AIRTABLE.** Add this when you're ready to test/run the B2B-Keyes payment flow end-to-end.

**Trigger:** When record matches conditions → **Calls** table → `Status = "Completed" AND Type = "Onboarding"`

**Input variables:**

| Name | Value |
|---|---|
| `recordId` | Trigger record → Airtable record ID |
| `webhookUrl` | Static text: `https://launchpad-indol-ten.vercel.app/api/webhooks/calls/completed` |
| `webhookSecret` | Static text: matches `AIRTABLE_WEBHOOK_SECRET` in Vercel env (generate with `openssl rand -hex 32`) |

**Script:** `auto8-stripe-sub-creation.js`

What it does: POSTs the Calls record ID + Bearer secret to the LaunchPad webhook. LaunchPad re-validates the call state, then creates the Stripe subscription (with workflow trial days) using the customer's saved card. Writes back `Stripe Subscription ID` + `Subscription Status`.

Idempotent — re-runs are safe (the endpoint no-ops if a sub already exists).

---

## Troubleshooting

- **"No workflow templates found"** — Check Workflow Key matches `{Type}-{Channel}` (e.g., `D2C-Standard`, not `Standard-D2C`).
- **Tasks not activating** — Depends On must exactly match Task Name (case-sensitive). For multi-dependency, comma-space: `"Task A, Task B"`.
- **Stage not advancing** — ALL tasks in the stage must be Completed (including team tasks).
- **Auto 8 returns 401** — `webhookSecret` and Vercel `AIRTABLE_WEBHOOK_SECRET` don't match. Re-paste both sides.
- **Email automation fails with "No Portal Base URL"** — the Settings.Production row is missing or the Portal Base URL field is empty. Open the Settings table and check.
- **Input variable errors** — `customerRecordId` must be the linked record's Airtable record ID, not the display value. Click the Customer field → select "Airtable record ID" (not Name).
