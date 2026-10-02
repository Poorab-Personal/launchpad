@AGENTS.md

# LaunchPad

## What This Is

LaunchPad is Rejig.ai's customer onboarding system. Rejig is a B2B SaaS platform for real estate agents and brokerages. LaunchPad's responsibility runs from sign-up through `Launched` — customer has credentials and signed in. After `Launched`, the customer lifecycle (CSM tasks, attention-state, check-ins) lives in HubSpot Sales Pro. See `docs/plans/post-launch-migration.md` for the architectural rationale (Phase 1 shipped 2026-05-14).

Two customer types:
- **D2C** (SMB agents): full flow with intake forms, design approval, account setup, onboarding call scheduling, sign-in → `Launched`
- **B2B** (enterprise brokerages like Keyes, Baird & Warner): agents self-onboard via brokerage landing page, data pre-populated from roster API. B2B-Keyes uses Stripe trial / setup-intent — the trial subscription is created when the HubSpot Ticket moves to `Active` (post onboarding meeting), triggered by the LP ticket-stage webhook handler.

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
    [slug]/                   -- B2B brokerage landing page (bare top-level slug, e.g. /ipre)
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

## Known Data Hazards (read before quoting numbers)

### Subscription state: Stripe is truth, LP is a mirror

`customers.subscription_status` and `customers.stripe_subscription_id` are mirror
fields. They are written on specific events and go stale silently — nothing
reconciles them against Stripe on a schedule. **Never quote paying/trialing
counts from them.** Use `scripts/stripe-subs.ts` (billing reality),
`scripts/branch-funnel-report.ts --stripe` (funnel + billing reconciled), or
`scripts/renewals-digest.ts` (upcoming charges by month).

The mirror also silently breaks *selection*, not just display. A report that
filters rows on `customer_subscriptions.current_period_end` drops any customer
whose mirror is stale — no error, no unknown row, they simply fail the window
predicate. That cost the first November 2026 renewals run 4 paying customers
($3,000 omitted) while 2 already-cancelled subs were counted ($1,800). **Build
revenue reports by walking Stripe and enriching from LP, never the reverse.**
`docs/plans/renewals-digest-stripe-truth.md` has the full post-mortem and the
two upstream bugs that keep the mirror stale (both still unfixed).

### The Keyes pilot subscription

Keyes began as a pilot: ~26 agents billed as **seats on one subscription**
(`sub_1SVaSPCQTlvKI2ANEPPEOtMI`, Mike Pappas, price `price_1QrNQCC…` — **not in
`stripe_plans`**), then migrated to individual subscriptions one at a time
without their LP pointers ever being moved.

**Today that subscription is a Keyes corporate fee (verified 2026-10-02:
`price_1QrNQCC…` at $150 x 14 seats = $2,100/mo, up from $1,260/mo earlier —
seat quantity is purely a pricing lever). It covers no agents, and it is
excluded from Keyes agent-revenue reporting.** Re-read it from Stripe before
quoting the figure; it has moved once already.

Four rules follow, and they generalise to any brokerage that pilots this way:

1. **A `stripe_subscription_id` shared by several customers is a group plan, not
   junk data.** Retrieve it before concluding anything. Its seats are a
   `quantity`, never a named list — Stripe cannot tell you which agents it covers.
2. **"No individual sub" ≠ churned**, and **"LP says Active" ≠ paying**.
3. **Agents bill under identities that don't match LP** (spouse, LLC, personal
   email). Match on email *and* a normalised name key, then search Stripe
   *customers* directly before declaring anyone churned.
4. **Rejig absence is the churn signal, not the inactive flag.** The accounts
   pull returns inactive accounts too. Real churn reads as active →
   `rejig.account_active = 0` across weekly pulls → gone. Compare **full** pulls
   only (>500 users); weekday rows are deltas.

Full history, the confirmed identity mismatches, and the resolved state:
`docs/integrations/keyes-pilot-to-individual.md`.

To send a brokerage their own numbers, use the `branch-report` skill
(`.claude/skills/branch-report/SKILL.md`) — it enforces `--stripe --external
--exclude`, without which the counts are wrong or the email leaks phone numbers
and plan prices.

For "what renews this month / who is at risk", use the `renewals-digest` skill
(`.claude/skills/renewals-digest/SKILL.md`). It reads Stripe as the source of
truth, buckets KW self-serve separately from LaunchPad cohorts, and puts
unmatched Stripe subs in Unclear rather than dropping them. Always pass
`--exclude @rejig.ai`; internal test subs bill on real plans in the live
account.

## What NOT To Do

- **Do NOT write to `Customer.tasks` / `Customer.events` as denormalized arrays.** These are reverse FKs queried via `db.query.customers.findFirst({ with: { tasks: true } })` or the dedicated readers. The mapper hardcodes them to `[]`.
- **Do NOT add business logic inside API routes.** Routes are thin dispatchers. Business logic belongs in `src/lib/db.ts` or `src/lib/automations/*.ts`.
- **Do NOT bypass `updateTaskStatus` / `updateTaskFields` / `updateCall`** when transitioning a task or call. These wrap the Auto 2 / Auto 8 triggers; raw `db.update(tasks)` bypasses Auto 2 entirely.
- **Do NOT hardcode workflow logic.** All stage/task definitions live in `workflow_templates`. New workflow = new rows with a new `workflow_key`.
- **Do NOT add `recXXX`-format Airtable record-ID regex checks anywhere.** All IDs are UUIDs now.
- **Do NOT reference the prelim-docs as current.** The files in `docs/prelim-docs/` are historical only.
