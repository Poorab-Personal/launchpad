# LaunchPad Architecture

## System Overview

```
                    +---------------------------+
                    |      External Systems     |
                    |  HubSpot  Stripe  Calendly|
                    +------------+--------------+
                                 |
                    +------------v--------------+
                    |      Layer 2: Zapier      |
                    |  (Integration middleware)  |
                    | Deal close -> new customer |
                    | Booking -> update task     |
                    | Stage change -> Slack msg  |
                    +------------+--------------+
                                 |
  +------------------------------v-------------------------------+
  |                   Layer 1: Airtable                          |
  |                   (System of Record)                         |
  |                                                              |
  |  +------------+  +-------+  +-------------------+           |
  |  | Customers  |  | Tasks |  | Workflow Templates|           |
  |  +------------+  +-------+  +-------------------+           |
  |  +--------+  +--------+  +--------------+  +-----------+   |
  |  | Roster |  | Events |  | Team Members |  | Brokerages|   |
  |  +--------+  +--------+  +--------------+  +-----------+   |
  |                                                              |
  |  Automations:                                                |
  |    Auto 1: New Customer -> Generate Tasks                    |
  |    Auto 2: Task Completed -> Activate Deps + Advance Stage   |
  |    Auto 3: In Review Interception (disabled)                 |
  +------------------------------+-------------------------------+
                                 |
                        Airtable REST API
                                 |
                    +------------v--------------+
                    |   Layer 3: Next.js App    |
                    |   (Thin read/write layer) |
                    |                           |
                    |  /r/[token]  Customer     |
                    |              portal       |
                    |  /admin      Admin list   |
                    |              + detail     |
                    |  /api/*      CRUD routes  |
                    +---------------------------+
```

## Data Flow: How a Customer Moves Through Onboarding

### D2C Flow

```
1. Sales closes deal in HubSpot
   |
2. Zapier triggers -> POST /api/customers
   (name, email, Type=D2C, Channel=Standard)
   |
3. Airtable creates Customer record
   -> Workflow Key formula computes "D2C-Standard"
   -> Auto 1 fires: generates 17 tasks from Workflow Templates
   -> Current Stage = "Getting Started"
   |
4. Customer receives portal link (/r/{record-id}) via email
   |
5. "Getting Started" stage:
   - Complete Your Onboarding Form (Active, Form)
   - Upload Logos and Headshots (Active, File Upload)
   - Create Designs (Draft, depends on both above)
   |
6. Customer completes form + uploads
   -> Auto 2 fires: activates "Create Designs" (multi-dep met)
   -> Designer works on designs in Airtable
   -> "Create Designs" has Has Team Review = true
   -> Auto 3 (if enabled): intercepts Completed -> In Review
   -> Senior approves -> Completed
   -> Auto 2 fires: activates "Upload Proof to Customer"
   |
7. "Review Your Designs" stage:
   - Upload Proof to Customer (Team, activated by dependency)
   - Review & Approve Your Brand Kit (Draft, depends on Upload Proof)
   -> Designer uploads proof -> task Completed
   -> Auto 2: activates "Review & Approve" task
   -> Customer reviews in portal (Proof task renderer)
   |
8. Customer approves design:
   -> POST /api/customers/{id}/design-approval {approval: "Approved"}
   -> Sets Customer.Design Approval = Approved
   -> Completes "Review & Approve" task
   -> Activates dependents, advances stage
   |
   Customer requests changes:
   -> POST /api/customers/{id}/design-approval {approval: "Changes Requested"}
   -> Creates "Revise Design" task (Active, assigned to original designer)
   -> Resets Design Approval to Pending
   -> Revision loop repeats until approved
   |
9. "Book Your Call" stage:
   Move Designs to Production -> Create Customer Account -> Send Credentials
   -> Schedule Your Onboarding Call
   (Sequential chain via Depends On)
   |
10. "Prepare for Onboarding" stage:
    Watch Setup Video, Sign In & Reset Password (depend on Send Credentials)
    Mark Onboarding Call Complete (CSM team task)
    |
11. "Post Onboarding Follow Ups" stage:
    Send Zoom Recording, Send Follow-Up Email (CSM tasks)
    |
12. "Review & Grow" stage:
    Provide Onboarding Feedback -> Schedule Check-In 1 -> Schedule Check-In 2
```

### B2B Enterprise Flow

```
1. Agent visits onboarding.rejig.ai/{brokerage-slug}
   (e.g., onboarding.rejig.ai/keyes)
   |
2. Agent enters their email
   |
3. System validates against Roster table (filtered by Brokerage)
   -> NOT found: "Contact your broker admin" error
   -> Found + already has Customer Record: redirect to existing portal
   -> Found + no Customer Record:
      |
4. Create Customer record (one-time copy from Roster):
   - Copy: Name, Email, Phone, License, Website, Bio, Service Areas,
     MLS IDs, Topics, Hashtags, GMB Name, Photo, Logo
   - Set: Type=B2B, Channel=brokerage name
   - Link: Brokerage, Roster Record
   - Update Roster: Onboarding Status=In Progress, Customer Record=link
   |
5. Workflow Key formula computes (e.g., "B2B-Keyes")
   -> Auto 1 fires: generates tasks (11 for Keyes, 10 for BW)
   -> All "Getting Started" tasks are Active immediately
   |
6. Agent sees portal with pre-populated data:
   - Confirm Your Information (Form — review/edit roster data)
   - Start Your Trial (Keyes only)
   - Schedule Your Onboarding Call (Embed — Calendly)
   |
7. Remaining flow is similar to D2C post-design stages:
   Create Account -> Send Credentials -> Watch Video, Sign In
   -> Onboarding Call -> Feedback -> Check-Ins
```

## Airtable Schema Summary

Full details: `docs/schema/production-schema.md`

### Customers
One row per customer/agent. Fields populated in stages: creation (Zapier/Roster), intake (portal form), uploads (portal), automations (system). Key fields: Name, Type (`D2C`/`B2B`), Channel, Workflow Key (formula), Contact Email, Platform Email, Current Stage, Design Approval, Access Token (`RECORD_ID()`).

### Tasks
All tasks per customer. Key fields: Task Name, Customer (link), Task Type (`Client`/`Team`), Stage, Status (`Draft`/`Active`/`In Review`/`Completed`/`Rejected`), Depends On (comma-separated task names), Has Team Review, Attachment Type, Embed URL, Assigned To (link to Team Members), Visible To Client.

### Workflow Templates
Blueprint rows (configuration, not runtime data). One set per workflow key. Key fields: Workflow Key, Stage, Stage Order, Task Title, Task Type, Initial Status, Depends On, Assigned Role, Has Team Review, Attachment Type, Embed URL, Instructions.

### Roster
Broker agent data synced from external APIs. Enterprise only. One row per agent. Key rule: **Roster -> Customer is a one-time copy, not a live sync.** Key fields: Email (primary), Brokerage (link), Agent Name, all business info fields, Onboarding Status, Customer Record (link).

### Events
Audit log. Every state change logged. Fields: Customer (link), Event Type, Actor (link to Team Members), Actor Type, Details, Related Task (link).

### Team Members
Lookup table for internal team. Fields: Name, Email, Slack Handle, Role (`Designer`/`Senior Designer`/`CSM`/`Onboarding Ops`/`Admin`), Active.

### Brokerages
Brokerage-level config. Fields: Name, Landing Page Slug, Default Workflow Key, Roster API URL/Key, Roster Refresh Interval, Active.

## Airtable Automations

These run inside Airtable's scripting environment, not as Node.js. Scripts are stored in `scripts/airtable-automations/` for version control. Paste them into Airtable's "Run a script" action editor.

### Auto 1: New Customer -> Generate Tasks
- **Trigger:** New record created in Customers table
- **Input variables:** `recordId`, `type`, `channel`
- **Script:** `auto1-generate-tasks.js`
- **What it does:**
  1. Builds workflow key from `{type}-{channel}`
  2. Queries Workflow Templates for matching rows
  3. Looks up Team Members by Assigned Role
  4. Creates Task records linked to customer
  5. Sets Customer.Current Stage to first stage
  6. Logs "Customer Created" event

### Auto 2: Task Completed -> Activate Dependents + Advance Stage
- **Trigger:** Task.Status matches "Completed"
- **Input variables:** `taskRecordId`, `taskName`, `customerRecordId`, `taskStage`
- **Script:** `auto2-activate-dependents.js`
- **What it does:**
  1. Gets all tasks for customer
  2. Builds set of completed task names
  3. For each Draft task with Depends On: splits by comma, checks ALL completed
  4. If all deps met -> activates task (Draft -> Active)
  5. Updates customer flags ("Create Customer Account" -> Account Created, "Send Credentials" -> Credentials Sent)
  6. Logs Task Completed event
  7. Checks if all stage tasks are completed -> advances to next stage
  8. On stage advance: activates eligible tasks in new stage
  9. Logs Stage Changed event

### Auto 3: In Review Interception (currently disabled)
- **Trigger:** Task.Status = "Completed" AND Has Team Review = checked
- **Input variables:** `taskRecordId`, `taskName`, `customerRecordId`
- **Script:** `auto3-in-review-intercept.js`
- **What it does:** Redirects Completed -> In Review for senior approval
- **Important:** Must run BEFORE Auto 2 in Airtable automation order
- **Status:** Disabled pending decision on whether review flow is needed

### Automations NOT yet implemented (defined in schema doc)
- Auto 4-5: Design Approval/Changes Requested triggers (partially handled by API route)
- Auto 6: Specific task completions -> customer flags (merged into Auto 2)
- Auto 7: Call Completed -> advance
- Auto 8: Reminder -- stuck customers (scheduled, every 6 hours)
- Auto 9: Task Completed -> log event (merged into Auto 2)

## API Routes

All routes are thin CRUD. Business logic is in Airtable automations.

### `POST /api/customers`
Creates a customer record in Airtable. Required fields: `name`, `type`, `channel`, `email`. Optional: `businessName`, `businessAddress`, `website`, `phone`. Airtable Auto 1 handles task generation.

### `PATCH /api/tasks/[taskId]`
Updates a task's status. Body: `{ status: "Completed" | "Active" | ... }`. If status is "Completed", also sets `Completed At`. Airtable Auto 2 handles dependency activation.

### `PATCH /api/customers/[id]`
Updates customer fields. Body is camelCase keys mapped to Airtable Title Case via `fieldMap`. Accepts any customer-editable field.

### `POST /api/customers/[id]/design-approval`
Handles design approval flow. Body: `{ approval: "Approved" | "Changes Requested", feedback?: string }`.
- **Approved:** Completes "Review & Approve Your Brand Kit" task, activates dependents, advances stage, logs event.
- **Changes Requested:** Creates "Revise Design" task assigned to original designer, resets Design Approval to Pending, logs event.

Note: This endpoint contains dependency activation and stage advancement logic (duplicated from what Auto 2 does) because the design approval flow needs to complete a task AND activate dependents in a single request. This is the one exception to the "no business logic in API routes" rule.

## Portal (Customer-Facing UI)

**URL pattern:** `/r/[token]` where token = Airtable record ID

### How it works:
1. Server component fetches customer by token (`getCustomerByToken`)
2. Fetches all tasks for customer (`getTasksForCustomer`)
3. Renders `TaskList` client component with initial data
4. TaskList filters to `visibleToClient` tasks only
5. Groups tasks by stage, ordered by `stageOrder` then `taskOrder`
6. Renders stage progress indicator (completed / active / upcoming)

### Task rendering:
`TaskRenderer` switches on `task.attachmentType`:
- `None` -> `PlainTask` (instructions + mark complete button)
- `Form` -> `FormTask` (intake form fields)
- `File Upload` -> `FileUploadTask` (file upload UI)
- `Embed` -> `EmbedTask` (iframe for Calendly, Loom, etc.)
- `Proof` -> `ProofTask` (design proof with approve/reject buttons)

### Task states in portal:
- **Active:** Expanded card with full UI, actionable
- **Completed:** Collapsed with checkmark, strike-through text
- **Draft:** Collapsed with lock icon, grayed out

## Admin UI

### `/admin` -- Customer list
- Server component fetches all customers, team members, workflows
- Table with: Name (link to detail), Channel, Type, Current Stage, CSM Assigned, Stage Entered At
- Filter by type (D2C/B2B)
- "Add Customer" form (client component)

### `/admin/[customerId]` -- Customer detail
- Individual customer record with tasks and fields

### Add Customer Form
- Dropdown of available workflows (from Workflow Templates, grouped by D2C/B2B)
- Required: Name, Email, Workflow
- Optional: Business Name, Website
- POSTs to `/api/customers`

## Design Approval Flow (D2C Only)

Full chain:

```
Create Designs (Team, Draft)
  depends on: "Complete Your Onboarding Form, Upload Logos and Headshots"
  Has Team Review = true (junior -> senior review)
       |
Upload Proof to Customer (Team, Draft)
  depends on: "Create Designs"
       |
Review & Approve Your Brand Kit (Client, Draft, Proof type)
  depends on: "Upload Proof to Customer"
       |
  Customer sees proof in portal ->
    Approve -> POST /api/customers/{id}/design-approval {approval: "Approved"}
      -> Completes task, activates "Move Designs to Production", advances stage
    Request Changes -> POST /api/customers/{id}/design-approval {approval: "Changes Requested"}
      -> Creates "Revise Design" task (Active, Team, assigned to original designer)
      -> Resets Design Approval to Pending
      -> Designer revises -> Upload Proof again -> Customer reviews again
      -> Loop repeats until approved
```

## Key Patterns and Pitfalls

### Airtable Scripting API vs REST API
- **Scripting API** (automations): Single selects are `{ name: "value" }` objects. Write as `{ name: "Active" }`.
- **REST API** (Next.js app): Single selects are plain strings `"Active"`. Write as `"Active"`.
- The `selectValue()` helper in `airtable.ts` handles both for reading, but **writing** differs by context.

### Race Conditions with Airtable Automations
- Airtable automations can fire in parallel. If Auto 2 and Auto 3 both trigger on the same task status change, execution order matters.
- Auto 3 (In Review intercept) must run BEFORE Auto 2 (activate dependents).
- The Depends On field is text (not linked records) specifically to avoid automation race conditions with record creation.

### Field Format Quirks
- `getCellValue()` on checkboxes returns `true` or `null` (not `false`)
- `getCellValue()` on linked records returns `[{ id, name }]`
- `getCellValueAsString()` always returns a string, useful for comparison
- Task Order and Stage Order are numbers but may return `null` — always use `Number(val) || 0`

### Task Name Matching
- Depends On matching is **exact and case-sensitive**
- Task names in Depends On must match Task Title in Workflow Templates exactly
- Multi-dependency uses comma-space separator: `"Task A, Task B"`

### Stage Advancement
- Stage advances only when ALL tasks in the current stage are Completed (including team tasks not visible to client)
- The Workflow Templates table defines stage order via Stage Order field
- When no more stages exist, Current Stage is set to "Done"

### One-Time Copy Pattern
- Roster -> Customer copies data once at customer creation
- Subsequent roster syncs update only the Roster table
- This prevents overwrites of customer edits to their own profile

### Access Token = Record ID
- `Access Token` is a formula field: `RECORD_ID()`
- Portal URLs are `/r/{record-id}` -- no separate auth system
- Anyone with the URL can access the portal (by design -- customers receive link via email)
