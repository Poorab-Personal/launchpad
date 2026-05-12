# Production Schema Reference

**Authoritative source:** Drizzle schemas in `src/db/schema/*.ts`. This doc is a high-level reference for humans — the code is always more current.

Inspect live state with:
```bash
npm run db:list           # tables + row counts + constraint summary
npm run db:studio         # Drizzle Studio in your browser
```

## Tables

### Operational

| Table | File | Purpose | Key columns |
|---|---|---|---|
| `customers` | `customers.ts` | Customer/agent onboarding record (~71 cols) | `id`, `access_token`, `name`, `type` (D2C/B2B), `channel_id` (FK), `workflow_key`, `current_stage`, `stripe_customer_id`, `stripe_subscription_id`, `at_risk`, `at_risk_reason`, design fields, payment fields, status flags |
| `tasks` | `tasks.ts` | All tasks (client + team) per customer | `id`, `customer_id` (FK cascade), `task_name`, `stage`, `stage_order`, `task_order`, `status` (Draft/Active/In Review/Completed/Rejected), `task_type` (Client/Team), `assigned_to_team_member_id` (FK), `attachment_type`, `product` |
| `task_dependencies` | `tasks.ts` | Junction table: which task depends on which | `task_id`, `depends_on_task_id` (both FK to tasks, cascade) |
| `calls` | `calls.ts` | Onboarding / Check-In / Ad-hoc calls | `id`, `customer_id`, `type`, `scheduled_date`, `status`, `csm_team_member_id`, `calendly_event_uuid` (UNIQUE for idempotency) |
| `events` | `events.ts` | Audit log of every state change | `id`, `customer_id`, `event_type`, `actor_type`, `details` (jsonb), `related_task_id`, `related_call_id`, `created_at` |
| `roster` | `roster.ts` | One-time bridge row for B2B agents from DMG sync | `id`, `customer_id` (set null on cascade), `brokerage_id`, `email`, asset URLs |

### Config / Reference

| Table | File | Purpose |
|---|---|---|
| `workflow_templates` | `workflowTemplates.ts` | Blueprint rows defining stages/tasks per `workflow_key`. Read by Auto 1 (`generateTasksFromTemplate`) at customer creation. |
| `channels` | `channels.ts` | Lookup: `Standard`, `Keyes`, `BW`. Seeded once at migration. FK target for `customers.channel_id` — prevents the `"BW"` vs `"Baird & Warner"` typo class. |
| `brokerages` | `brokerages.ts` | Brokerage-level config (landing page slug, default Calendly URL, default workflow key) |
| `team_members` | `teamMembers.ts` | Internal team. `roles` is a `team_role[]` array (multi-role). `is_default` flags the default member per role for Auto 1 assignments. |
| `stripe_plans` | `stripePlans.ts` | Per-workflow Stripe price options. Read by Capture Payment Method task to populate the plan picker. |
| `settings` | `settings.ts` | Key-value app settings (e.g. `portal_base_url`) |

## Enums

Defined in `src/db/schema/enums.ts`. Centralized so multiple tables share values.

| Enum | Values |
|---|---|
| `customer_type` | `D2C`, `B2B` |
| `task_type` | `Client`, `Team` |
| `task_status` | `Draft`, `Active`, `In Review`, `Completed`, `Rejected` |
| `attachment_type` | `None`, `Form`, `File Upload`, `Embed`, `Proof`, `Payment Setup` |
| `team_role` | `Designer`, `Senior Designer`, `CSM`, `Senior CSM`, `Account Creator`, `Sales`, `Admin` |
| `payment_mode` | `pre-paid`, `setup-intent-at-intake`, `invoice`, `none` |
| `subscription_status` | `Active`, `Trial`, `Past Due`, `Cancelled` |
| `at_risk_reason` | `No CC`, `No Booking`, `No Approval`, `No Form`, `CSM Flagged`, `Inactive`, `Trial Ending`, `Disengaged`, `No Listings`, `Engagement Falling`, `Churned` (split ownership: first 5 owned by payment-mode plan, rest by engagement plan) |
| `at_risk_source` | `engagement`, `payment-mode`, `csm` |
| `onboarding_status` | `Not Started`, `In Progress`, `Completed` |
| `actor_type` | `Customer`, `Team Member`, `System` |
| `design_approval` | `Pending`, `Approved`, `Changes Requested` |
| `product_tier` | `Premium`, `Luxury` |
| `payment_status` | `Paid`, `Waived` |
| `call_type` | `Onboarding`, `Check-In 1`, `Check-In 2`, `Ad-hoc` |
| `call_status` | `Scheduled`, `Completed`, `No Show`, `Rescheduled`, `Canceled` |
| `product` | `Core`, `Voice`, `Avatar` |

## Constraints + Indexes

`customers`:
- `access_token` UNIQUE — portal URL key
- `channel_id` FK to `channels.id` (validates against typo class)
- `workflow_key` CHECK regex `^(D2C|B2B)-` — belt-and-suspenders on the format
- `brokerage_id` FK to `brokerages.id` (set null), `roster_record_id` FK to `roster.id` (set null), `csm_team_member_id` FK to `team_members.id` (set null)
- Indexes on `platform_email`, `contact_email`, `workflow_key` — high-traffic lookup paths

`tasks`:
- `customer_id` FK CASCADE — tasks die with their customer
- `assigned_to_team_member_id` FK SET NULL — team turnover doesn't delete tasks
- Composite index `(customer_id, stage_order, task_order)` — drives the portal task-list render
- Index `assigned_to_team_member_id` — designer/CSM queue lookups
- Partial index `(customer_id) WHERE status IN ('Active', 'In Review')` — active-work dashboards

`task_dependencies`:
- Both FKs CASCADE
- UNIQUE `(task_id, depends_on_task_id)` — no duplicate edges

`calls`:
- `calendly_event_uuid` UNIQUE — webhook idempotency

`workflow_templates`:
- Composite index `(workflow_key, stage_order, task_order)` — drives Auto 1's template scan

`events`:
- `customer_id` FK CASCADE
- `event_number` UNIQUE bigserial — external reference stability

## Workflow Templates Data

Read live (most accurate):
```bash
npx tsx --env-file=.env.local scripts/dump-templates.ts
```

Or query:
```sql
SELECT workflow_key, stage_order, task_order, task_title, initial_status, depends_on
FROM workflow_templates
ORDER BY workflow_key, stage_order, task_order;
```

Per-workflow flow docs live in `docs/flows/{d2c-standard,b2b-keyes,b2b-bw}.md`. Those describe the canonical onboarding journey; templates implement it.

## Migrations

| File | Purpose |
|---|---|
| `src/db/migrations/0000_*` | Initial schema (channels + customers) |
| `src/db/migrations/0001_*` | 9 more tables + their internal FKs |
| `src/db/migrations/0002_*` | Cross-table FKs added (brokerage_id, roster_record_id, csm_team_member_id) |
| `src/db/migrations/0003_*` | Audit fixes — indexes, uniqueness |
| `src/db/migrations/0004_*` | Customer feedback fields (`feedback_rating`, `feedback_comments`) |

Generate a new migration after schema changes:
```bash
npm run db:generate    # produces a new src/db/migrations/000N_*.sql file
npm run db:migrate     # applies pending migrations to the current POSTGRES_URL
```

Migrations are checked in; production runs them on deploy via the migrate script.
