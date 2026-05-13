@AGENTS.md

# LaunchPad

## What This Is

LaunchPad is Rejig.ai's unified customer onboarding system. Rejig is a B2B SaaS platform for real estate agents and brokerages. LaunchPad consolidates intake, design approval, payment capture, scheduling, account creation, and follow-ups into a single pipeline.

Two customer types:
- **D2C** (SMB agents): full flow with intake forms, design approval, account setup, onboarding call, check-ins
- **B2B** (enterprise brokerages like Keyes, Baird & Warner): agents self-onboard via brokerage landing page, data pre-populated from roster API, B2B-Keyes uses Stripe trial / setup-intent

## Architecture (3 Layers)

```
Layer 1: Vercel Postgres / Neon    — Single source of truth.
         (Drizzle ORM)                Drizzle migrations as schema source-of-truth.
                                      Vercel Blob for file attachments.

Layer 2: Vercel cron + inline TS    — Automations run as TypeScript inside the
         (src/lib/automations/)        same process as the routes that trigger
                                      them. No external automation engine.

Layer 3: Next.js                    — /r portal (customers), /b landing (B2B
         (this repo)                  signup), /workspace (internal team UI),
                                      /admin (lightweight admin). Reads/writes
                                      Postgres via src/lib/db.ts.
```

**Key principle: automations live next to the data layer.** When a task completes via `updateTaskStatus`/`updateTaskFields`, `handleTaskCompleted` runs inline (same transaction surface) and handles dependent activation, stage advancement, CSM routing, email triggers, Stripe sub creation. No async webhooks; no external automation platform.

## Tech Stack

- Next.js 16 (App Router), React 19, TypeScript
- Tailwind CSS 4
- Drizzle ORM + Vercel Postgres (Neon serverless driver)
- Vercel Blob for file storage
- Stripe (subscriptions, SetupIntent, webhooks)
- Resend (transactional email)
- Vitest for tests

## Key Architectural Decisions

- **Postgres is the system of record.** No external sync, no second database, no spreadsheet truth. The Airtable migration retired 2026-05-12.
- **Workflow Key = `{Type}-{Channel}`** drives template lookup. `Channel` is an FK to a small `channels` lookup table (Standard / Keyes / BW), preventing the `"BW"` vs `"Baird & Warner"` typo class.
- **Task dependencies are a real junction table** (`task_dependencies`), not comma-separated text. Multi-dependency supported; activation checks `task_dependencies` and the source rows' status.
- **Review flows use separate tasks** (Create Designs → Review Designs → Upload Proof → Review & Approve Your Brand Kit). The customer-facing approval writes `Customer.designApproval = Approved | Changes Requested`, which dispatches into `src/lib/automations/design-approval.ts`.
- **API routes are thin dispatchers.** Business logic lives in `src/lib/db.ts` (reads/writes) and `src/lib/automations/*.ts` (transitions). Routes parse input, call helpers, return responses.
- **Customer portal at `/r/[accessToken]`** where `accessToken` is a UUID on the `customers` table (not the row id — separate, indexed, unique).
- **Atomic customer creation.** `POST /api/customers` inserts the Customer + generates all tasks + wires dependencies + logs the Customer Created event inside a single `db.transaction`. Either all happens or none does — replaces the legacy Airtable Auto-1 race.

## Data Model (12 Postgres Tables + 5 enums)

Operational:
| Table | Purpose |
|---|---|
| `customers` | One row per customer/agent being onboarded (71 columns) |
| `tasks` | All tasks (client + team) per customer |
| `task_dependencies` | Junction table for task graph |
| `calls` | CSM/onboarding calls per customer (Calendly-keyed for idempotency) |
| `events` | Audit log of every state change |
| `roster` | Bridge row for B2B agents one-time-copied from DMG roster |

Config / reference:
| Table | Purpose |
|---|---|
| `workflow_templates` | Blueprint rows defining stages/tasks per workflow key |
| `channels` | Lookup: `Standard`, `Keyes`, `BW` (FK target for `customers.channel_id`) |
| `brokerages` | Brokerage-level config (landing page slug, workflow key, Calendly URL) |
| `team_members` | Internal team (designers, CSMs, ops) with multi-role array |
| `stripe_plans` | Per-workflow Stripe price options |
| `settings` | Key-value app settings (e.g. `portal_base_url`) |

Postgres-native enums: `customer_type`, `task_status`, `task_type`, `attachment_type`, `team_role`, `payment_mode`, `subscription_status`, `at_risk_reason`, `at_risk_source`, `onboarding_status`, `actor_type`, `design_approval`, `product_tier`, `payment_status`, `call_type`, `call_status`, `product`.

Drizzle schemas live in `src/db/schema/*.ts`. Inferred types via `$inferSelect` / `$inferInsert` per table.

Full schema reference: `docs/schema/production-schema.md`
Architecture details: `docs/architecture.md`

## Project Structure

```
src/
  db/
    index.ts                  -- Drizzle client + Neon serverless Pool
    schema/                   -- One file per table + enums.ts shared
    migrations/               -- Generated by drizzle-kit; checked in
  lib/
    db.ts                     -- Public data-access API. Same surface every consumer uses.
    automations/
      generate-tasks.ts       -- POST /api/customers → atomically create customer + tasks
      activate-dependents.ts  -- handleTaskCompleted: activate deps, advance stage, CSM routing,
                                 Design Ready email, Stripe sub bridge for Onboarding Call
      design-approval.ts      -- handleDesignApproved + handleDesignChangesRequested
      handle-call-completed.ts-- Stripe sub creation for setup-intent-at-intake workflows
      trigger-email.ts        -- Welcome / Design Ready email send via Resend
    stripe.ts                 -- Stripe SDK wrapper (createCustomer, createSubscription, webhook verify)
    email/                    -- Resend wrapper + React Email templates
    auth/                     -- Magic-link auth + view-as switcher for /workspace
  app/
    r/[token]/page.tsx        -- Customer portal (server component; portal_token lookup)
    b/[slug]/                 -- B2B brokerage landing page
    workspace/                -- Internal team UI (Designer / CSM / Account Creator / Admin)
    admin/                    -- Lightweight admin pages (customer list, add)
    api/
      customers/              -- POST: create (inline Auto 1); PATCH: update fields
      tasks/[taskId]/         -- PATCH: update status (fires Auto 2 inline)
      calls/[callId]/         -- PATCH: update (fires Auto 8 inline on Onboarding completed)
      customers/[id]/design-approval/  -- POST: dispatcher to design-approval automations
      customers/[id]/payment-setup/    -- Stripe SetupIntent + confirm routes
      webhooks/stripe/        -- Stripe webhook (subscription events)
      webhooks/calendly/      -- Calendly invitee.created → upsert call + complete schedule task
      upload/                 -- Vercel Blob signed-upload for attachment fields
  components/
    TaskList.tsx              -- Portal task list grouped by stage; optimistic activation
    tasks/                    -- TaskRenderer + per-type renderers (Form, Proof, Embed, FileUpload, PlainTask, PaymentSetup)

scripts/
  migrate.ts                  -- npm run db:migrate  (Drizzle migrations against Neon)
  test-db-connection.ts       -- npm run db:test
  list-tables.ts              -- npm run db:list
  smoke-{db,auto1,auto2}.ts   -- Manual smoke checks against real Neon (auto2 self-cleans)
  pitr-drill-{prep,verify}.ts -- Periodic PITR restore drill — proves backups work
  hubspot-poc/                -- HubSpot integration PoC validation script (npm run hubspot:poc)

launchpad-integration/         -- HubSpot Developer Platform Project App (file-based, deployed via `hs project upload`)
  src/app/app-hsmeta.json     -- Scopes, distribution, static auth config
  src/app/webhooks/           -- Webhook subscriptions
  See docs/integrations/hubspot-integration.md for the full architecture.

docs/
  schema/production-schema.md -- Postgres schema reference (Drizzle is source-of-truth code-wise)
  architecture.md             -- Subsystems and data flow
  plans/                      -- Architecture plans (incl. completed Airtable→Postgres migration)
  integrations/               -- Per-integration plans (DMG roster, engagement data, etc.)
  flows/                      -- Per-workflow stage+task vetted maps
```

## Environment Variables

Required in `.env.local` (and Vercel Production/Preview/Development):
```
POSTGRES_URL                          # pooled — runtime queries
POSTGRES_URL_NON_POOLING              # direct — migrations only
BLOB_READ_WRITE_TOKEN                 # Vercel Blob

STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY

RESEND_API_KEY                        # transactional email
SESSION_SECRET                        # magic-link JWT signing
ADMIN_PASSWORD                        # gates /admin in production
```

## Scripts

```bash
npm run dev                   # Start dev server
npm run build                 # Production build
npm run lint                  # ESLint
npm test                      # Vitest (Stripe webhook regression suite)

npm run db:generate           # Drizzle-kit generate (creates a new migration from schema diff)
npm run db:migrate            # Apply pending migrations to current POSTGRES_URL
npm run db:list               # Print table + row counts (sanity check)
npm run db:studio             # Drizzle Studio (browse data)
npm run db:test               # Smoke: connect, run version() + NOW()
```

Deploy: `git push` to `main`. Vercel auto-deploys via GitHub integration.

## Important Patterns

### Drizzle field naming
- Postgres columns: `snake_case`
- TS property names: `camelCase` (via Drizzle's `propName('column_name')` declaration)
- Inferred types via `typeof tableName.$inferSelect` / `$inferInsert`. Consumers pass camelCase fields; no Title-Case translation anywhere.

### Atomic transactions
- Customer creation is wrapped in `db.transaction(async (tx) => { ... })`. Auto 1's `generateTasksFromTemplate` accepts the tx so customer+tasks land or fail together.
- Auto 2 (task complete → dependent activation + stage advance) runs after the task's PATCH commits. Race-guarded by conditional UPDATE: `WHERE status='Draft'`.

### Attachments via Vercel Blob
- `customers.{agent_photo, business_logo, other_assets, design_proof, design_drafts}` are jsonb arrays of `{ url, filename, size, contentType }` objects.
- New uploads: `POST /api/upload` writes to Vercel Blob, appends the metadata to the jsonb array on the Customer row.

### Channel discipline
- `Customer.channel_id` is an FK to `channels.id`. Inserting an unknown channel fails at the DB layer. Workflow key resolved at insert as `${type}-${channel.code}`. `CHECK` constraint on `workflow_key` format as belt-and-suspenders.

## What NOT To Do

- **Do NOT write to `Customer.tasks` / `Customer.events` as denormalized arrays.** These are reverse FKs queried via `db.query.customers.findFirst({ with: { tasks: true } })` or the dedicated readers. The mapper hardcodes them to `[]`.
- **Do NOT add business logic inside API routes.** Routes are thin dispatchers. Business logic belongs in `src/lib/db.ts` or `src/lib/automations/*.ts`.
- **Do NOT bypass `updateTaskStatus` / `updateTaskFields` / `updateCall`** when transitioning a task or call. These wrap the Auto 2 / Auto 8 triggers; raw `db.update(tasks)` bypasses Auto 2 entirely.
- **Do NOT hardcode workflow logic.** All stage/task definitions live in `workflow_templates`. New workflow = new rows with a new `workflow_key`.
- **Do NOT add `recXXX`-format Airtable record-ID regex checks anywhere.** All IDs are UUIDs now.
- **Do NOT reference the prelim-docs as current.** The files in `docs/prelim-docs/` are historical only.
