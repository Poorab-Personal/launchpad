# Airtable Automation Setup

These scripts run inside Airtable's built-in automation scripting environment. They are **not** Node.js scripts — paste them directly into Airtable's "Run a script" action editor.

> **Important:** These scripts reference specific table and field names from the production schema. If you rename any tables or fields, update the scripts to match.

---

## Automation 1: New Customer → Generate Tasks

Creates tasks from workflow templates whenever a new customer record is added.

### Setup Steps

1. Go to the **Automations** tab in your Airtable base
2. Click **Create automation**, name it **"New Customer → Generate Tasks"**
3. **Trigger:** "When a record is created" → select **Customers** table
4. **Action:** "Run a script"
5. Add input variables:

   | Variable name | Value (click + to select) |
   |---|---|
   | `recordId` | Record → Airtable record ID |
   | `type` | Record → Type |
   | `channel` | Record → Channel |

6. Paste the contents of **`auto1-generate-tasks.js`**
7. Test with a sample customer, then turn on

### What it does
- Builds workflow key: `{Type}-{Channel}` (e.g., `D2C-Standard`)
- Queries Workflow Templates for matching rows
- Looks up Team Members by Assigned Role for task assignment
- Creates Task records with all template fields (including Stage Order, Has Team Review, Embed URL)
- Sets customer's Current Stage + Stage Entered At
- Logs "Customer Created" event

---

## Automation 2: Task Completed → Activate Dependents & Advance Stage

Activates downstream tasks and advances the customer's stage when tasks are completed.

### Setup Steps

1. Click **Create automation**, name it **"Task Completed → Activate Dependents"**
2. **Trigger:** "When a record matches conditions" → **Tasks** table
3. Condition: **Status** is **"Completed"**
4. **Action:** "Run a script"
5. Add input variables:

   | Variable name | Value (click + to select) |
   |---|---|
   | `taskRecordId` | Record → Airtable record ID |
   | `taskName` | Record → Task Name |
   | `customerRecordId` | Record → Customer → Airtable record ID (first linked record) |
   | `taskStage` | Record → Stage |

6. Paste the contents of **`auto2-activate-dependents.js`**
7. Test by marking a task Completed, then turn on

### What it does
- **Multi-dependency support:** splits Depends On by comma, checks ALL are completed before activating
- Activates dependent tasks (Draft → Active)
- Updates customer flags: "Create Customer Account" → Account Created, "Send Credentials" → Credentials Sent
- Logs Task Completed and Task Activated events
- Checks if all stage tasks are completed → advances to next stage
- On stage advance: activates eligible new-stage tasks (no dependencies, or all cross-stage deps met)
- Logs Stage Changed event

---

## Automation 3: In Review Interception

Prevents Has Team Review tasks from being completed directly — redirects to In Review for senior approval.

### Setup Steps

1. Click **Create automation**, name it **"In Review Interception"**
2. **Trigger:** "When a record matches conditions" → **Tasks** table
3. Conditions (ALL must be true):
   - **Status** is **"Completed"**
   - **Has Team Review** is **checked**
4. **Action:** "Run a script"
5. Add input variables:

   | Variable name | Value (click + to select) |
   |---|---|
   | `taskRecordId` | Record → Airtable record ID |
   | `taskName` | Record → Task Name |
   | `customerRecordId` | Record → Customer → Airtable record ID (first linked record) |

6. Paste the contents of **`auto3-in-review-intercept.js`**
7. Test: set a Has Team Review task to Completed → should redirect to In Review
8. Turn on

### What it does
- When a Has Team Review task is set to Completed, redirects it to "In Review"
- Logs "Task Sent to Review" event
- Senior designer then sets status to Completed (from In Review) to approve — this triggers Automation 2

### Important: Automation Order
**This automation MUST run BEFORE Automation 2.** If Automation 2 fires first on a Completed status, it will activate dependents before the In Review intercept can catch it.

In the Automations tab, drag this automation above "Task Completed → Activate Dependents" to ensure correct execution order. Alternatively, Airtable may handle this by checking conditions — since Auto 3 will change the status from Completed to In Review, Auto 2's condition (Status = Completed) won't match after the redirect.

---

## Automation 5: Onboarding Call Completed → Create Stripe Subscription

Notifies LaunchPad when a Calls record reaches `Status = Completed` for an `Onboarding`-type call. LaunchPad then creates the Stripe trial subscription using the customer's saved card + selected plan.

### Setup Steps

1. Click **Create automation**, name it **"Onboarding Call Completed → Create Sub"**
2. **Trigger:** "When a record matches conditions" → **Calls** table
3. Conditions:
   - **Status** is **"Completed"**
   - **Type** is **"Onboarding"**
4. **Action:** "Run a script"
5. Add input variables:

   | Variable name | Value |
   |---|---|
   | `recordId` | Trigger record → Airtable record ID |
   | `webhookUrl` | Static text: `https://<your-vercel-domain>/api/webhooks/calls/completed` |
   | `webhookSecret` | Static text: matches `AIRTABLE_WEBHOOK_SECRET` in Vercel env |

6. Paste the contents of **`auto5-calls-completed-webhook.js`**
7. Test with a manually-created Calls record (Status=Completed, Type=Onboarding) for a Keyes test customer that has Stripe Customer ID + Selected Stripe Price ID set
8. Turn on

### What it does
- POSTs the Calls record ID to LaunchPad's webhook endpoint
- LaunchPad re-validates state and creates a Stripe subscription with trial period
- Customer record is updated with Stripe Subscription ID + Subscription Status

### Important: switch the webhook URL between dev/prod
The Vercel preview URL changes per branch. The production target is `onboarding.rejig.ai`. When promoting, **update the `webhookUrl` input variable on this automation** (and the `STRIPE_WEBHOOK_SECRET` if applicable for the Stripe webhook). See `docs/plans/payment-mode-dropoff.md` Operational Notes for the full checklist.

---

## Testing Checklist

### D2C Standard Flow
1. **Create a D2C-Standard customer** → 17 tasks generated, stage = "Getting Started"
2. **Check initial state** → "Complete Your Onboarding Form" and "Upload Logos and Headshots" = Active, all others = Draft
3. **Complete both Getting Started client tasks** → "Create Designs" should activate (multi-dependency: both must complete)
4. **Set "Create Designs" to Completed** → should redirect to "In Review" (Has Team Review)
5. **Set "Create Designs" to Completed again (from In Review)** → actually completes, "Upload Proof to Customer" activates
6. **Continue through stages** → verify stage advances and tasks activate correctly

### B2B Keyes Flow
1. **Create a B2B-Keyes customer** → 11 tasks generated, stage = "Getting Started"
2. **All 3 Getting Started tasks are Active** (no dependencies)
3. **Complete all 3** → stage advances to "Prepare for Onboarding", "Create Customer Account" activates

### Customer Flags
- Complete "Create Customer Account" → Customer.Account Created = true
- Complete "Send Credentials" → Customer.Credentials Sent = true

---

## Troubleshooting

- **"No workflow templates found"** — Check Workflow Key matches `{Type}-{Channel}` format (e.g., `D2C-Standard`, not `Standard-D2C`)
- **Tasks not activating** — Depends On field must exactly match Task Name (case-sensitive). For multi-dependency, use comma-space: `"Task A, Task B"`
- **Stage not advancing** — ALL tasks in the stage must be Completed (including team tasks)
- **In Review not firing** — Check Has Team Review is checked on the task. Check automation order (Auto 3 before Auto 2)
- **Input variable errors** — customerRecordId must be the linked record's Airtable record ID, not the display value. Click the Customer field → select "Airtable record ID" (not the name)
