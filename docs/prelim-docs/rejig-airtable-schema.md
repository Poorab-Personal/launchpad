# Rejig Onboarding — Airtable Schema

> **SUPERSEDED (2026-05-12).** This is a pre-build planning doc. LaunchPad has since shipped on Postgres, not Airtable. Retained for historical context only.
> Current source of truth: `docs/schema/production-schema.md` and `src/db/schema/`.

## Overview

5 tables that power the entire onboarding system for both D2C and Enterprise flows.

- **Customers** — one row per customer/agent being onboarded
- **Tasks** — all tasks (client-facing and internal) per customer
- **Workflow Templates** — blueprints that define what tasks get created per customer type
- **Roster** — broker agent data synced from external APIs (Keyes, B&W)
- **Events** — audit log of every action for timeline views and reporting

---

## Table 1: Customers

One row per customer or agent. This is the core record everything links back to.

| Field Name | Field Type | Options / Notes |
|---|---|---|
| Customer Name | Single line text | Primary field |
| Type | Single select | `D2C Standard`, `D2C Voice`, `D2C Avatar`, `Keyes`, `B&W` |
| Broker | Single select | `Direct`, `Keyes`, `B&W` |
| Current Stage | Single select | Values are dynamic per customer type — see Workflow Templates. Common values: `Getting Started`, `Review Your Designs`, `Book Your Call`, `Prepare for Onboarding`, `Post Onboarding Follow Ups`, `Review & Grow`, `Done` |
| Stage Entered At | Date (include time) | Updated by automation when stage advances |
| Contact Email | Email | Primary communication email |
| Platform Email | Email | Email used for app.rejig.ai login — customer provides during intake |
| Phone | Phone number | |
| Business Name | Single line text | |
| Business Address | Long text | |
| Website | URL | |
| Service Areas | Long text | Comma-separated or multi-line |
| Bio | Long text | Agent/business bio |
| License Number | Single line text | |
| Topics | Long text | Account-level content topics |
| Hashtags | Single line text | Preferred hashtags |
| GMB Name | Single line text | Google My Business name |
| MLS IDs | Long text | JSON string or comma-separated |
| Agent Photo | Attachment | Photo file or URL |
| Business Logo | Attachment | Logo file or URL |
| Other Assets | Attachment | Additional brand assets |
| Special Instructions | Long text | Notes for design team from intake |
| HubSpot Deal ID | Single line text | D2C only |
| Stripe Payment ID | Single line text | D2C only |
| Add-On Stripe Payment ID | Single line text | D2C with add-ons only |
| Product Tier | Single select | `Premium`, `Luxury` |
| Payment Status | Single select | `Paid`, `Waived` |
| CSM Assigned | Single select | `Mario`, `Luis` |
| Design Approval | Single select | `Pending`, `Approved`, `Changes Requested` |
| Design Feedback | Long text | Customer's feedback when requesting changes |
| Account Created | Checkbox | Onboarding team checks when done |
| Credentials Sent | Checkbox | Onboarding team checks when done |
| Call Booked | Checkbox | Updated when Calendly booking confirmed |
| Call Completed | Checkbox | CSM checks after onboarding call |
| Reminder Count | Number (integer) | Tracks how many reminders have been sent, for max-reminder logic |
| Access Token | Formula | `RECORD_ID()` — used as unique token for frontend portal access |
| Tasks | Link to Tasks | Reverse link — auto-populated |
| Events | Link to Events | Reverse link — auto-populated |
| Created At | Created time | Auto |
| Last Modified | Last modified time | Auto |

---

## Table 2: Tasks

All tasks per customer — both client-facing and internal team tasks.

| Field Name | Field Type | Options / Notes |
|---|---|---|
| Task Name | Single line text | Primary field |
| Customer | Link to Customers | Each task belongs to one customer |
| Type | Single select | `Client`, `Team` |
| Stage | Single select | `Getting Started`, `Review Your Designs`, `Book Your Call`, `Prepare for Onboarding`, `Post Onboarding Follow Ups`, `Review & Grow` |
| Status | Single select | `Draft`, `Active`, `In Review`, `Completed`, `Rejected` |
| Task Order | Number (integer) | Controls display order within a stage |
| Assigned To | Single select | `Designer`, `Senior Designer`, `CSM`, `Onboarding Ops` |
| Visible To Client | Checkbox | If true, customer can see this task in portal |
| Depends On | Single line text | Task name that must complete before this activates. Blank = no dependency |
| Has Team Review | Checkbox | If true, task goes to In Review before completing |
| Attachment Type | Single select | `None`, `Form`, `File Upload`, `Embed`, `Proof` |
| Embed URL | URL | Calendly link, Loom video, etc. |
| Instructions | Long text | Task description shown to assignee or customer |
| Tags | Multiple select | `Design Change`, `Dev Request`, `Priority`, `Follow Up` |
| Notes | Long text | Internal notes on this task |
| Due Date | Date | |
| Completed At | Date (include time) | Set when Status changes to Completed |
| Created At | Created time | Auto |

---

## Table 3: Workflow Templates

Blueprint rows that define what tasks get created for each customer type. When a new customer is created, the system reads all rows matching their Type and creates corresponding Task records.

NOT runtime data. This is configuration data. Rows are added/edited when you want to change a workflow.

| Field Name | Field Type | Options / Notes |
|---|---|---|
| Template Row ID | Autonumber | Primary field |
| Customer Type | Single select | `D2C Standard`, `D2C Voice`, `D2C Avatar`, `Keyes`, `B&W` |
| Stage | Single line text | Stage name this task belongs to |
| Stage Order | Number (integer) | Controls stage sequence: 1, 2, 3... |
| Task Title | Single line text | Title of the task to be created |
| Task Type | Single select | `Client`, `Team` |
| Task Order | Number (integer) | Order within the stage: 1, 2, 3... |
| Visible To Client | Checkbox | |
| Assigned Role | Single select | `Designer`, `Senior Designer`, `CSM`, `Onboarding Ops` |
| Initial Status | Single select | `Active`, `Draft` — Active means task starts immediately, Draft means it waits for a dependency |
| Depends On | Single line text | Task title that must complete before this activates. Blank = no dependency |
| Has Team Review | Checkbox | If true, requires senior review before completion |
| Attachment Type | Single select | `None`, `Form`, `File Upload`, `Embed`, `Proof` |
| Embed URL | URL | Static URL for embeds (Calendly, videos). Can be overridden per customer if needed |
| Instructions | Long text | Default task description/instructions |

---

## Table 4: Roster

Broker agent data synced from external roster APIs. One row per agent.

Used for:
- Validating enterprise agent email on login
- Pre-populating customer records for enterprise agents
- Tracking which agents have been onboarded

| Field Name | Field Type | Options / Notes |
|---|---|---|
| Email | Email | Primary field. Unique per agent. |
| Broker | Single select | `Keyes`, `B&W` |
| Agent Name | Single line text | |
| Phone | Phone number | |
| License Number | Single line text | |
| Website | URL | |
| Photo URL | URL | Hosted URL from roster API |
| Logo URL | URL | Hosted URL from roster API |
| Bio | Long text | |
| Service Areas | Long text | |
| MLS IDs | Long text | JSON string |
| Topics | Long text | Account-level content topics |
| Hashtags | Single line text | |
| GMB Name | Single line text | |
| Other Emails | Long text | Additional emails to include in design sends |
| Onboarding Status | Single select | `Not Started`, `In Progress`, `Completed` |
| Customer Record | Link to Customers | Links to the customer record once created |
| Synced At | Date (include time) | Last time this record was synced from roster API |

---

## Table 5: Events

Audit log of every action. Powers timeline views in admin dashboard and future analytics.

| Field Name | Field Type | Options / Notes |
|---|---|---|
| Event ID | Autonumber | Primary field |
| Customer | Link to Customers | Which customer this event is about |
| Event Type | Single select | `Customer Created`, `Stage Changed`, `Task Created`, `Task Activated`, `Task Completed`, `Task Rejected`, `Design Uploaded`, `Design Approved`, `Design Changes Requested`, `Call Booked`, `Call Completed`, `Reminder Sent`, `Note Added`, `Credentials Sent`, `Account Created` |
| Actor | Single select | `Customer`, `Designer`, `Senior Designer`, `CSM`, `Onboarding Ops`, `System` |
| Details | Long text | Free-text description of what happened |
| Related Task | Link to Tasks | Optional — which task this event relates to |
| Created At | Created time | Auto |

---

## Workflow Template Data: D2C Standard

16 rows that define the complete D2C Standard onboarding workflow.

| Customer Type | Stage | Stage Order | Task Title | Task Type | Task Order | Visible to Client | Assigned Role | Initial Status | Depends On | Has Team Review | Attachment Type | Instructions |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| D2C Standard | Getting Started | 1 | Complete Your Onboarding Form | Client | 1 | ✓ | | Active | | | Form | Please complete this form so our team can get started on your brand kit. |
| D2C Standard | Getting Started | 1 | Upload Logos and Headshots | Client | 2 | ✓ | | Active | | | File Upload | Upload your logo files (PNG/SVG preferred), professional headshots, and any brand assets. |
| D2C Standard | Getting Started | 1 | Create Designs | Team | 3 | | Designer | Draft | Upload Logos and Headshots | ✓ | None | Pull assets from client submissions. Create brand kit design using uploaded logos, headshots, and bio. |
| D2C Standard | Review Your Designs | 2 | Upload Proof to Customer | Team | 1 | | Designer | Draft | Create Designs | | None | Upload the approved design files to the client review task. |
| D2C Standard | Review Your Designs | 2 | Review & Approve Your Brand Kit | Client | 2 | ✓ | | Draft | Upload Proof to Customer | | Proof | Please review your brand kit. If everything looks correct, click Approve. If changes are needed, click Request Changes and describe what needs updating. |
| D2C Standard | Book Your Call | 3 | Move Designs to Production | Team | 1 | | Designer | Draft | | | None | Move approved design assets to the production environment. |
| D2C Standard | Book Your Call | 3 | Create Customer Account | Team | 2 | | Onboarding Ops | Draft | Move Designs to Production | | None | Create the customer's app.rejig.ai account using their Platform Email. |
| D2C Standard | Book Your Call | 3 | Send Credentials | Team | 3 | | Onboarding Ops | Draft | Create Customer Account | | None | Send login credentials to the customer. |
| D2C Standard | Book Your Call | 3 | Schedule Your Onboarding Call | Client | 4 | ✓ | | Draft | Send Credentials | | Embed | Book your onboarding call at a time that works for you. |
| D2C Standard | Prepare for Onboarding | 4 | Watch Setup Video | Client | 1 | ✓ | | Draft | Send Credentials | | Embed | Watch this short video to learn how to connect and configure your service areas. |
| D2C Standard | Prepare for Onboarding | 4 | Sign In & Reset Password | Client | 2 | ✓ | | Draft | Send Credentials | | None | Log in to app.rejig.ai using the credentials we sent and reset your password. |
| D2C Standard | Prepare for Onboarding | 4 | Mark Onboarding Call Complete | Team | 3 | | CSM | Draft | | | None | Mark complete after the onboarding call has taken place. If no-show or rescheduled, add a comment with the new date. |
| D2C Standard | Post Onboarding Follow Ups | 5 | Send Zoom Recording | Team | 1 | | CSM | Draft | | | None | Upload or send the onboarding call Zoom recording to the customer. |
| D2C Standard | Post Onboarding Follow Ups | 5 | Send Follow-Up Email | Team | 2 | | CSM | Draft | | | None | Send summary of what was covered, outstanding items, and next steps. |
| D2C Standard | Review & Grow | 6 | Provide Onboarding Feedback | Client | 1 | ✓ | | Draft | | | Form | We'd love your feedback on the onboarding experience. |
| D2C Standard | Review & Grow | 6 | Schedule Check-In 1 | Client | 2 | ✓ | | Draft | Provide Onboarding Feedback | | Embed | Schedule your first check-in call. |
| D2C Standard | Review & Grow | 6 | Schedule Check-In 2 | Client | 3 | ✓ | | Draft | Schedule Check-In 1 | | Embed | Schedule your second check-in call. |

---

## Workflow Template Data: Keyes

11 rows. Shorter flow — no design stages, all Getting Started tasks are active immediately.

| Customer Type | Stage | Stage Order | Task Title | Task Type | Task Order | Visible to Client | Assigned Role | Initial Status | Depends On | Has Team Review | Attachment Type | Instructions |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Keyes | Getting Started | 1 | Confirm Your Information | Client | 1 | ✓ | | Active | | | Form | Review the information we have on file for you. If anything needs updating, let us know via Messages. |
| Keyes | Getting Started | 1 | Start Your Trial | Client | 2 | ✓ | | Active | | | None | Follow the instructions to activate your trial account. |
| Keyes | Getting Started | 1 | Schedule Your Onboarding Call | Client | 3 | ✓ | | Active | | | Embed | Book your onboarding call at a time that works for you. |
| Keyes | Prepare for Onboarding | 2 | Create Customer Account | Team | 1 | | Onboarding Ops | Draft | | | None | Create the agent's app.rejig.ai account using their roster email. |
| Keyes | Prepare for Onboarding | 2 | Send Credentials | Team | 2 | | Onboarding Ops | Draft | Create Customer Account | | None | Send login credentials to the agent. |
| Keyes | Prepare for Onboarding | 2 | Watch Setup Video | Client | 3 | ✓ | | Draft | Send Credentials | | Embed | Watch this short video to learn how to connect and configure your service areas. |
| Keyes | Prepare for Onboarding | 2 | Sign In & Reset Password | Client | 4 | ✓ | | Draft | Send Credentials | | None | Log in to app.rejig.ai using the credentials we sent and reset your password. |
| Keyes | Prepare for Onboarding | 2 | Mark Onboarding Call Complete | Team | 5 | | CSM | Draft | | | None | Mark complete after the onboarding call. Add comments if rescheduled. |
| Keyes | Review & Grow | 3 | Provide Onboarding Feedback | Client | 1 | ✓ | | Draft | | | Form | We'd love your feedback on the onboarding experience. |
| Keyes | Review & Grow | 3 | Schedule Check-In 1 | Client | 2 | ✓ | | Draft | Provide Onboarding Feedback | | Embed | Schedule your first check-in call. |
| Keyes | Review & Grow | 3 | Schedule Check-In 2 | Client | 3 | ✓ | | Draft | Schedule Check-In 1 | | Embed | Schedule your second check-in call. |

---

## Workflow Template Data: B&W

10 rows. Same as Keyes but without "Start Your Trial" task.

| Customer Type | Stage | Stage Order | Task Title | Task Type | Task Order | Visible to Client | Assigned Role | Initial Status | Depends On | Has Team Review | Attachment Type | Instructions |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B&W | Getting Started | 1 | Confirm Your Information | Client | 1 | ✓ | | Active | | | Form | Review the information we have on file for you. If anything needs updating, let us know via Messages. |
| B&W | Getting Started | 1 | Schedule Your Onboarding Call | Client | 2 | ✓ | | Active | | | Embed | Book your onboarding call at a time that works for you. |
| B&W | Prepare for Onboarding | 2 | Create Customer Account | Team | 1 | | Onboarding Ops | Draft | | | None | Create the agent's app.rejig.ai account using their roster email. |
| B&W | Prepare for Onboarding | 2 | Send Credentials | Team | 2 | | Onboarding Ops | Draft | Create Customer Account | | None | Send login credentials to the agent. |
| B&W | Prepare for Onboarding | 2 | Watch Setup Video | Client | 3 | ✓ | | Draft | Send Credentials | | Embed | Watch this short video to learn how to connect and configure your service areas. |
| B&W | Prepare for Onboarding | 2 | Sign In & Reset Password | Client | 4 | ✓ | | Draft | Send Credentials | | None | Log in to app.rejig.ai using the credentials we sent and reset your password. |
| B&W | Prepare for Onboarding | 2 | Mark Onboarding Call Complete | Team | 5 | | CSM | Draft | | | None | Mark complete after the onboarding call. Add comments if rescheduled. |
| B&W | Review & Grow | 3 | Provide Onboarding Feedback | Client | 1 | ✓ | | Draft | | | Form | We'd love your feedback on the onboarding experience. |
| B&W | Review & Grow | 3 | Schedule Check-In 1 | Client | 2 | ✓ | | Draft | Provide Onboarding Feedback | | Embed | Schedule your first check-in call. |
| B&W | Review & Grow | 3 | Schedule Check-In 2 | Client | 3 | ✓ | | Draft | Schedule Check-In 1 | | Embed | Schedule your second check-in call. |

---

## Automation Logic (built manually in Airtable UI)

These cannot be created via API. Listed here as reference for what to build after tables exist.

### Universal Automations (apply to all customer types)

**Auto 1: New Customer → Generate Tasks from Template**
- Trigger: New record in Customers table
- Script: Read Customer Type → find all Workflow Template rows matching → create Task records linked to customer → set Customer.Current Stage to first stage → set Stage Entered At to now → create "Customer Created" event

**Auto 2: Task Completed → Activate Dependents + Advance Stage**
- Trigger: Task.Status changes to Completed
- Script: Find all Tasks for same Customer where Depends On = completed task title AND Status = Draft → set to Active. Then check if ALL tasks in current stage are completed → if yes, find next stage (Stage Order + 1) → update Customer.Current Stage and Stage Entered At → activate any tasks in new stage that have Initial Status = Active and no dependencies → create "Stage Changed" event

**Auto 3: Task Completed → Log Event**
- Trigger: Task.Status changes to Completed
- Action: Create Event record: Task Completed, link to customer and task

### D2C-Specific Automations

**Auto 4: Design Approval → Advance to Book Your Call**
- Trigger: Customer.Design Approval changes to Approved
- Script: Update Current Stage to "Book Your Call" → find Draft tasks in that stage with no dependencies → set to Active → create event

**Auto 5: Design Changes Requested → Create Revision Task**
- Trigger: Customer.Design Approval changes to Changes Requested
- Action: Create new Task: "Revise Design", Type: Team, Assigned: Designer, Status: Active, Notes: pull from Customer.Design Feedback → reset Design Approval to Pending → create event

**Auto 6: Account Created → Update Customer**
- Trigger: Task completed where Title = "Create Customer Account"
- Action: Set Customer.Account Created = true → create event

**Auto 7: Credentials Sent → Update Customer**
- Trigger: Task completed where Title = "Send Credentials"
- Action: Set Customer.Credentials Sent = true → create event

### Scheduled Automations

**Auto 8: Reminder — Stuck Customers**
- Trigger: Scheduled, runs every hour (or every 6 hours)
- Script: Find Customers where Current Stage ≠ Done → for each, find Active Client tasks → if oldest active task > 3 days old AND Reminder Count < 3 → send email reminder → increment Reminder Count → create "Reminder Sent" event

**Auto 9: Call Completed → Advance to Post Onboarding**
- Trigger: Customer.Call Completed changes to checked
- Action: Update Current Stage → activate post-onboarding tasks → create event

---

## Open Questions for Review

1. **D2C Voice / D2C Avatar templates** — not included yet. These are copies of D2C Standard with additional intake tasks (voice recording instructions, video upload). Add when ready.

2. **"Create Designs" depends on "Upload Logos and Headshots"** — but should it depend on BOTH intake tasks (form + uploads)? Currently only depends on the upload task. If both must complete first, the automation script handles this (Auto 2 checks all tasks in stage, not just the dependency).

3. **Post Onboarding Follow Ups stage** — has Team tasks only (Send Zoom, Send Follow-Up). When should this stage advance to Review & Grow? Current logic: when CSM marks Call Completed, system skips straight to activating Review & Grow tasks. The Post Onboarding Follow Ups stage is more of a parallel internal checklist. Need to decide if it's a real stage in the progress tracker or just internal.

4. **Calendly and video embed URLs** — left blank in template data. These need actual URLs populated before going live.

5. **Roster "Other Emails" field** — from the sample ticket, some agents have additional emails for design sends. Where does this get used? Is it a CC list for design approval notifications?

6. **Design approval for D2C** — the current flow advances to "Book Your Call" on approval, which triggers Move to Prod → Create Account → Send Credentials sequentially. This is handled by task dependencies in the template, not by the Design Approval field. The Design Approval field on the Customer record is a separate trigger (Auto 4). Need to make sure these don't conflict — either use the field OR the task dependency, not both.

7. **Stage names must match exactly** between Customers.Current Stage options and Workflow Templates.Stage values. Any typo breaks the automation.
