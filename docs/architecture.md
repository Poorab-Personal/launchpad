# LaunchPad Architecture

**Last major revision:** 2026-05-12 (post Airtable→Postgres cutover).

## System Overview

```
                    +---------------------------+
                    |      External Systems     |
                    |  HubSpot   Stripe  Calendly|
                    +-----+-----+----+-----+-----+
                          |          |     |
                          | (HubSpot Zap   | (Calendly webhook)
                          |  → Phase 6     |
                          |  rewire later) |
                          v          v     v
  +---------------------------------------------------------------+
  |              Next.js 16 App on Vercel                         |
  |                                                               |
  |   Customer portal (/r)    /b landing    /workspace   /admin   |
  |          ↓                   ↓              ↓           ↓     |
  |   +-----------------------------------------------------+     |
  |   |   API routes (thin dispatchers)                     |     |
  |   |   /api/customers, /api/tasks, /api/calls,           |     |
  |   |   /api/webhooks/{stripe,calendly},                  |     |
  |   |   /api/upload, /api/email/send, ...                 |     |
  |   +-----------------------------------------------------+     |
  |          ↓                                                    |
  |   +-----------------------------------------------------+     |
  |   |   src/lib/db.ts  (Drizzle data layer)               |     |
  |   |   src/lib/automations/* (Auto 1/2/4/5/6/8 inline)   |     |
  |   +-----------------------------------------------------+     |
  |          ↓                                                    |
  +---------------------------------------------------------------+
                          ↓
                    Vercel Postgres / Neon (single source of truth)
                    Vercel Blob (file attachments)
                    Resend (transactional email)
                    Stripe (subscriptions + payments)
```

## Key Subsystems

### 1. Data Layer — `src/lib/db.ts`

Single public API surface for every read/write. ~50 functions. Postgres-backed via Drizzle. Schemas in `src/db/schema/*.ts` are the source of truth — `$inferSelect` and `$inferInsert` types feed downstream consumers.

**Reader functions** populate `Task.dependsOn` (comma-separated string of source-task names) from the `task_dependencies` junction table, so the legacy client-side optimistic-activation logic in `TaskList.tsx` works unchanged.

**Mutators that fire automations:**
- `updateTaskStatus(id, status)` / `updateTaskFields(id, fields)` — if status becomes `Completed`, fires `handleTaskCompleted` (Auto 2)
- `updateCall(id, fields)` — if status becomes `Completed` AND type is `Onboarding`, fires `handleCallCompleted` (Auto 8)

Direct `db.update(...)` calls bypass these triggers — don't do that for tasks/calls.

### 2. Automations — `src/lib/automations/`

Ported from the legacy Airtable Auto 1–8 scripts. Now inline TypeScript invoked from the same request that triggers them.

| File | What | Trigger |
|---|---|---|
| `generate-tasks.ts` | Auto 1: insert tasks + dependencies + first stage + Customer Created event | `POST /api/customers` (in same tx as customer insert) |
| `activate-dependents.ts` | Auto 2 + Auto 4: activate Draft tasks when deps complete, advance stage, CSM/Calendly URL routing on Mark Onboarding Call Complete, Design Ready email, bridge to Auto 8 on Mark Onboarding Call Complete | Inside `updateTaskStatus` / `updateTaskFields` when status → Completed |
| `design-approval.ts` | Auto 4/5-design-equivalent: Approved → complete review task + cascade revisions; Changes Requested → spin up 3-task revision chain | `POST /api/customers/[id]/design-approval` |
| `handle-call-completed.ts` | Auto 8: create Stripe subscription with trial for setup-intent-at-intake workflows | Inside `updateCall` when call.status → Completed AND type=Onboarding |
| `trigger-email.ts` | Auto 5/6: Welcome on customer create, Design Ready on Review task active | Fired by route or activate-dependents |

Race protection: every UPDATE that changes status is conditional (`WHERE status='Draft'`), so concurrent Auto 2 invocations don't double-activate.

### 3. Routing & UI

- **`/r/[accessToken]`** — Customer portal. Server-rendered from Postgres. Token is `customers.access_token` UUID.
- **`/b/[slug]`** — B2B brokerage landing page. Customer self-onboards via roster lookup + email magic link (DMG roster plan).
- **`/workspace`** — Internal team UI. Magic-link auth, role-gated. Pages: `/queue` (Designer), `/book` (CSM), `/account-queue` (Account Creator), `/customers/[id]` (any).
- **`/admin`** — Lightweight admin: customer list, add-customer form, manual operations. Gated by `ADMIN_PASSWORD` env var.

### 4. Auth — `src/lib/auth/`

Magic-link via Resend. JWT session cookie signed by `SESSION_SECRET`. Session payload: `{ memberId: uuid, role: TeamRole, email }`. View-as switcher (admin-only) impersonates a role or a specific member via a separate cookie.

### 5. Stripe Integration

`src/lib/stripe.ts` wraps `customers.create`, `subscriptions.create`, `webhooks.constructEvent`. Two-stage Stripe flow for setup-intent-at-intake workflows (B2B-Keyes):

1. **Customer creation time** (`POST /api/customers`): `stripe.customers.create()` runs after the local tx commits if `paymentMode === 'setup-intent-at-intake'`. Customer's `stripeCustomerId` is set.
2. **Capture Payment Method task** (`/api/customers/[id]/payment-setup/{create,confirm}`): Stripe Elements collects card → SetupIntent succeeds → customer's `selectedStripePriceId` + `selectedPlanName` saved → task marked Complete.
3. **Onboarding call completed** (`updateCall(..., { status: 'Completed' })` for an Onboarding call): `handleCallCompleted` runs → `stripe.subscriptions.create()` with the saved price and template's trialDays → `subscriptionStatus` written to Customer.

Webhook handler at `/api/webhooks/stripe/route.ts` writes subscription status changes back to Postgres (trial → active, past due, cancelled). Stripe regression suite (`tests/webhooks/stripe.test.ts`) covers signature verification, idempotency markers, and every supported event type.

### 6. Email — `src/lib/email/`

React Email templates rendered via `@react-email/render`, sent via Resend. Three templates: `welcome`, `design-ready`, `credentials-sent`. Fire-and-forget from automation triggers; failures logged but never bubble.

### 7. File Storage — Vercel Blob

`POST /api/upload` writes uploaded files to Vercel Blob with `addRandomSuffix: true` (collision-safe). Customer attachment fields (`agent_photo`, `business_logo`, `other_assets`, `design_proof`, `design_drafts`) are jsonb arrays of `{ url, filename, size, contentType }` objects.

## Customer Flow (D2C-Standard, abridged)

1. HubSpot deal closes → (Phase 6 rewire pending) creates Customer row via `POST /api/customers` → Auto 1 generates 17 tasks atomically → Welcome email sent
2. Customer opens `/r/[accessToken]` → completes form → `handleTaskCompleted` fires → next task activates (within the same stage, or the page renders WaitingPanel if next steps are Team-only)
3. Designer marks Create Designs complete in `/workspace/queue` → Auto 2 activates Review Designs → Senior approves → Auto 2 advances to Upload Proof → Review & Approve activates → Design Ready email goes to customer
4. Customer approves → `handleDesignApproved` completes the review task → Auto 2 cascades dependents → stage advances to Book Your Call
5. Customer schedules → Calendly webhook upserts Call row, completes Schedule task, reassigns Mark Onboarding Call Complete to the booking host
6. CSM marks Mark Onboarding Call Complete → Auto 4 sets `csm_team_member_id` + Check-In Calendly URLs → bridge fires `updateCall(... 'Completed')` → Auto 8 creates Stripe subscription (trial, if applicable)
7. Stage advances through Prepare for Onboarding, Post Onboarding, Review & Grow → final feedback + 2 check-ins booked

## Customer Flow (B2B-Keyes)

Same shape, condensed: Confirm Your Information → Capture Payment Method → Schedule Your Onboarding Call → Create Designs (Team) → … same end as D2C from "Customer schedules" onwards. Stripe SetupIntent happens at Capture Payment Method; subscription creation deferred to call complete.

## What's Different From The Airtable Era

| Concern | Before | After |
|---|---|---|
| System of record | Airtable base | Vercel Postgres / Neon |
| Schema | Title-Case Airtable fields | snake_case Postgres + Drizzle |
| Task dependencies | Comma-separated text field | `task_dependencies` junction table |
| Automations | Airtable scripting (Auto 1–8) | Inline TS in `src/lib/automations/` |
| Customer create | Insert + async Auto-1 (race-prone) | Single db.transaction (atomic) |
| File storage | Airtable CDN (URLs expire) | Vercel Blob (permanent) |
| Customer portal token | `RECORD_ID()` formula | UUID column `access_token` |
| Field updates | Title-Case via fieldMap | camelCase via Drizzle |
| Backups | Airtable history (24h) | Neon PITR (7+ days, drill-verified) |

## Pending Items (Post-Cutover)

- **Phase 5 — `/workspace/admin` CRUD** for config tables. Engineers edit via Drizzle Studio / Neon SQL until built.
- **Phase 6 — HubSpot Zapier rewire** to POST `/api/customers` instead of writing to Airtable. Deferred until a stable production URL (custom domain).
- Engagement-data ingestion plan, DMG roster plan: separate plans, build natively against Postgres when scheduled.
