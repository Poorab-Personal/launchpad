# LaunchPad — Production Airtable Schema

## Data Model

```
Customer Type
├── D2C
│   └── Channel: Direct Sales, Paid Marketing, Webinar, Referral, ...
│   └── Workflow Key: D2C-Standard (all channels share this for now)
└── B2B
    └── Channel (= Brokerage): Keyes, B&W, ...
    └── Workflow Key: B2B-Keyes, B2B-BW, ...
```

Workflow Key = `{Type}-{Channel}` — determines which template rows generate tasks.
All D2C channels currently map to `D2C-Standard`. When a channel needs its own flow, add new template rows (e.g., `D2C-Webinar`).

---

## Table 1: Customers

One row per customer/agent being onboarded. Fields are populated in stages:
- **At creation** (HubSpot → Zapier for D2C, or agent raises hand for B2B): name, email, phone, deal IDs, payment info
- **During intake** (customer fills portal form): business info, bio, service areas, etc.
- **During onboarding** (uploads, automations): assets, stage tracking, flags

| Field Name | Type | Set By | Notes |
|---|---|---|---|
| **Identity** | | | |
| Name | Single line text | Zapier / Roster copy | Primary field |
| Type | Single select | System | `D2C`, `B2B` |
| Channel | Single line text | System | D2C: `Direct Sales`, `Paid Marketing`, `Webinar`, `Referral`. B2B: brokerage name from Brokerage record |
| Workflow Key | Formula | Auto | `{Type} & "-" & {Channel}` |
| Contact Email | Email | Zapier / Roster copy | Primary communication email |
| Platform Email | Email | Customer (intake) | Email for app.rejig.ai login — may differ from contact email |
| Phone | Phone number | Zapier / Roster copy | |
| **Business Info** (populated via intake form or roster copy) | | | |
| Business Name | Single line text | Customer / Roster copy | |
| Business Address | Long text | Customer | |
| Website | URL | Customer / Roster copy | |
| Service Areas | Long text | Customer / Roster copy | Comma-separated or multi-line |
| Bio | Long text | Customer / Roster copy | Agent/business bio |
| License Number | Single line text | Customer / Roster copy | |
| Topics | Long text | Customer / Roster copy | Account-level content topics |
| Hashtags | Single line text | Customer / Roster copy | Preferred hashtags |
| GMB Name | Single line text | Customer / Roster copy | Google My Business name |
| MLS IDs | Long text | Customer / Roster copy | JSON or comma-separated |
| Special Instructions | Long text | Customer | Notes for design team |
| **Assets** (populated via upload task) | | | |
| Agent Photo | Attachment | Customer | Photo file — designer downloads from here |
| Business Logo | Attachment | Customer | Logo file |
| Other Assets | Attachment | Customer | Additional brand assets |
| **Payment & Deal** (D2C only) | | | |
| HubSpot Deal ID | Single line text | Zapier | Primary key for D2C identity |
| Stripe Payment ID | Single line text | Zapier | |
| Add-On Stripe Payment ID | Single line text | Zapier | D2C with add-ons (Voice, Avatar) |
| Product Tier | Single select | Zapier | `Premium`, `Luxury` |
| Payment Status | Single select | Zapier | `Paid`, `Waived` |
| **Enterprise** (B2B only) | | | |
| Brokerage | Link to Brokerages | System | Links to brokerage config record |
| Roster Record | Link to Roster | System | Links to source roster record (one-time copy, not live sync) |
| **Assignment** | | | |
| CSM Assigned | Link to Team Members | System / Manual | Linked record — pull CSM email, Slack handle from Team Members |
| **Design Workflow** (D2C only) | | | |
| Design Approval | Single select | Customer (portal) | `Pending`, `Approved`, `Changes Requested` — customer's approval |
| Design Feedback | Long text | Customer | Feedback text when requesting changes |
| **Status Tracking** | | | |
| Current Stage | Single line text | Automation | Set by automation on creation + stage advancement |
| Stage Entered At | Date (w/ time) | Automation | |
| Account Created | Checkbox | Automation | Set when "Create Customer Account" task completes |
| Credentials Sent | Checkbox | Automation | Set when "Send Credentials" task completes |
| Call Booked | Checkbox | Calendly / Zapier | Set when Calendly booking confirmed |
| Call Completed | Checkbox | CSM | Checked after onboarding call |
| Reminder Count | Number (integer) | Automation | Tracks reminders sent, max 3 before escalation |
| **System** | | | |
| Access Token | Formula | Auto | `RECORD_ID()` — portal URL token |
| Tasks | Link to Tasks | Auto | Reverse link |
| Events | Link to Events | Auto | Reverse link |
| Created At | Created time | Auto | |
| Last Modified | Last modified time | Auto | |

---

## Table 2: Tasks

All tasks per customer — both client-facing and internal.

| Field Name | Type | Notes |
|---|---|---|
| Task Name | Single line text | Primary field |
| Customer | Link to Customers | Each task belongs to one customer |
| Task Type | Single select | `Client`, `Team` |
| Stage | Single line text | Stage this task belongs to |
| Status | Single select | `Draft`, `Active`, `In Review`, `Completed`, `Rejected` |
| Task Order | Number (integer) | Display order within a stage |
| Assigned To | Link to Team Members | Who is working on this. Blank for client tasks |
| Visible To Client | Checkbox | If true, customer sees this in the portal |
| Depends On | Single line text | Comma-separated task names that must ALL complete before this activates. Blank = no dependency |
| Has Team Review | Checkbox | If true, task goes to `In Review` before `Completed`. Senior must approve |
| Attachment Type | Single select | `None`, `Form`, `File Upload`, `Embed`, `Proof` |
| Embed URL | URL | Calendly link, Loom video URL, etc. Populated from template |
| Instructions | Long text | Shown to assignee (team) or customer (client) |
| Tags | Multiple select | `Design Change`, `Dev Request`, `Priority`, `Follow Up` |
| Notes | Long text | Internal notes |
| Due Date | Date | Optional |
| Completed At | Date (w/ time) | Set by automation when Status → Completed |
| Created At | Created time | Auto |

### Status Flow

```
Draft → Active → Completed                   (normal task)
Draft → Active → In Review → Completed       (team task with Has Team Review)
Draft → Active → In Review → Rejected → Active → In Review → ...  (revision loop)
```

- **Draft**: waiting for dependencies
- **Active**: ready to work on / visible to customer
- **In Review**: junior done, waiting for senior approval
- **Completed**: done
- **Rejected**: senior sent back for revisions → resets to Active

---

## Table 3: Workflow Templates

Blueprint rows. NOT runtime data. One set of rows per workflow key.

| Field Name | Type | Notes |
|---|---|---|
| Template Row ID | Autonumber | Primary field |
| Workflow Key | Single line text | `D2C-Standard`, `B2B-Keyes`, `B2B-BW`, etc. |
| Stage | Single line text | Stage name |
| Stage Order | Number (integer) | Stage sequence: 1, 2, 3... |
| Task Title | Single line text | Title of task to create |
| Task Type | Single select | `Client`, `Team` |
| Task Order | Number (integer) | Order within stage: 1, 2, 3... |
| Visible To Client | Checkbox | |
| Assigned Role | Single select | `Designer`, `Senior Designer`, `CSM`, `Onboarding Ops` — used to look up Team Member at task creation |
| Initial Status | Single select | `Active`, `Draft` |
| Depends On | Single line text | Comma-separated task titles. Blank = no dependency |
| Has Team Review | Checkbox | |
| Attachment Type | Single select | `None`, `Form`, `File Upload`, `Embed`, `Proof` |
| Embed URL | URL | Default URL for embeds (Calendly, Loom). Copied to task on creation |
| Instructions | Long text | Default instructions |

---

## Table 4: Roster

Broker agent data synced from external roster APIs. Enterprise only.

**Key rule: Roster → Customer is a ONE-TIME COPY, not a live sync.**
When an agent raises their hand, data is copied from Roster to a new Customer record.
After that, the Customer record is independent. Roster syncs do NOT overwrite customer data.

| Field Name | Type | Notes |
|---|---|---|
| Email | Email | Primary field. Unique per agent |
| Brokerage | Link to Brokerages | Which brokerage this agent belongs to |
| Agent Name | Single line text | |
| Phone | Phone number | |
| License Number | Single line text | |
| Website | URL | |
| Photo URL | URL | Hosted URL from roster API |
| Logo URL | URL | Hosted URL from roster API |
| Bio | Long text | |
| Service Areas | Long text | |
| MLS IDs | Long text | |
| Topics | Long text | |
| Hashtags | Single line text | |
| GMB Name | Single line text | |
| Other Emails | Long text | Additional emails (CC on design sends) |
| Onboarding Status | Single select | `Not Started`, `In Progress`, `Completed` |
| Customer Record | Link to Customers | Set when customer record is created from this roster entry |
| Synced At | Date (w/ time) | Last roster API sync |

---

## Table 5: Events

Audit log. Every state change gets logged.

| Field Name | Type | Notes |
|---|---|---|
| Event ID | Autonumber | Primary field |
| Customer | Link to Customers | |
| Event Type | Single select | See list below |
| Actor | Link to Team Members | Who performed the action (null for customer/system actions) |
| Actor Type | Single select | `Customer`, `Team Member`, `System` |
| Details | Long text | Free-text description |
| Related Task | Link to Tasks | Optional |
| Created At | Created time | Auto |

**Event Types:**
`Customer Created`, `Stage Changed`, `Task Created`, `Task Activated`, `Task Completed`, `Task Rejected`, `Task Sent to Review`, `Design Uploaded`, `Design Approved`, `Design Changes Requested`, `Call Booked`, `Call Completed`, `Reminder Sent`, `Note Added`, `Credentials Sent`, `Account Created`

---

## Table 6: Team Members

Internal team members who work on onboarding tasks.

| Field Name | Type | Notes |
|---|---|---|
| Name | Single line text | Primary field |
| Email | Email | For notifications, automations |
| Slack Handle | Single line text | For Slack notifications (e.g., `@mario`) |
| Role | Single select | `Designer`, `Senior Designer`, `CSM`, `Onboarding Ops`, `Admin` |
| Active | Checkbox | Whether this team member is currently active |
| Assigned Customers | Link to Customers | Reverse link from Customer.CSM Assigned |
| Assigned Tasks | Link to Tasks | Reverse link from Task.Assigned To |
| Created At | Created time | Auto |

---

## Table 7: Brokerages

Brokerage-level configuration for B2B/enterprise customers.

| Field Name | Type | Notes |
|---|---|---|
| Name | Single line text | Primary field. `Keyes`, `Baird & Warner`, etc. |
| Landing Page Slug | Single line text | URL slug for brokerage landing page (e.g., `keyes` → `onboarding.rejig.ai/keyes`) |
| Default Workflow Key | Single line text | Which workflow template to use (e.g., `B2B-Keyes`) |
| Roster API URL | URL | Endpoint to sync agent roster data |
| Roster API Key | Single line text | API key/token for roster sync (sensitive — restrict access) |
| Roster Refresh Interval | Single line text | How often to sync roster (e.g., `daily`, `weekly`, `6h`) |
| Last Roster Sync | Date (w/ time) | Timestamp of last successful roster sync |
| Billing Contact | Email | Brokerage billing contact |
| Notes | Long text | Deal-specific notes, special arrangements |
| Roster Records | Link to Roster | Reverse link — all agents in this brokerage's roster |
| Customers | Link to Customers | Reverse link — all customers from this brokerage |
| Active | Checkbox | Whether this brokerage is currently active |
| Created At | Created time | Auto |

---

## Table 8: Calls

One row per scheduled (or ad-hoc) CSM ↔ customer call. Replaces the legacy
single-field `Customer.Call Date`, which got clobbered by every Schedule
task. Calls table is upserted by the Calendly webhook (idempotent on
Calendly Event UUID) and surfaced in the CSM workspace.

The legacy `Customer.Call Date` / `Call Booked` / `Call Completed` /
`No Show Count` fields remain on Customers for backwards compat with the
customer portal — the webhook still writes Call Date + Call Booked for
Onboarding-type calls only.

| Field Name | Type | Notes |
|---|---|---|
| Title | Single line text | Primary field. Free-form; webhook stamps `"<Type> — <Customer Name>"` |
| Customer | Link to Customers | Required |
| Type | Single select | `Onboarding`, `Check-In 1`, `Check-In 2`, `Ad-hoc` |
| Scheduled Date | Date (w/ time) | Event start time |
| Status | Single select | `Scheduled`, `Completed`, `No Show`, `Rescheduled`, `Canceled` |
| CSM | Link to Team Members | The CSM owning this call |
| Notes | Long text | Free-form CSM notes |
| Recording URL | URL | Zoom/Loom link (optional) |
| Calendly Event UUID | Single line text | Idempotency key — last segment of Calendly event URI |

Setup: `npx tsx scripts/setup-calls-table.ts` (idempotent).

---

## Enterprise Agent Onboarding Flow

```
Roster API syncs periodically → Roster table updated (per Brokerage.Roster Refresh Interval)
  ↓ (roster data stays in Roster table, does NOT touch existing Customer records)

Agent visits onboarding.rejig.ai/{brokerage-slug}
  → Enters their email
  → System checks email against Roster table (filtered by Brokerage)
  → If NOT found: "Contact your broker admin" error
  → If found + already has Customer Record: redirect to existing portal
  → If found + no Customer Record yet:
      1. Create Customer record
      2. Copy fields from Roster → Customer (one-time copy):
         Name, Email, Phone, License, Website, Bio, Service Areas,
         MLS IDs, Topics, Hashtags, GMB Name, Photo URL → Agent Photo,
         Logo URL → Business Logo
      3. Set Customer.Type = B2B
      4. Set Customer.Channel = Brokerage name
      5. Set Customer.Brokerage = link to Brokerage record
      6. Set Customer.Roster Record = link to Roster record
      7. Set Roster.Onboarding Status = In Progress
      8. Set Roster.Customer Record = link to new Customer
      9. Workflow Key formula computes → tasks auto-generate
      10. Agent sees portal with pre-populated "Confirm Your Information" form
```

---

## Workflow Template Data

### D2C-Standard (17 tasks, 6 stages)

| Stage | SO | Task Title | Type | TO | Vis | Assigned | Status | Depends On | Review | Attach | Instructions |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Getting Started | 1 | Complete Your Onboarding Form | Client | 1 | ✓ | | Active | | | Form | Please complete this form so our team can get started on your brand kit. |
| Getting Started | 1 | Upload Logos and Headshots | Client | 2 | ✓ | | Active | | | File Upload | Upload your logo files (PNG/SVG preferred), professional headshots, and any brand assets. |
| Getting Started | 1 | Create Designs | Team | 3 | Designer | Draft | Complete Your Onboarding Form, Upload Logos and Headshots | ✓ | None | Pull assets from client submissions. Create brand kit using uploaded logos, headshots, and bio. |
| Review Your Designs | 2 | Upload Proof to Customer | Team | 1 | | Designer | Draft | Create Designs | | None | Upload the approved design files to the client review task. |
| Review Your Designs | 2 | Review & Approve Your Brand Kit | Client | 2 | ✓ | | Draft | Upload Proof to Customer | | Proof | Review your brand kit. Approve if correct, or request changes. |
| Book Your Call | 3 | Move Designs to Production | Team | 1 | | Designer | Draft | | | None | Move approved design assets to the production environment. |
| Book Your Call | 3 | Create Customer Account | Team | 2 | | Onboarding Ops | Draft | Move Designs to Production | | None | Create the customer's app.rejig.ai account using their Platform Email. |
| Book Your Call | 3 | Send Credentials | Team | 3 | | Onboarding Ops | Draft | Create Customer Account | | None | Send login credentials to the customer. |
| Book Your Call | 3 | Schedule Your Onboarding Call | Client | 4 | ✓ | | Draft | Send Credentials | | Embed | Book your onboarding call at a time that works for you. |
| Prepare for Onboarding | 4 | Watch Setup Video | Client | 1 | ✓ | | Draft | Send Credentials | | Embed | Watch this short video to learn how to connect and configure your service areas. |
| Prepare for Onboarding | 4 | Sign In & Reset Password | Client | 2 | ✓ | | Draft | Send Credentials | | None | Log in to app.rejig.ai using the credentials we sent and reset your password. |
| Prepare for Onboarding | 4 | Mark Onboarding Call Complete | Team | 3 | | CSM | Draft | | | None | Mark complete after the onboarding call. If no-show or rescheduled, add a comment. |
| Post Onboarding Follow Ups | 5 | Send Zoom Recording | Team | 1 | | CSM | Draft | | | None | Upload or send the onboarding call Zoom recording to the customer. |
| Post Onboarding Follow Ups | 5 | Send Follow-Up Email | Team | 2 | | CSM | Draft | | | None | Send summary of what was covered, outstanding items, and next steps. |
| Review & Grow | 6 | Provide Onboarding Feedback | Client | 1 | ✓ | | Draft | | | Form | We'd love your feedback on the onboarding experience. |
| Review & Grow | 6 | Schedule Check-In 1 | Client | 2 | ✓ | | Draft | Provide Onboarding Feedback | | Embed | Schedule your first check-in call. |
| Review & Grow | 6 | Schedule Check-In 2 | Client | 3 | ✓ | | Draft | Schedule Check-In 1 | | Embed | Schedule your second check-in call. |

### B2B-Keyes (11 tasks, 3 stages)

| Stage | SO | Task Title | Type | TO | Vis | Assigned | Status | Depends On | Review | Attach | Instructions |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Getting Started | 1 | Confirm Your Information | Client | 1 | ✓ | | Active | | | Form | Review the information we have on file. Update if needed. |
| Getting Started | 1 | Start Your Trial | Client | 2 | ✓ | | Active | | | None | Follow the instructions to activate your trial account. |
| Getting Started | 1 | Schedule Your Onboarding Call | Client | 3 | ✓ | | Active | | | Embed | Book your onboarding call. |
| Prepare for Onboarding | 2 | Create Customer Account | Team | 1 | | Onboarding Ops | Draft | | | None | Create the agent's app.rejig.ai account using their roster email. |
| Prepare for Onboarding | 2 | Send Credentials | Team | 2 | | Onboarding Ops | Draft | Create Customer Account | | None | Send login credentials to the agent. |
| Prepare for Onboarding | 2 | Watch Setup Video | Client | 3 | ✓ | | Draft | Send Credentials | | Embed | Watch this short video to configure your service areas. |
| Prepare for Onboarding | 2 | Sign In & Reset Password | Client | 4 | ✓ | | Draft | Send Credentials | | None | Log in and reset your password. |
| Prepare for Onboarding | 2 | Mark Onboarding Call Complete | Team | 5 | | CSM | Draft | | | None | Mark complete after the onboarding call. |
| Review & Grow | 3 | Provide Onboarding Feedback | Client | 1 | ✓ | | Draft | | | Form | We'd love your feedback. |
| Review & Grow | 3 | Schedule Check-In 1 | Client | 2 | ✓ | | Draft | Provide Onboarding Feedback | | Embed | Schedule your first check-in call. |
| Review & Grow | 3 | Schedule Check-In 2 | Client | 3 | ✓ | | Draft | Schedule Check-In 1 | | Embed | Schedule your second check-in call. |

### B2B-BW (10 tasks, 3 stages)

Same as Keyes minus "Start Your Trial".

| Stage | SO | Task Title | Type | TO | Vis | Assigned | Status | Depends On | Review | Attach | Instructions |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Getting Started | 1 | Confirm Your Information | Client | 1 | ✓ | | Active | | | Form | Review the information we have on file. Update if needed. |
| Getting Started | 1 | Schedule Your Onboarding Call | Client | 2 | ✓ | | Active | | | Embed | Book your onboarding call. |
| Prepare for Onboarding | 2 | Create Customer Account | Team | 1 | | Onboarding Ops | Draft | | | None | Create the agent's app.rejig.ai account using their roster email. |
| Prepare for Onboarding | 2 | Send Credentials | Team | 2 | | Onboarding Ops | Draft | Create Customer Account | | None | Send login credentials to the agent. |
| Prepare for Onboarding | 2 | Watch Setup Video | Client | 3 | ✓ | | Draft | Send Credentials | | Embed | Watch this short video to configure your service areas. |
| Prepare for Onboarding | 2 | Sign In & Reset Password | Client | 4 | ✓ | | Draft | Send Credentials | | None | Log in and reset your password. |
| Prepare for Onboarding | 2 | Mark Onboarding Call Complete | Team | 5 | | CSM | Draft | | | None | Mark complete after the onboarding call. |
| Review & Grow | 3 | Provide Onboarding Feedback | Client | 1 | ✓ | | Draft | | | Form | We'd love your feedback. |
| Review & Grow | 3 | Schedule Check-In 1 | Client | 2 | ✓ | | Draft | Provide Onboarding Feedback | | Embed | Schedule your first check-in call. |
| Review & Grow | 3 | Schedule Check-In 2 | Client | 3 | ✓ | | Draft | Schedule Check-In 1 | | Embed | Schedule your second check-in call. |

---

## Automation Logic

### Auto 1: New Customer → Generate Tasks
- **Trigger:** New record in Customers
- **Logic:**
  1. Read Workflow Key (formula: `{Type}-{Channel}`)
  2. Query Workflow Templates matching that key
  3. Create Task records linked to customer
  4. For team tasks: look up Team Member by Assigned Role and link to Task.Assigned To
  5. Set Current Stage to first stage (lowest Stage Order)
  6. Set Stage Entered At to now
  7. Create "Customer Created" event

### Auto 2: Task Completed → Activate Dependents + Advance Stage
- **Trigger:** Task.Status changes to `Completed`
- **Logic:**
  1. Get completed task name + customer
  2. Find all customer tasks where Depends On contains this task name AND Status = Draft
  3. For each: check if ALL dependencies are met (split Depends On by comma, verify each is Completed)
  4. If all met → set Status to Active
  5. Check if ALL tasks in current stage are Completed
  6. If yes → find next stage (Stage Order + 1) → update Customer.Current Stage + Stage Entered At
  7. Activate eligible tasks in new stage (Initial Status = Active from template, all dependencies met)
  8. Create "Task Completed" and optionally "Stage Changed" events

### Auto 3: Team Review Flow
- **Trigger:** Task.Status changes to `In Review`
- **Logic:** Notify the Senior Designer (via Team Members lookup → Slack handle) that a design is ready for review
- **On Approve:** Senior sets Status to `Completed` → Auto 2 fires
- **On Reject:** Senior sets Status to `Rejected` with notes → Status resets to `Active` → Designer revises

### Auto 4: Design Approval (Customer)
- **Trigger:** Customer.Design Approval changes to `Approved`
- **Logic:**
  1. Find "Review & Approve Your Brand Kit" task → set to Completed
  2. Auto 2 handles the rest (stage advancement, dependent activation)
  3. Create "Design Approved" event

### Auto 5: Design Changes Requested
- **Trigger:** Customer.Design Approval changes to `Changes Requested`
- **Logic:**
  1. Create new Task: "Revise Design", Type: Team, Assigned To: original Designer, Status: Active
  2. Pull feedback from Customer.Design Feedback into task Notes
  3. Reset Customer.Design Approval to Pending
  4. Create "Design Changes Requested" event
  5. When revision is done: goes through team review (Auto 3) → new proof uploaded → customer reviews again

### Auto 6: Specific Task Completions → Update Customer Flags
- **Trigger:** Task completed where name matches specific tasks
- **Logic:**
  - "Create Customer Account" → set Customer.Account Created = true
  - "Send Credentials" → set Customer.Credentials Sent = true
  - Create corresponding event

### Auto 7: Call Completed → Advance
- **Trigger:** Customer.Call Completed changes to checked
- **Logic:** If current stage depends on call completion, advance stage and activate next tasks

### Auto 8: Reminder — Stuck Customers (Scheduled)
- **Trigger:** Runs every 6 hours
- **Logic:**
  1. Find Customers where Current Stage ≠ Done
  2. For each: find Active Client tasks
  3. If oldest active task > 3 days AND Reminder Count < 3 → send email → increment count → create event
  4. If Reminder Count = 3 → escalate to CSM (look up CSM Assigned → Team Member → Slack handle → notify)

### Auto 9: Task Completed → Log Event
- **Trigger:** Task.Status changes to Completed
- **Action:** Create Event record with type, actor (from Task.Assigned To or "Customer"), details, linked task and customer

---

## Key Schema Decisions

1. **Workflow Key as formula**: `{Type}-{Channel}` is computed, not manually entered. Prevents typos.

2. **Multi-dependency via comma-separated Depends On**: Activation logic splits by comma, checks ALL are completed. Simple, readable, no schema bloat.

3. **In Review status for team review**: Junior → In Review → Senior approves (Completed) or rejects (back to Active). No extra table needed.

4. **Design approval on Customer record, not task**: The approve/reject loop can repeat. The task ("Review & Approve Your Brand Kit") is just the portal UI surface. The Customer.Design Approval field is what triggers automations.

5. **Customer fields populated in stages**: Creation (Zapier/Roster copy) → Intake form (portal) → Uploads (portal) → Automations (system). Fields are all on one record, written at different times.

6. **Channel is freeform text, not single select**: Allows adding new channels without schema changes. Workflow Key formula handles the template lookup.

7. **Events table logs everything**: Enables timeline views, onboarding time analytics, bottleneck identification, CSM accountability.

8. **Team Members as a lookup table**: CSM Assigned and Task.Assigned To are linked records, not text. Enables looking up email, Slack handle for notifications.

9. **Brokerages as a lookup table**: Holds roster API config, default workflow key, landing page slug. Brokerage-level settings live here, not hardcoded in automations.

10. **Roster → Customer is a one-time copy**: Roster syncs update the Roster table only. Customer records are independent after creation. Prevents roster refreshes from overwriting customer edits.

11. **Calendly/embed URLs live on Workflow Templates, not Team Members**: Different customer types may use different booking links. The template's Embed URL is copied to the task at creation time.
