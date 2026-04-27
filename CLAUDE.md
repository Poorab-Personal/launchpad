@AGENTS.md

# LaunchDeck

## What This Is

LaunchDeck is Rejig.ai's unified customer onboarding system. Rejig is a B2B SaaS platform for real estate agents and brokerages. LaunchDeck replaces 8+ disconnected tools (HubSpot, Stripe, Google Forms/Sheets, Shortcut, Calendly, email threads) with a single onboarding pipeline.

Two customer types:
- **D2C** (SMB agents): full flow with intake forms, design approval, account setup, onboarding call, check-ins
- **B2B** (enterprise brokerages like Keyes, Baird & Warner): agents self-onboard via brokerage landing page, data pre-populated from roster API, no design step

## Architecture (3 Layers)

```
Layer 1: Airtable          — System of record. ALL business logic lives here.
         (7 tables,          Automations handle task generation, dependency
          automations)        activation, stage advancement, event logging.

Layer 2: Zapier             — Integrations. HubSpot deal close -> create customer.
         (external)           Calendly booking -> update task. Slack notifications.

Layer 3: Next.js Portal     — Thin read/write layer. Customer portal + admin UI.
         (this repo)          NO business logic. Just CRUD against Airtable API.
```

**Key principle: the Next.js app is "dumb."** It reads data from Airtable, renders UI, and writes field updates back. Airtable automations do the rest.

## Tech Stack

- Next.js 16 (App Router), React 19, TypeScript
- Tailwind CSS 4
- Airtable REST API (no SDK — raw fetch via `src/lib/airtable-client.ts`)
- Airtable Base ID: `appDx9IX83FLEAHZg`

## Key Architectural Decisions

- **Workflow Key = `{Type}-{Channel}`** drives template lookup. D2C channels all map to `D2C-Standard` for now. B2B channels map to `B2B-Keyes`, `B2B-BW`, etc.
- **Task dependencies are comma-separated task names** in a single text field (Depends On). Multi-dependency supported, but each task should list ALL its prerequisites. Airtable automations split by comma and check all.
- **Review flows use separate tasks** (e.g., "Create Designs" -> team review -> "Upload Proof to Customer" -> "Review & Approve Your Brand Kit"). The `Has Team Review` checkbox on a task triggers the In Review intercept automation.
- **API routes are thin CRUD** -- Airtable automations handle task generation (Auto 1), dependency activation + stage advancement (Auto 2), and In Review interception (Auto 3).
- **Roster -> Customer is a one-time copy**, not a live sync. After creation, the Customer record is independent.
- **Internal team uses Airtable Interface Designer**, not the Next.js admin. The `/admin` routes exist for quick customer creation and overview, but daily workflow happens in Airtable.
- **Customer portal at `/r/[token]`** where token = Airtable record ID (from `RECORD_ID()` formula).
- **Design approval lives on the Customer record** (`Design Approval` field), not on a task. The portal writes `Approved` or `Changes Requested` to the Customer record, which triggers Airtable automations.

## Data Model (7 Airtable Tables)

| Table | Purpose |
|---|---|
| Customers | One row per customer/agent being onboarded |
| Tasks | All tasks (client + team) per customer |
| Workflow Templates | Blueprint rows defining stages/tasks per workflow key |
| Roster | Broker agent data synced from external APIs (B2B only) |
| Events | Audit log of every state change |
| Team Members | Internal team (designers, CSMs, ops) |
| Brokerages | Brokerage-level config (landing page slug, workflow key, roster API) |

Full schema: `docs/schema/production-schema.md`
Architecture details: `docs/architecture.md`

## Project Structure

```
src/
  types/index.ts              -- TypeScript interfaces for all 7 tables
  lib/
    airtable-client.ts        -- Low-level Airtable REST API wrapper (CRUD, batch)
    airtable.ts               -- Data layer: mappers (Airtable -> TS), public API functions
  app/
    r/[token]/page.tsx         -- Customer portal (server component)
    admin/
      page.tsx                 -- Admin customer list
      [customerId]/page.tsx    -- Admin customer detail
      add-customer-form.tsx    -- Add customer form (client component)
    api/
      customers/
        route.ts               -- POST: create customer (thin CRUD)
        [id]/
          route.ts             -- PATCH: update customer fields
          design-approval/
            route.ts           -- POST: design approval/rejection flow
      tasks/
        [taskId]/route.ts      -- PATCH: update task status
  components/
    TaskList.tsx               -- Portal task list grouped by stage
    tasks/
      TaskRenderer.tsx         -- Switch on attachmentType -> render correct component
      PlainTask.tsx            -- Simple mark-complete task
      FormTask.tsx             -- Intake form task
      FileUploadTask.tsx       -- File upload task
      EmbedTask.tsx            -- Embedded content (Calendly, video)
      ProofTask.tsx            -- Design proof review with approve/reject

scripts/
  setup-production.ts          -- Creates all 7 Airtable tables + seeds data
  airtable-automations/
    auto1-generate-tasks.js    -- New Customer -> Generate Tasks from Templates
    auto2-activate-dependents.js -- Task Completed -> Activate Dependents + Advance Stage
    auto3-in-review-intercept.js -- In Review interception (currently disabled)
    README.md                  -- Setup instructions for Airtable automations

docs/
  schema/production-schema.md  -- Production Airtable schema (SOURCE OF TRUTH)
  architecture.md              -- System architecture, data flows, patterns
  flows/d2c-standard.md        -- D2C Standard onboarding flow (VETTED, SOURCE OF TRUTH)
  flows/b2b-keyes.md           -- B2B Keyes onboarding flow (VETTED, SOURCE OF TRUTH)
  flows/b2b-bw.md              -- B2B Baird & Warner onboarding flow (VETTED, SOURCE OF TRUTH)
  prelim-docs/                 -- SUPERSEDED planning docs (historical reference only)
```

## Environment Variables

Required in `.env.local`:
```
AIRTABLE_PAT=pat...         # Personal Access Token (never commit)
AIRTABLE_BASE_ID=appDx9IX83FLEAHZg
```

## Scripts

```bash
npm run dev                   # Start dev server
npm run build                 # Production build
npm run lint                  # ESLint

npx tsx scripts/setup-production.ts  # Create all 7 Airtable tables + seed data
                                      # (destructive — recreates from scratch)
```

After running `setup-production.ts`, manually set up Airtable automations using the scripts in `scripts/airtable-automations/` and the instructions in `scripts/airtable-automations/README.md`.

## Important Patterns

### Airtable Field Name Mapping
- Airtable uses Title Case field names (`Task Name`, `Visible To Client`)
- TypeScript uses camelCase (`taskName`, `visibleToClient`)
- Mappers in `src/lib/airtable.ts` handle the conversion
- API routes use a `fieldMap` object to translate camelCase request body -> Title Case Airtable fields

### Single Select Format Differences
- **Airtable REST API** (used by Next.js): single selects are plain strings (`"Active"`, `"Draft"`)
- **Airtable Scripting API** (used in automations): single selects must be objects (`{ name: "Active" }`)
- The `selectValue()` helper in `airtable.ts` handles both formats for reading

### Linked Records
- Linked record fields return arrays of `{ id: "recXXX" }` objects (or sometimes just string arrays)
- The `linkedIds()` helper normalizes these to `string[]`
- When writing linked records, always pass `[{ id: "recXXX" }]` or `["recXXX"]`

### Attachments
- Attachment fields return arrays of `{ url, filename, ... }` objects
- URLs are temporary (expire) — they're Airtable CDN URLs, not permanent

## What NOT To Do

- **Do NOT add business logic to API routes.** Task generation, dependency activation, stage advancement, and event logging belong in Airtable automations, not in Next.js code. The only exception is the design approval endpoint, which includes dependency/stage logic as a bridge until the Airtable automation equivalent is built.
- **Do NOT use multi-record Depends On links.** The Depends On field is a text field with comma-separated task names, not a linked record field. This avoids Airtable automation race conditions.
- **Do NOT use the Has Team Review flag for the design approval flow.** Design approval uses a separate set of tasks (Create Designs -> Upload Proof -> Review & Approve Brand Kit) with the Customer.Design Approval field as the trigger.
- **Do NOT assume Roster data stays in sync with Customer data.** Roster -> Customer is a one-time copy. Changes to the Roster table do not propagate to existing Customer records.
- **Do NOT hardcode workflow logic.** All stage/task definitions come from the Workflow Templates table. To add a new workflow, add rows to that table with a new Workflow Key.
- **Do NOT reference the prelim-docs as current.** The files in `docs/prelim-docs/` are superseded by `docs/schema/production-schema.md` and `docs/architecture.md`.
