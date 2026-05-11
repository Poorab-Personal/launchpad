# Plan — Airtable → Postgres Migration

**Status:** Draft v2, applies Plan-agent review 2026-05-11
**Author:** Claude (LaunchPad), prompted by poorab@
**Date:** 2026-05-11
**Reviewers wanted:** push back on scope, the config-editing decision, the automation port, the "things we might miss" audit, and the payment-mode Phase 1 re-port plan in §13.

## Changes from v1 (post Plan-agent review)

- Table count corrected: **10 tables**, not 8. Added `Settings` (read on every email send) and `Stripe Plans` (shipped in payment-mode Phase 1.2; queried by `getStripePlansForWorkflow`).
- Automation list corrected to match actual `scripts/airtable-automations/` files. Six script files, eight deployed automations: Auto 1, 2, 3 (disabled), 4 (Mark Onboarding Call Complete — not "Design Approval"), 5 (Welcome email), 6 (Design Ready email), 7 (Credentials email — paused), 8 (Stripe Sub Creation — **active**, not superseded).
- Customer schema (§5.1) rewritten from `src/types/index.ts` — added ~20 missing fields (`platformEmail`, `phone`, `businessName`, `businessAddress`, `website`, `serviceAreas`, `localContentAreas`, `bio`, `licenseNumber`, `topics`, `hashtags`, `gmbName`, `mlsIds`, `specialInstructions`, attachment columns, HubSpot/Stripe payment IDs, design fields, add-on fields, `accessToken`, `portalBaseUrl`, etc.).
- Tasks schema: added `embedUrl`, `tags[]`, `dueDate`, `daysActive`, `product` (`Core | Voice | Avatar`).
- Workflow Templates: added `embedUrl`, `dueDaysAfterActivation`, `planFeatures`. Per-plan pricing moves to a separate `stripe_plans` table (matches what payment-mode Phase 1.2 already shipped).
- New tables in §5: `settings`, `stripe_plans`. Roster table kept (it's the verified-and-started-onboarding bridge row per DMG plan §3.2, not vestigial).
- §13 rewritten: payment-mode Phase 1 has **already shipped** (`src/lib/stripe.ts`, `src/app/api/webhooks/{stripe,calls,calendly}`). This is a real code port, not the "editorial pass" the v1 claimed.
- DMG roster plan's `customer_record_id TEXT` becomes `customer_id uuid`; that file needs a coordinated update.
- Estimate revised: **6–8 weeks**, not 4–5.
- Added: SQL-injection / config-editing safety considerations; Stripe webhook URL stability checklist; Channel string verification carryover from DMG plan.
- Config-editing decision **locked** per architect signoff 2026-05-11: native `/workspace/admin` CRUD, no SaaS admin tools. Retool/Outerbase/Drizzle Studio explicitly rejected as the primary interface.
- Architect signoff 2026-05-11 adjustments applied: (1) Stripe webhook integration tests promoted to Phase 1 deliverable, not Phase 7 verification — they're the regression net for everything that follows; (2) Neon PITR + live restore drill made a hard gate on Phase 7 cutover, not a soft pre-launch checklist item; (3) Channel becomes FK to new `channels` lookup table (§5.11) — locks in v1 to seal the `"BW"` vs `"Baird & Warner"` typo class.

---

## 1. Context

LaunchPad currently splits state across:

- **Airtable** — 10 tables (Customers, Tasks, Workflow Templates, Roster, Events, Team Members, Brokerages, Calls, Settings, Stripe Plans) and 8 deployed automations across 6 script files in `scripts/airtable-automations/`: Auto 1 (Generate Tasks), Auto 2 (Activate Dependents + Advance Stage), Auto 3 (In Review intercept — currently disabled), Auto 4 (Mark Onboarding Call Complete → set CSM + Check-In Calendly URLs), Auto 5 (Welcome email via `/api/email/send`), Auto 6 (Design Ready email), Auto 7 (Credentials email — paused), Auto 8 (Onboarding Call Completed → POST `/api/webhooks/calls/completed` for Stripe sub creation — **active** per payment-mode Phase 1).
- **Vercel Postgres / Neon** — planned for the DMG roster integration (`docs/integrations/dmg-roster-plan.md`) and for engagement-data ingestion (`docs/integrations/engagement-data-plan.md`).

The trajectory was "engineering data goes to Postgres, customer/task data stays in Airtable" — two stores, two field-naming conventions, no SQL joins across them, no transactional guarantees, two sets of integration patterns.

The original justification for Airtable was:

1. Internal team uses Airtable Interface Designer for daily workflow.
2. Spreadsheet UI for power editing of config.
3. Implicit per-field audit history.
4. Forms.

(1) is **no longer true** as of 2026-05-11 — internal team uses `/workspace` (Next.js) for all daily work; Interfaces were too limiting and scope expanded well beyond the original Designer-only MVP. With (1) gone, (2)/(3)/(4) are not enough to justify the architectural split. (4) we don't use anyway.

This plan migrates the 10 Airtable tables + 8 deployed automations to Postgres before the system goes live, so engagement data, DMG roster data, and customer/task data all live in one place from day one.

## 2. Why now

- **Not live.** Customer-facing routes (`/r/[token]`, `/b/[slug]`) and internal `/workspace` are not yet in production use. No live-customer migration risk.
- **DMG roster plan is drafted, not yet built.** Can be implemented natively against Postgres.
- **Payment-mode Phase 1 has already shipped** (Stripe webhook code in `src/lib/stripe.ts`, three webhook routes under `src/app/api/webhooks/`, Stripe Plans table seeded). The migration must **port these real implementations** rather than re-derive from the plan doc. See §13 for the explicit port surface.
- **Two upcoming integrations already need Postgres.** DMG roster (5–20k+ agent rows per brokerage) and engagement-data (~250k snapshot rows/year) exceed Airtable's practical limits. Postgres is happening regardless; question is whether the *rest* joins it.
- **Engagement layer benefits directly.** SQL joins between customer/task data and engagement snapshots become trivial.
- **Atomicity wins.** Customer-create + task-generation can be a single transaction. Dependency activation + stage advance can be a single transaction. Today neither is.

## 3. Target architecture

```
Layer 1: Vercel Postgres / Neon   — Single store. All 8 tables + new tables.
         (Drizzle ORM)              Drizzle migrations as schema source-of-truth.
                                    Vercel Blob for file attachments.

Layer 2: Vercel cron + inline TS   — "Automations" become sync TS functions called
                                    inline from API routes (no triggers, no queues).
                                    Cron handles roster sync, engagement sync,
                                    dropoff reminders.

Layer 3: Next.js                   — /r portal, /b landing, /workspace, /admin.
                                    Reads/writes Postgres via Drizzle.
                                    Components unchanged.
```

`src/lib/airtable.ts` → `src/lib/db.ts` (same public API surface).
`scripts/airtable-automations/*` → `src/lib/automations/*.ts`.
`CLAUDE.md`, `docs/architecture.md`, `docs/schema/production-schema.md` all rewritten.

## 4. What Airtable does for us today, and the Postgres equivalent

The replacement audit. Anything missing here is a risk that we'll regret the migration mid-flight.

| Airtable capability | Used for | Postgres replacement |
|---|---|---|
| Tables | 10 tables (8 operational + Settings + Stripe Plans) | Drizzle schema |
| Linked records | Customer↔Brokerage, Task↔Customer, Task↔Team Member, Customer↔Roster, Customer↔Call, etc. | Proper FK columns + relations |
| Single-select fields | Status enums, stages, channel, `At Risk Reason`, `Payment Mode` | Postgres enums or text + check constraints |
| Multi-select fields | Team Members.Role, Tasks.Tags | `text[]` or junction tables |
| Formulas | `Workflow Key = {Type}-{Channel}`, `RECORD_ID()` for `Access Token`, `Days Active` on tasks | Generated columns OR computed in app code at write time |
| Lookups (e.g. Team Member.Email on Task) | Cross-table reads | SQL joins |
| Attachments | Design proofs (Customer.designProof, .designDrafts), agent photo, business logo, other assets | Vercel Blob (or S3 equivalent); see §7 |
| Automations (8 deployed across 6 scripts) | Task generation, dependency activation, in-review intercept (disabled), CSM/Calendly assignment on call complete, three transactional emails (Welcome, Design Ready, Credentials), Stripe sub creation on call complete | Inline TS functions in API routes + cron + the existing webhook routes; see §6 |
| Grid view (spreadsheet UI) | Power editing of config (Workflow Templates, Brokerages, Team Members, Stripe Plans, Settings) | **Decision in §8** — recommendation reassessed below |
| Per-field change history | Implicit audit | Explicit `events` table (already exists); add `audit_log` later if needed; **caveat**: Neon PITR must be configured and tested before cutover (real downgrade vs. Airtable revision history until it is) |
| Webhooks (Calendly → Calls) | Calls table is upserted by Calendly webhook (idempotent on `Calendly Event UUID`) | Webhook handler at `/api/webhooks/calendly` upserts Postgres `calls` on `calendly_event_uuid` UNIQUE constraint |
| Webhooks (Stripe → Customer) | `setup_intent.succeeded`, subscription events update Customer fields | Already at `/api/webhooks/stripe`; ports as-is (uses `src/lib/stripe.ts`) |
| Webhooks (Airtable → /api/webhooks/calls/completed) | Auto 8 — Stripe sub creation | Becomes app-internal call: when `PATCH /api/calls/:id` sets `status='Completed' AND type='Onboarding'`, invoke `createSubscriptionForCustomer(customer)` inline. Retires the Airtable→Vercel webhook entirely. |
| API for Zapier (HubSpot → Customer) | Deal-close creates a Customer | Zapier hits Next.js API route |
| Settings table (Portal Base URL etc.) | Read on every email send | `settings` table; cached in-process for the request lifecycle |
| Stripe Plans table | Per-workflow plan options (Phase 1.2 of payment-mode plan, **already shipped**) | `stripe_plans` table — see §5.10 |
| Channel string discipline | `Customer.Channel = "BW"` not "Baird & Warner"; typo silently breaks Workflow Key lookup | Either an FK to a `channels` lookup table, or a check constraint listing the valid set. Carry forward DMG plan §3.3 warning. |
| Sharing single records externally | Not used | N/A |
| Forms | Not used | N/A |

Nothing in this table that we can't replace. Section 11 has the explicit pre-mortem.

## 5. Schema migration

Sketches per table, regenerated from `src/types/index.ts` (the canonical source for what app code actually reads/writes). Full Drizzle schemas + indexes land at implementation.

### 5.1 Customers

```ts
export const customers = pgTable('customers', {
  id: uuid('id').primaryKey().defaultRandom(),
  accessToken: uuid('access_token').notNull().unique().defaultRandom(),  // /r/[token]

  // Identity
  name: text('name').notNull(),
  type: customerTypeEnum('type').notNull(),              // D2C | B2B
  channelId: uuid('channel_id').notNull().references(() => channels.id),  // FK — seals "BW vs Baird & Warner" typo class
  workflowKey: text('workflow_key').notNull(),           // resolved at insert time from channels.code; see channels table
  contactEmail: text('contact_email').notNull(),
  platformEmail: text('platform_email').notNull(),       // distinct from contact; used for portal login
  phone: text('phone'),

  // Business info
  businessName: text('business_name'),
  businessAddress: text('business_address'),
  website: text('website'),
  serviceAreas: text('service_areas'),
  localContentAreas: text('local_content_areas'),
  bio: text('bio'),
  licenseNumber: text('license_number'),
  topics: text('topics'),
  hashtags: text('hashtags'),
  gmbName: text('gmb_name'),
  mlsIds: text('mls_ids'),
  specialInstructions: text('special_instructions'),

  // Assets — see §7 (Vercel Blob); arrays of object metadata, not just URLs
  agentPhoto: jsonb('agent_photo'),                      // [{ url, filename, size, contentType }]
  businessLogo: jsonb('business_logo'),
  otherAssets: jsonb('other_assets'),

  // Payment & deal (D2C)
  hubspotDealId: text('hubspot_deal_id'),
  stripePaymentId: text('stripe_payment_id'),
  addOnStripePaymentId: text('add_on_stripe_payment_id'),
  productTier: text('product_tier'),                     // Premium | Luxury
  paymentStatus: text('payment_status'),                 // Paid | Waived

  // Stripe (payment-mode plan, Phase 1 shipped)
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  selectedStripePriceId: text('selected_stripe_price_id'),
  selectedPlanName: text('selected_plan_name'),
  subscriptionStatus: text('subscription_status'),       // Active | Trial | Past Due | Cancelled — written by Stripe webhook
  mrr: numeric('mrr'),                                   // pre-existing CRM field; preserved
  renewalDate: date('renewal_date'),                     // pre-existing CRM field; preserved
  billingCycle: text('billing_cycle'),                   // pre-existing CRM field; preserved

  // Drop-off / At Risk (payment-mode plan)
  atRisk: boolean('at_risk').default(false).notNull(),
  atRiskReason: atRiskReasonEnum('at_risk_reason'),      // No CC | No Booking | No Approval | No Form | CSM Flagged | (engagement-plan additions in §3 of that doc)

  // Enterprise (B2B)
  brokerageId: uuid('brokerage_id').references(() => brokerages.id),
  rosterRecordId: uuid('roster_record_id').references(() => roster.id),  // the bridge row, not bulk roster_agents

  // Assignment
  csmTeamMemberId: uuid('csm_team_member_id').references(() => teamMembers.id),

  // Design workflow (D2C)
  designApproval: text('design_approval'),               // Pending | Approved | Changes Requested
  designFeedback: text('design_feedback'),
  designRevisionCount: integer('design_revision_count').default(0),
  designProof: jsonb('design_proof'),                    // customer-facing curated set
  designDrafts: jsonb('design_drafts'),                  // internal WIP, never customer-visible
  designProofsUpdatedAt: timestamp('design_proofs_updated_at'),

  // Add-ons
  hasVoice: boolean('has_voice').default(false),
  hasAvatar: boolean('has_avatar').default(false),
  voiceStage: text('voice_stage'),
  avatarStage: text('avatar_stage'),
  voiceStripeId: text('voice_stripe_id'),
  avatarStripeId: text('avatar_stripe_id'),

  // Status tracking
  currentStage: text('current_stage').notNull(),
  stageEnteredAt: timestamp('stage_entered_at'),
  accountCreated: boolean('account_created').default(false),
  credentialsSent: boolean('credentials_sent').default(false),
  callBooked: boolean('call_booked').default(false),
  callCompleted: boolean('call_completed').default(false),
  callDate: timestamp('call_date'),                      // denormalized for portal backwards-compat; written by Calendly webhook
  noShowCount: integer('no_show_count').default(0),
  otherEmails: text('other_emails'),

  // System
  environment: text('environment').array(),              // for test/prod isolation
  rejigAccountId: text('rejig_account_id'),              // engagement-data join

  createdAt: timestamp('created_at').notNull().defaultNow(),
  lastModified: timestamp('last_modified').notNull().defaultNow(),
});
```

Notes:
- `channelId` is an FK to a small `channels` lookup table (see §5.11). Resolves the "Baird & Warner" vs `"BW"` typo class flagged in DMG plan §3.3 — invalid channels can't be inserted at all. `workflowKey` is computed at insert time from `channels.code` rather than as a generated column, since the formula source is now a join target. Architect signoff 2026-05-11.
- `subscriptionStatus`, `MRR`, `Renewal Date`, `Billing Cycle` are pre-existing CRM fields per payment-mode "Schema findings 2026-05-06". Preserved as-is; the Stripe webhook (already shipped) writes `subscriptionStatus`.
- `atRiskReason` enum is closed: `'No CC' | 'No Booking' | 'No Approval' | 'No Form' | 'CSM Flagged'` (matches `src/types/index.ts`). Engagement plan adds values via the coordination model in that plan's §3 — do **not** make it a free-form text column.
- Portal URL becomes `/r/[access_token]` with UUID instead of `recXXX`. Pre-launch, no impact.
- `agentPhoto` / `businessLogo` / `otherAssets` / `designProof` / `designDrafts` are JSONB arrays preserving Airtable attachment metadata (filename + URL + size + contentType). Vercel Blob URLs replace the Airtable CDN URLs. See §7.

### 5.2 Tasks + task_dependencies

```ts
export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  taskName: text('task_name').notNull(),
  stage: text('stage').notNull(),
  stageOrder: integer('stage_order').notNull(),
  taskOrder: integer('task_order').notNull(),
  taskType: text('task_type').notNull(),                       // Client | Team
  status: taskStatusEnum('status').notNull(),                  // Draft | Active | In Review | Completed | Rejected
  attachmentType: text('attachment_type'),                     // None | Form | File Upload | Embed | Proof | Payment Setup
  embedUrl: text('embed_url'),                                 // denormalized at task creation; per-template
  visibleToClient: boolean('visible_to_client').default(true),
  hasTeamReview: boolean('has_team_review').default(false),
  assignedToTeamMemberId: uuid('assigned_to_team_member_id').references(() => teamMembers.id),
  product: text('product').notNull().default('Core'),          // Core | Voice | Avatar
  instructions: text('instructions'),
  tags: text('tags').array(),                                  // Design Change | Dev Request | Priority | Follow Up — used for triage
  notes: text('notes'),
  dueDate: date('due_date'),
  daysActive: integer('days_active').generatedAlwaysAs(
    sql`CASE WHEN activated_at IS NOT NULL THEN EXTRACT(DAY FROM (COALESCE(completed_at, NOW()) - activated_at))::int ELSE NULL END`
  ),
  lastReminderAt: timestamp('last_reminder_at'),
  activatedAt: timestamp('activated_at'),
  completedAt: timestamp('completed_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const taskDependencies = pgTable('task_dependencies', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  dependsOnTaskId: uuid('depends_on_task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  // UNIQUE (task_id, depends_on_task_id)
});
```

Notes:
- `attachmentType` includes `Payment Setup` (added in payment-mode Phase 1 — Stripe Elements gets its own renderer; not a variant of `Embed`).
- `embedUrl` is per-task and denormalized at creation from the Workflow Template row. Re-stamped on Check-In tasks by Auto 4 (CSM-specific Calendly URL).
- `tags` is a multi-select used for triage in `/workspace`. Don't drop silently — preserve as `text[]`.
- `daysActive` as a generated column replaces the Airtable formula.

**Big win:** the comma-separated `Depends On` text field becomes a real junction table. Multi-dep checks become a SQL query. CLAUDE.md's "Do NOT use multi-record Depends On links" warning becomes obsolete.

### 5.3 Workflow Templates

```ts
export const workflowTemplates = pgTable('workflow_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  workflowKey: text('workflow_key').notNull(),                // D2C-Standard | B2B-Keyes | B2B-BW
  stage: text('stage').notNull(),
  stageOrder: integer('stage_order').notNull(),
  taskOrder: integer('task_order').notNull(),
  taskTitle: text('task_title').notNull(),
  taskType: text('task_type').notNull(),                      // Client | Team
  assignedRole: text('assigned_role'),                        // Designer | Senior Designer | CSM | Onboarding Ops | Account Creator
  initialStatus: text('initial_status').notNull(),            // Active | Draft
  dependsOn: text('depends_on'),                              // comma-separated names; resolved at generation
  hasTeamReview: boolean('has_team_review').default(false),
  attachmentType: text('attachment_type'),
  embedUrl: text('embed_url'),                                // copied per-template at task creation
  visibleToClient: boolean('visible_to_client').default(true),
  product: text('product').notNull().default('Core'),
  instructions: text('instructions'),
  dueDaysAfterActivation: integer('due_days_after_activation'),
  planFeatures: text('plan_features'),                        // newline-separated bullets; denormalized per Workflow Key

  // From payment-mode plan (header-level, denormalized onto every row sharing a workflow_key)
  paymentMode: text('payment_mode'),                          // pre-paid | setup-intent-at-intake | invoice | none
  trialDays: integer('trial_days'),
});
```

Notes:
- `dependsOn` is text (comma-separated) on the template itself because it references other rows in the same template set. Auto 1's port resolves these to real FK rows in `task_dependencies` at customer creation.
- **Per-plan pricing lives in a separate `stripe_plans` table** (§5.10) — payment-mode Phase 1.2 shipped this way. `stripePriceId` and `trialDays` are NOT on workflow_templates per row; trial_days is workflow-level, prices are per-plan-per-workflow.

### 5.4 Roster (bridge row, not deprecated)

Per DMG plan §3.2, the Airtable Roster table is repurposed (not deleted) post-DMG: it holds the one-time-copy bridge row for agents who have **verified and started onboarding**. Bulk DMG roster lives in `roster_agents` (DMG plan). The Airtable Roster row is the audit trail of "this is what we copied from DMG into Customer X at time T."

```ts
export const roster = pgTable('roster', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
  brokerageId: uuid('brokerage_id').references(() => brokerages.id),
  email: text('email').notNull(),
  otherEmails: text('other_emails').array(),
  name: text('name'),
  photoUrl: text('photo_url'),
  logoUrl: text('logo_url'),
  onboardingStatus: text('onboarding_status'),               // Not Started | In Progress | Completed
  syncedAt: timestamp('synced_at').notNull().defaultNow(),
  // ... other fields per current src/types/index.ts RosterAgent interface
});
```

For D2C: still no `roster` row; the Customer record holds the data directly. Roster bridge rows are B2B-only.

### 5.5 Events

```ts
export const events = pgTable('events', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'cascade' }),
  taskId: uuid('task_id').references(() => tasks.id),
  callId: uuid('call_id').references(() => calls.id),
  eventType: text('event_type').notNull(),         // Task Completed, Task Activated, Stage Changed, Design Approved, Roster Synced, etc.
  details: jsonb('details'),
  occurredAt: timestamp('occurred_at').notNull().defaultNow(),
  actorEmail: text('actor_email'),                 // CSM, cron, customer, system
});
```

### 5.6 Team Members

```ts
export const teamMembers = pgTable('team_members', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  roles: text('roles').array().notNull(),          // Designer, CSM, Account Creator, Admin, Senior Designer
  slackHandle: text('slack_handle'),
  active: boolean('active').default(true).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
```

### 5.7 Brokerages

```ts
export const brokerages = pgTable('brokerages', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  landingPageSlug: text('landing_page_slug').notNull().unique(),   // /b/[slug]
  workflowKey: text('workflow_key').notNull(),
  defaultCalendlyUrl: text('default_calendly_url'),
  supportContactName: text('support_contact_name'),
  supportContactEmail: text('support_contact_email'),
  supportContactPhone: text('support_contact_phone'),
  active: boolean('active').default(true).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
```

### 5.8 Calls

```ts
export const calls = pgTable('calls', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  csmTeamMemberId: uuid('csm_team_member_id').references(() => teamMembers.id),
  title: text('title').notNull(),
  type: text('type').notNull(),                    // Onboarding, Check-In 1, Check-In 2, Ad-hoc
  scheduledAt: timestamp('scheduled_at').notNull(),
  status: text('status').notNull(),                // Scheduled, Completed, No Show, Rescheduled, Canceled
  notes: text('notes'),
  recordingUrl: text('recording_url'),
  calendlyEventUuid: text('calendly_event_uuid').unique(),  // idempotency
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
```

Note: when `calls.status` flips to `Completed AND type = 'Onboarding'`, the API route also writes `customers.callDate` and `customers.callCompleted` denormalized fields for portal backwards-compat (currently the Calendly webhook does this; post-migration, the inline handler does).

### 5.9 Settings

Single-row table (or key-value style) holding global config. Today: `Portal Base URL`. Read on every email send and any place that builds a customer-facing URL.

```ts
export const settings = pgTable('settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: text('key').notNull().unique(),
  value: text('value').notNull(),
  description: text('description'),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
```

Initial rows: `portal_base_url = 'https://launchpad-indol-ten.vercel.app'` (prod) or per-env.

### 5.10 Stripe Plans

Shipped in payment-mode Phase 1.2. Per-workflow plan options the customer picks during Capture Payment Method.

```ts
export const stripePlans = pgTable('stripe_plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  planName: text('plan_name').notNull(),
  workflowKey: text('workflow_key').notNull(),
  stripePriceId: text('stripe_price_id').notNull(),
  active: boolean('active').default(true).notNull(),
  description: text('description'),
  priceDisplay: text('price_display'),                       // e.g. "$199"
  pricePeriod: text('price_period'),                         // e.g. "/mo"
  billingDetail: text('billing_detail'),
  footnote: text('footnote'),
  highlight: text('highlight'),
  displayOrder: integer('display_order'),                    // nullable; falls back to plan_name alpha
});
// index on (workflow_key, active)
```

Reads: `getStripePlansForWorkflow(workflowKey)` is currently in `src/lib/airtable.ts:826`. Becomes `src/lib/db.ts` equivalent.

### 5.11 Channels (lookup table)

Seals the typo class today flagged by DMG plan §3.3 — `Customer.Channel = "Baird & Warner"` (instead of `"BW"`) silently breaks workflow-key lookup. With an FK from `customers.channel_id`, invalid channels can't be inserted at all.

```ts
export const channels = pgTable('channels', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(),                     // 'Standard' | 'Keyes' | 'BW' — joined to Customer.type for workflow_key
  displayName: text('display_name').notNull(),                // 'D2C Standard' | 'Keyes' | 'Baird & Warner'
  customerType: customerTypeEnum('customer_type').notNull(),  // D2C | B2B — for validation that workflow_key shape matches
  active: boolean('active').default(true).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
// initial rows seeded by migration:
//   ('Standard', 'D2C Standard', 'D2C', true)
//   ('Keyes',    'Keyes',         'B2B', true)
//   ('BW',       'Baird & Warner','B2B', true)
```

When inserting a Customer, `workflowKey` is computed at the app layer as `${type}-${channel.code}` and stored on the row. (Generated column would also work but requires the channels join at write-time; resolving in app code is simpler.) Workflow templates' `workflow_key` references the same string set; add a CHECK constraint that `workflow_templates.workflow_key` is in the seeded set, OR an FK from `workflow_templates.channel_id` if templates one day need per-channel variants beyond the current shape.

## 6. Automation port

Eight deployed automations across 6 script files in `scripts/airtable-automations/`. All become inline TS functions in `src/lib/automations/` (or live where they already do, in routes that already exist for the shipped payment-mode flow). The Airtable scripts are then retired.

| # | Source script | What it does today | Becomes | Trigger |
|---|---|---|---|---|
| Auto 1 | `auto1-generate-tasks.js` | On new Customer: read Workflow Templates by workflow_key, create Tasks (resolving dependencies, copying embed_url + visibility + product), set Customer.current_stage to first stage | `generateTasksFromTemplate(tx, customer)` | `POST /api/customers` (same tx) |
| Auto 2 | `auto2-activate-dependents.js` | On Task Completed: activate dependents whose Depends On is satisfied, advance current_stage if all stage tasks complete, log Events | `activateDependents(tx, task)` + `maybeAdvanceStage(tx, customerId)` + `logEvent(tx, ...)` | `PATCH /api/tasks/:id` (same tx) |
| Auto 3 | `auto3-in-review-intercept.js` | **Disabled in Airtable** — was intended to notify Senior Designer on Status=In Review | Skip; if/when re-enabled becomes `notifySeniorReviewer(task)` fire-and-forget | n/a |
| Auto 4 | `auto4-call-complete.js` | On Task "Mark Onboarding Call Complete" → Completed: find the team member who completed it (the actual CSM), set `Customer.csm_team_member_id`, look up CSM's Calendly URL, write `embed_url` onto Check-In 1 + Check-In 2 tasks | `assignCsmAndCheckInUrls(tx, task)` | `PATCH /api/tasks/:id` when matched task completes (same tx) |
| Auto 5 | `auto5-7-email-send.js` (template=`welcome`) | On Customer insert: POST `/api/email/send` with `template=welcome` | Inline call to email-send helper, fire-and-forget after Customer insert tx commits | `POST /api/customers` (after commit) |
| Auto 6 | `auto5-7-email-send.js` (template=`design-ready`) | On Task "Review & Approve Your Brand Kit" → Active: POST `/api/email/send` with `template=design-ready` | Inline call, fire-and-forget after task-update tx commits | `PATCH /api/tasks/:id` (after commit) |
| Auto 7 | `auto5-7-email-send.js` (template=`credentials`) | **Paused per Auto 5-7 script header** — was on Task "Send Credentials" → Completed | Plumb but leave disabled by a flag in `settings`. Re-enable when account-creation flow stabilizes. | n/a (paused) |
| Auto 8 | `auto8-stripe-sub-creation.js` | **Active.** On `Call.status='Completed' AND type='Onboarding'`: POSTs Call ID to `/api/webhooks/calls/completed` (with `AIRTABLE_WEBHOOK_SECRET`). LaunchPad creates the Stripe subscription. | The Airtable→Vercel webhook hop goes away entirely. When `PATCH /api/calls/:id` (or the Calendly webhook) sets `status='Completed' AND type='Onboarding'`, the route directly invokes `createSubscriptionForCustomer(tx, call.customerId)`. **The Stripe webhook + `/api/webhooks/calls/completed` route stay** — Auto 8 is retired, not the route. | inline in `PATCH /api/calls/:id` and/or Calendly webhook |

**The "design approval" flow** (Customer.design_approval changes to Approved / Changes Requested) is NOT in `scripts/airtable-automations/` — it's implemented in `src/app/api/customers/[id]/design-approval/route.ts` per CLAUDE.md. That route stays as-is; the "bridge logic" exception in CLAUDE.md goes away because all *other* automations now also live in app code.

**Atomicity wins:**
- Customer insert + task generation + welcome email queue in one tx + post-commit email send (today: 3 separate Airtable triggers, can desync).
- Task completion + dependent activation + stage advance + event log + (if Mark Onboarding Call Complete) CSM/Check-In wiring, all in one tx.
- Calls.Completed + Stripe sub creation + subscription_status write, all in one tx (today: Auto 8 fires, webhook lands, separate Stripe write, separate Airtable write — three places it can fail half-done).

**Notification side-effects** (Slack to Senior Designer, Resend emails, Stripe API calls) fire after tx commits. Stripe `customers.create` / `subscriptions.create` get an `idempotencyKey = customerId` so retries don't double-charge.

**Retire after cutover:** all 6 files in `scripts/airtable-automations/`, the `AIRTABLE_WEBHOOK_SECRET` env var, and the Airtable trigger configs for Auto 1-8.

## 7. File storage

Vercel Blob (S3-compatible, native to Vercel). Replaces Airtable attachments.

- New uploads: `BLOB_READ_WRITE_TOKEN` env var, `@vercel/blob` package. Server-side signed-upload URL pattern from the relevant API routes.
- Schema: attachment columns become `text[]` of blob URLs, or for richer metadata (filename, uploader, caption) a separate `attachments` table per record type.
- Migration: one-time `scripts/migrate-attachments.ts` pulls each Airtable attachment from its temporary CDN URL, uploads to Vercel Blob, updates the record. Pre-launch data volume is low; runs in minutes.

## 8. Config editing UX

How internal team members edit config tables (Workflow Templates, Brokerages, Team Members, Stripe Plans, Settings, plus the future Engagement Rules table).

**Decision: native `/workspace/admin` CRUD.** No new tools. Same Next.js stack as the rest of `/workspace`, same magic-link auth, same UI patterns, app-audited writes via `events`. Engineering owns the surface end-to-end.

Reasoning (locked, not relitigated):
- The team has already invested in `/workspace` (`book`, `queue`, `account-queue`, `customers/[id]`). New admin surfaces join that pattern; they don't fork into a separate tool.
- A third-party SaaS in the stack (Retool, Outerbase) adds separate auth, separate audit log, separate ops story, separate $$ for what amounts to ~10 list+edit forms.
- The shave-a-week wins of a SaaS evaporate the moment a config table needs custom validation, role-gating, or write-side effects — and Workflow Templates needs all three.
- Pre-launch, "consistent stack" beats "fastest possible pre-launch UI."

Scope: minimal CRUD per table — list view + edit form, no fancy filtering or bulk-edit. Workflow Templates is the richest (multi-select roles, FK-resolution for dependencies, JSONB-ish config); Brokerages / Team Members / Stripe Plans / Settings are straightforward.

Realistic build: **1.5–2 days per table**, ~7–9 days for all five. Sequenced in Phase 5 (§12).

**Bridge during Phase 5:** for engineers who need to edit before the admin UI lands, **Neon SQL console** is fine — it's an engineer-only fallback, not a general-team UX. Drizzle Studio is also fine for local dev. Neither is a long-term answer.

**Explicitly rejected:** Retool / Outerbase / Drizzle Studio as the *primary* config-edit interface. Not aligned with the architectural direction.

## 9. Zapier + Calendly integration handling

### Zapier (HubSpot deal close → create Customer)

Currently writes directly to Airtable via Zapier's Airtable connector. After migration: Zapier POSTs to `/api/customers` with an `X-Zapier-API-Key` header. The endpoint already exists.

Phase 6 task: rewrite the Zap to use the HTTP action instead of the Airtable action, point at the new URL, set the API key.

### Calendly webhook

Currently upserts to the Calls table in Airtable (idempotent on `Calendly Event UUID`). After migration: webhook handler at `/api/webhooks/calendly` upserts to Postgres `calls` table on `calendlyEventUuid` (now a UNIQUE column — the idempotency is enforced by the DB, not by app code).

Phase 6 task: update Calendly webhook URL to point at the new handler.

## 10. Customer portal token migration

Currently `/r/[token]` uses Airtable's `RECORD_ID()` (`recXXX...`). After migration:

- `customers.portal_token` is a UUID, populated at insert via `defaultRandom()`.
- `/r/[token]` reads by `portal_token` (indexed, unique).
- Any existing customer URLs (testing only — system not live) break. Acceptable.

UUIDs over `recXXX`-format: less guessable, no Airtable coupling, standard.

## 11. Things we might miss — the "wait, we need Airtable!" audit

Explicit pre-mortem. Things that could make us regret this mid-migration:

| Risk | Mitigation |
|---|---|
| "Ops wants to bulk-edit 50 rows" | Drizzle Studio handles spreadsheet edits. For bigger imports, a one-off script. Workflow Templates ships seeded; bulk edits are rare. |
| "Real-time multi-user editing on a config table" | Not a thing today; nobody co-edits. If it becomes one, Airtable wouldn't be the answer at our scale anyway. |
| "Per-field history was a debugging lifeline" | The `events` table covers state changes. Add an `audit_log` table later if field-level history becomes a real need (~1 day to add). **Neon PITR with a verified live restore drill is a hard gate on Phase 7 cutover** (§12). Untested PITR is not a backup. |
| "Forms" | We don't use Airtable forms; intake is via portal task. Not a regression. |
| "External integrations expect Airtable" | Three: Zapier (HubSpot), Calendly webhook, the Airtable→Vercel Auto 8 webhook. §6 and §9 cover them. |
| "Designers/ops familiar with Airtable" | Already moved to `/workspace`. Admin CRUD / Drizzle Studio covers config. |
| "Sharing single records with external folks via Airtable link" | Doesn't happen today; portal tokens handle customer-facing sharing. |
| "Airtable is a backup" | It's not; we don't treat it as one. Neon PITR covers backups (configure pre-cutover). |
| "Undocumented automation we'd miss" | The 6 scripts above match `scripts/airtable-automations/`. **Decision for poorab #1**: confirm no Airtable Scripting blocks or sync rules exist beyond those, and confirm `auto3` and `auto7` stay disabled/paused after migration. |
| "Random Airtable Scripting block someone wrote" | Audit Airtable base UI before Phase 3. |
| "Airtable-side reports / charts being checked daily" | Confirm nobody uses Airtable views/charts as a dashboard. Equivalents must exist in `/workspace`. |
| "Long-text rich formatting" | Notes / Instructions fields. Postgres text + markdown rendering preserves this. |
| "The setup-production.ts script as institutional memory" | Becomes Drizzle migrations + seed script. Retired. |
| "Pre-existing CRM fields on Customer (Subscription Status, MRR, Renewal Date, Billing Cycle)" | Preserved verbatim in §5.1. Payment-mode plan flagged these as "NOT touched by this plan" — same applies here. |
| "Channel string discipline (`BW` not `Baird & Warner`)" | DMG plan §3.3 warning carries forward. Seed script + a CHECK constraint or `channels` lookup table. |
| "Stripe webhook URL stability" | The Stripe webhook endpoint is `launchpad-indol-ten.vercel.app` per payment-mode operational notes. Migration changes nothing here — but if domain ever changes, signing-secret regeneration is required. Document in deploy checklist. |
| "AIRTABLE_WEBHOOK_SECRET retirement" | Used by Auto 8 to authenticate to `/api/webhooks/calls/completed`. After Auto 8 retires, the secret can be removed — but the route may still be useful for testing. Keep the route, remove the env var only when no caller remains. |
| "View filters used as ad-hoc queries by ops" | E.g., "show me all customers with At Risk = true." `/workspace` queue/kanban must cover these. Audit the in-use Airtable views before cutover. |
| "Settings table on every email send" | New tables in §5.9. Cache `portal_base_url` in-process — reads on every email path. |

## 12. Migration phases

Clean rebuild, not a parallel run. System isn't live and no other code is in flight — but payment-mode Phase 1 IS shipped (see §13).

| Phase | Work | Estimate | Prereq |
|---|---|---|---|
| 0 | Provision Neon, install Drizzle + drizzle-kit + @vercel/blob, env vars (incl. `BLOB_READ_WRITE_TOKEN`, `POSTGRES_URL`, `POSTGRES_URL_NON_POOLING`) | 1 day | — |
| 1 | Drizzle schemas for all 11 tables (incl. `channels` lookup) + indexes + migrations + seed script (templates, brokerages, team members, stripe plans, settings, channels). **Plus: Stripe webhook integration tests** — signature verification, idempotency keys, `subscription_status` write semantics. The Stripe path is the highest-leverage test surface; standing it up in Phase 1 (before the data layer swap in Phase 2) gives us a regression net for the rest of the migration. Architect signoff. | 6 days | 0 |
| 2 | Data layer rewrite (`src/lib/airtable.ts` → `src/lib/db.ts`, same public API; ~850 lines incl. `getStripePlansForWorkflow`, `getSettings`, Stripe Plans reads). Delete `fieldMap` objects in API routes. | 6 days | 1 |
| 3 | Port 8 automations (Auto 1, 2, 4, 5, 6, 8 active; 3 and 7 disabled but plumbed). Includes wiring Stripe sub creation directly into `PATCH /api/calls/:id` (retires Auto 8 webhook hop). Re-run Stripe webhook tests against Postgres-backed routes. | 5 days | 2 |
| 4 | Vercel Blob integration + migrate existing attachments (preserves filename/contentType metadata for designer downloads). **Provision Neon PITR + perform a live restore drill** — write something, take a checkpoint, drop it, restore to point-in-time, verify. PITR you haven't tested isn't a backup. Hard gate before Phase 7. | 4 days | 1 |
| 5 | `/workspace/admin` CRUD: list + edit form per config table — Workflow Templates, Brokerages, Team Members, Stripe Plans, Settings, Channels | 8–10 days | 2 |
| 6 | Rewire integrations: Zapier (HubSpot → `/api/customers`), Calendly webhook URL, retire `auto8-stripe-sub-creation.js` Airtable trigger | 1 day | 3 |
| 7 | **Cutover gates (all must pass):** end-to-end verification (Stripe webhook → sub create → portal flow); **PITR restore drill from Phase 4 verified passing**; Stripe webhook integration test suite green against Postgres; channel FK in place and seeded. Then: decommission `AIRTABLE_PAT` env var (keep `AIRTABLE_WEBHOOK_SECRET` until Auto 8 fully retired), retire `src/lib/airtable.ts` + `src/lib/airtable-client.ts` + all `scripts/airtable-automations/*`, rewrite CLAUDE.md / architecture.md / production-schema.md | 3 days | all |

**Total: 6–8 weeks** of focused work, depending on §8 choice. Critical path: Phases 1–3. Phases 4 and 5 can run in parallel with 3.

The "bigger than it looks" risk drivers:
- 8 automations, not 2.
- `src/lib/airtable.ts` is ~850 lines and includes shipped Stripe Plans + Settings logic, not just CRUD.
- Payment-mode Phase 1's Stripe webhook code + Calls webhook + `/api/email/send` already exists — porting it intact, not redesigning, but it needs careful test coverage.
- Vercel Blob attachment migration preserves metadata, not just URLs.
- The admin CRUD (option C) is genuinely more like 7–9 days for 5 tables.

## 13. Sequencing — payment-mode Phase 1 already shipped

The v1 of this plan claimed nothing was in flight. **That was wrong about payment-mode Phase 1**, which marked DONE 2026-05-07 per `docs/plans/payment-mode-dropoff.md:262`. The migration must port a real existing implementation, not just edit the plan doc.

### What's already shipped and needs porting

| Shipped surface | Where it lives | Port action |
|---|---|---|
| Stripe Customer / Subscription creation logic | `src/lib/stripe.ts` | Read/write Postgres `customers` + `stripe_plans` via Drizzle; preserve idempotency keys; preserve `getStripePlansForWorkflow` semantics |
| Stripe webhook handler | `src/app/api/webhooks/stripe/` | Stays at same URL. Body unchanged. Internals swap Airtable writes for Drizzle. `STRIPE_WEBHOOK_SECRET` env var preserved. |
| Calls completed webhook | `src/app/api/webhooks/calls/completed/` | Stays at same URL during transition (Auto 8 still targets it). Internals swap to Drizzle. Retired in Phase 6 when Auto 8 retires. |
| Calendly webhook | `src/app/api/webhooks/calendly/` | Internals swap to Drizzle. Idempotency now enforced by `calendly_event_uuid UNIQUE`. |
| `/api/email/send` | `src/app/api/email/send/` | Reads Settings.portal_base_url; reads Customer fields. Drizzle swap is internal; route shape unchanged. |
| `Payment Setup` attachment type renderer | `src/components/tasks/*` | Component unchanged; data layer underneath swaps. |
| Stripe Plans table seeding | `scripts/setup-stripe-plans.ts` (or similar) | Becomes seed script for Drizzle. Plan data identical. |
| Capture Payment Method gating logic | Workflow Templates `payment_mode` reads + portal logic | Drizzle reads of `workflow_templates`. Logic unchanged. |

**Implication:** "editorial pass" is not enough for payment-mode. The migration plan must include a checklist of every payment-mode artifact and a test plan validating it post-port. Per architect signoff, **Stripe webhook integration tests land in Phase 1**, before the data layer swap, so they're a regression net for everything that follows — not a Phase 7 verification line item. Phase 7 cutover gates explicitly include re-running the suite green against Postgres-backed routes.

### DMG roster plan — schema rewrite needed

DMG plan uses `customer_record_id TEXT` (Airtable rec ID) throughout: in `roster_agents`, the advisory-lock click path, the UPSERT logic, and the "preserve customer_record_id" rule. Post-migration that becomes `customer_id uuid REFERENCES customers(id)`. The plan's three-step "create Airtable Roster row + create Airtable Customer row + UPDATE roster_agents" becomes a single Drizzle transaction — cleaner, but the DMG plan must be revised.

The migration plan + DMG plan revision should land in the same PR or in a clearly-coordinated sequence. Same for the editorial passes on payment-mode-dropoff.md and integration-notes.md (UUID FKs everywhere, no more "Airtable record" wording).

### Recommended sequencing

| Order | Description | Trade-off |
|---|---|---|
| Migrate first, then build DMG + finish payment-mode Phases 2-4 | Land §12 phases, then resume the other plans natively on Postgres | Cleanest. Adds ~6–8 weeks. Payment-mode Phase 1 stays operationally functional (or paused) during migration; cutover at Phase 7 brings it back. **Recommended.** |
| Build DMG on Airtable, migrate later | Ship DMG against Airtable; migrate everything later | Rebuilding the same DMG code twice. Wasteful. |
| Parallel | Migration in one stream, DMG in another | Schema churn. Risky given payment-mode is also a moving target. |

**Migrate-first risk to manage:** during Phases 0-6, payment-mode Phase 1 is operationally live on Airtable. Any production incident there (e.g., a Stripe webhook failure) needs to be triagable in the old stack while the new one is being built. Plan: keep `AIRTABLE_PAT` env active until Phase 7 cutover; treat payment-mode hotfixes as Airtable-stack work until then.

## 14. Decisions for Poorab

1. **Confirm the 8-automation list is complete.** Auto 1, 2, 3, 4, 5, 6, 7, 8 per `scripts/airtable-automations/` (6 script files, 8 deployed triggers). Are there any Airtable Scripting blocks, sync rules, or other deployed automations not in that directory?
2. **Config editing strategy.** Locked per §8: native `/workspace/admin` CRUD, 5 tables, ~7–9 days in Phase 5. No SaaS admin tools. Neon SQL console as engineer-only bridge during Phase 5 if needed.
3. **Customer portal token format.** UUID `access_token` column. Confirm acceptable. (Pre-launch — no in-flight customer URLs to invalidate.)
4. **Attachment storage.** Vercel Blob with metadata-preserving JSONB columns. Confirm, or prefer S3 directly?
5. **Sequencing.** Migrate first (recommended) and resume DMG + payment-mode Phases 2-4 on Postgres? Acknowledge payment-mode Phase 1 stays Airtable-operational during the migration window.
6. **Channel discipline.** Locked per architect signoff: FK to a `channels` lookup table (§5.11). Three seeded rows (`Standard`, `Keyes`, `BW`). Workflow Key resolved at insert time.
7. **Audit any Airtable views / Interface charts** the team checks today. The `/workspace` queue/kanban must cover them before cutover.
8. **Confirm `auto3` (In Review intercept) and `auto7` (Credentials email) stay disabled/paused after migration.** If either is intended to be re-enabled, that's Phase 3 scope rather than "plumb and leave off."
9. **Drift period for `AIRTABLE_WEBHOOK_SECRET`.** Keep until Auto 8 fully retired in Phase 6, then remove. OK?

## 15. What this plan does NOT cover

- The engagement-data integration — separate plan at `docs/integrations/engagement-data-plan.md`. Assumes this migration is landed.
- The DMG roster integration — separate plan at `docs/integrations/dmg-roster-plan.md`. Post-migration, the "Airtable handoff" sections become "Postgres write" sections; otherwise unchanged.
- The payment-mode + dropoff plan — `docs/plans/payment-mode-dropoff.md`. Post-migration, references to Airtable tables become references to Postgres tables; otherwise unchanged.
- ML / engagement scoring — covered in the engagement-data plan.
- Backup, restore, and disaster recovery procedures for Postgres — addressed in a separate ops doc, not this plan.
