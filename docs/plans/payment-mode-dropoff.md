# Plan — Payment Mode Config + Drop-off Handling

**Status:** Draft, pending architect review
**v2 — applies architect review 2026-05-06**
**Author:** Claude (LaunchPad)
**Date:** 2026-05-06

## Changes from v1

- **Dropped the synthetic `D2C-Prepaid` Brokerage.** `Payment Mode`, `Stripe Price ID`, and `Trial Days` now live on **Workflow Templates** (header-level — denormalized onto every template row sharing a `Workflow Key`). No customer backfill, no Workflow Key formula change, no semantic drift on what a Brokerage is.
- **Sub creation triggers off the `Calls` table**, not the `Mark Onboarding Call Complete` task. Watches `Calls.Status = Completed AND Type = Onboarding AND Customer.Stripe Subscription ID is empty`. Survives reschedules, no-shows, and CSM forgetfulness; idempotent by guard.
- **Cut `Brokerages.Billing Status`** entirely — nothing reads it.
- **Cut per-task reminder threshold variation** — one global `+3d, +7d, +12d` schedule for all stalled-task types.
- **Cut `Tasks.Reminder Count`** — keep only `Tasks.Last Reminder At` and compute reminder number on the fly.
- **Split `atRisk` into two fields**: `At Risk` (checkbox) + `At Risk Reason` (single-select). `Churned` handled by existing `Current Stage = "Churned"`; no new lifecycle field.
- **Made Stripe Customer creation timing explicit** per payment mode.
- **Added webhook idempotency note** for `setup_intent.succeeded` and the Calls-driven sub creation path.
- **Added cron race-condition mitigation**: re-read task immediately before sending reminder; skip if status changed.
- **Used existing `Embed` Attachment Type** for the Capture Payment Method task — no new `Stripe Setup` type.
- **Resolved all 5 v1 Open Questions** inline (no dangling questions for the architect).
- **Reordered phases**: Phase 4 is now small (Stripe Subscription ID backfill only).

---

## Problem

Today's workflow assumes payment is settled before LaunchPad gets the customer:
- D2C: Stripe sub created at HubSpot deal close, customer is billing-active on day one.
- B2B-Keyes: trial concept exists in template ("Start Your Trial") but no actual SetupIntent is captured. If the customer never sets up a card or never books, the workflow doesn't notice — design picks up assets and works for free.
- B2B-BW: invoice-based, no Stripe at all.

We need three things:

1. **Per-workflow payment-mode config** so each onboarding flow knows whether/when to capture a card.
2. **Workflow gating**: design tasks must not activate for `setup-intent-at-intake` customers until the card is on file.
3. **Drop-off handling**: customers who submit intake but stall on CC capture or onboarding booking get reminded, then escalated to CSM.

---

## Design

### 1. Payment Mode lives on Workflow Templates

Payment mode is workflow-shaped, not brokerage-shaped: every `B2B-Keyes` customer is `setup-intent-at-intake`, every `D2C-Standard` customer is `pre-paid`, every `B2B-BW` customer is `invoice`. Tomorrow's `D2C-Trial` is also a new Workflow Key. Anchoring the config to the Workflow Key (the thing that already differentiates the flow) keeps Brokerages clean and removes the need for a synthetic D2C parent record.

**Storage shape (decision):** Add `Payment Mode`, `Stripe Price ID`, and `Trial Days` as columns on **`Workflow Templates`**, denormalized onto every row sharing a `Workflow Key`. We pick this over a separate `Workflow Configs` table because:
- Workflow Templates is already the canonical "per-workflow config" location (it owns Embed URL, Initial Status, Depends On, etc.).
- Lookup is a single filter we already do (`WHERE Workflow Key = X`); reading any one row gives the config.
- A new table would mean an extra join in Auto 1 and a second place that needs seeding when adding a workflow.

Denormalization cost: when seeding a workflow, every template row for that key carries the same `Payment Mode`/`Stripe Price ID`/`Trial Days` values. Mitigation: the seed script (`setup-production.ts`) is the single writer, so drift is structurally impossible. Code reads the value off any one row and ignores the rest.

**Payment Mode values:**

| Value | Behavior |
|---|---|
| `pre-paid` | Sub already exists at customer creation. No SetupIntent task. Design unblocks per template. **Used by D2C-Standard.** |
| `setup-intent-at-intake` | Customer portal exposes Stripe SetupIntent step. "Capture Payment Method" task gates downstream tasks. Sub is created (with trial) when the Onboarding Call is marked Completed in the Calls table. **Used by B2B-Keyes, future B2B-IP.** |
| `invoice` | No Stripe involvement. Design unblocks per template. **Used by B2B-BW.** Note: this mode is informational only today — no behavior currently keys off it. We add the value for future use; we do **not** add a `Brokerages.Billing Status` field until a feature actually reads it. |
| `none` | Demo / lighthouse customers. No billing. |

**What stays in Brokerages:** `Default Workflow Key`, `Landing Page Slug`, roster config, billing contact. Brokerages remain "a real estate brokerage we have a deal with."

**Counter-case noted:** if Poorab later wants per-brokerage Stripe pricing on the same workflow (Keyes pays $X, IP pays $Y, both on `B2B-Keyes`), `Stripe Price ID` would migrate to Brokerage while `Payment Mode` stays on Workflow Templates. Today's reality — one price per workflow — doesn't justify that split. See "Decisions for Poorab" below.

### 2. Dependency-graph approach to gating

`Depends On = "Capture Payment Method"` is the gating primitive. The Depends On field is already the system's "this can't happen yet because of that" channel. Auto 2 already activates downstream tasks the instant predecessors complete. The Stripe webhook completes the task; Auto 2 doesn't need to know why.

- Brokerages with `Payment Mode = invoice` simply don't have the task generated, so the dependency edge is silently inert.
- B2B-Keyes today has no design tasks, so gating is also inert there. The day someone wires up IP with a card-capture + brand-kit flow, the dependency edge is already in the template — no code change needed.

**Convention reminder:** `Depends On` is comma-separated **task name strings**, never linked-record IDs. CLAUDE.md is explicit about this; race conditions in Airtable automations make linked-record dependencies dangerous.

### 3. New task: "Capture Payment Method"

Added to `B2B-Keyes` and any future `setup-intent-at-intake` workflow templates. Inserted in stage 1 ("Getting Started"), replacing the placeholder "Start Your Trial" task.

```
Stage: Getting Started, Order: 2
Task Type: Client
Visible To Client: ✓
Initial Status: Active
Attachment Type: Embed
Depends On: (blank)
Embed URL: /r/{token}/payment-setup  (Stripe-hosted card collection page)
Instructions: "Add a payment method to start your free trial. You won't be charged until your onboarding call is complete."
```

**Attachment Type decision (resolves v1 Open Question 1):** use `Embed`. The Stripe Elements page is just a normal Next.js route the iframe loads. A new `Stripe Setup` Attachment Type would add a `TaskRenderer` branch with no behavior the existing `EmbedTask` doesn't already handle. Add a new type only if cross-origin trickery later forces it.

**Workflow template surgery for B2B-Keyes:**
- Add "Capture Payment Method" (Order 2 in Getting Started).
- Remove placeholder "Start Your Trial" (Order 2).
- Future brokerages with both card capture and design steps set `Depends On = "Capture Payment Method, Confirm Your Information"` on the design task.

### 4. SetupIntent flow + sub creation

**SetupIntent (card capture):**
- New API route: `POST /api/customers/[id]/payment-setup` — server-side creates Stripe SetupIntent, returns client secret.
- New customer-portal page: `/r/[token]/payment-setup` — Stripe Elements, collects card, confirms SetupIntent.
- New webhook: `POST /api/webhooks/stripe` — handles `setup_intent.succeeded` → finds customer by `Stripe Customer ID` → marks "Capture Payment Method" task Completed → Auto 2 unblocks dependents.

**Stripe Customer creation timing (per mode):**

| Mode | When `Customers.Stripe Customer ID` is populated |
|---|---|
| `setup-intent-at-intake` | **At Customer record creation.** The same code path that creates the Customer record (B2B agent intake handler) calls `stripe.customers.create()` and writes the ID. The SetupIntent route can then assume the Stripe Customer already exists. |
| `pre-paid` (D2C) | **Lazily, from existing `Customers.Stripe Payment ID`** (the upstream HubSpot/Stripe path already created the Stripe Customer). On first need (e.g., add-on purchase), backfill from the existing payment record. |
| `invoice` | **Never.** Field stays empty. |
| `none` | **Never.** Field stays empty. |

**Subscription creation (triggered from Calls table, not from a Task):**

Watch the `Calls` table for:
```
Calls.Status = Completed
  AND Calls.Type = Onboarding
  AND Calls.Customer → Stripe Subscription ID is empty
  AND Calls.Customer → Workflow.Payment Mode = setup-intent-at-intake
```

When matched, create the Stripe Subscription using the stored payment method + the workflow's `Stripe Price ID` + `Trial Days`. Write `Customers.Stripe Subscription ID`.

Why Calls and not the Task:
- **Reschedules don't false-fire.** Calendly upserts on Event UUID; rescheduled calls don't trip `Status = Completed`.
- **No-shows don't false-fire.** Status is explicitly `No Show`.
- **CSM forgetting to mark the task is no longer fatal.** Marking the Call Completed (which CSM already does in the workspace) is the same action that creates the sub.
- **Idempotency is free** because of the `Stripe Subscription ID is empty` guard.

**Implementation:** Airtable automation on `Calls.Status` change → calls a LaunchPad webhook (`POST /api/webhooks/calls/completed`) → LaunchPad re-checks the guards (defense in depth), calls Stripe, writes back.

**Webhook idempotency (explicit):**
- The Stripe `setup_intent.succeeded` webhook is a no-op if the "Capture Payment Method" task is already `Completed`. Guard by reading task status before writing.
- The Calls-driven sub creation path is a no-op if `Customers.Stripe Subscription ID` is already non-empty. Guard before calling `stripe.subscriptions.create()`.
- Both paths are safe under retries (Stripe 5xx replays, Airtable automation re-fires, dashboard test events).

**Safety net:** weekly audit query (CSM workspace badge) — "customers in Stage 4+ with `Payment Mode = setup-intent-at-intake` and no `Stripe Subscription ID`." Catches every gap: webhook drops, manual edits, anything.

### 5. Reminder cron

Vercel cron (daily at 14:00 UTC ≈ 9am CT):

```
GET /api/cron/dropoff-reminders
  → Find Tasks where:
       Status = Active
       Task Name IN ("Capture Payment Method", "Schedule Your Onboarding Call",
                     "Confirm Your Information", "Complete Your Onboarding Form")
       AND Activated At < now - 3d
       AND (Last Reminder At is null OR Last Reminder At < now - 4d)
  → For each:
       Re-read the task by ID (race guard — see below).
       If Status != Active anymore, skip.
       reminderNumber = floor((now - activatedAt) / 4d)
       If reminderNumber >= 3 and Customer.At Risk = false:
         Set Customer.At Risk = true, At Risk Reason = (mapped from task name)
         Skip sending email — escalation handled in CSM workspace
       Else:
         Send templated email
         Set Last Reminder At = now
```

**Schedule (single global rule for all stalled-task types):** `+3d, +7d, +12d`. No per-task variation. If reminder fatigue or response rates become a measured problem, tune from data — don't pre-emptively shard.

**Storage shape:** `Tasks.Last Reminder At` only. Reminder number is computed as `floor((now - activatedAt) / interval)`. We do **not** add `Tasks.Reminder Count` — the count is derivable, the cron is idempotent (Last Reminder At advances on each send), and we avoid a writer-collision risk between the cron and any future manual reset.

**Race condition mitigation (cron vs. webhook):** The cron query and the actual email send happen on different requests within the same handler invocation. Between query and send, the SetupIntent webhook (or Calendly webhook) may have completed the task. Mitigation: in the cron handler, **re-read the task by ID immediately before sending** the reminder. If `Status != Active`, skip it. Cheap, prevents the "you didn't add a card!" email landing 30 seconds after the customer added the card. Same logic protects against the other webhooks (Calendly `invitee.created` clearing `Schedule Your Onboarding Call`, intake form submission clearing `Confirm Your Information`, etc.).

**Where the cron lives:** Next.js (Vercel Cron → API route), not Airtable scheduled automation. Email sending uses a Next.js-side SDK (Resend or equivalent), Airtable scripting can't send those, and Vercel cron logs are first-class. The legacy `Auto 8` reference in `production-schema.md` is a stub (no implementation in `scripts/airtable-automations/`) — we delete or supersede that reference in Phase 0.

**Vercel plan note:** Vercel Pro confirmed; cron count is not a constraint.

### 6. `At Risk` shape (two fields)

Two fields beat one because the kanban filter becomes a positive query:

| Field | Type | Notes |
|---|---|---|
| `At Risk` | Checkbox | Set by cron after 3rd reminder, by CSM action, or by manual flag. Cleared by webhooks (Stripe, Calendly, form submission, design approval) or CSM action. |
| `At Risk Reason` | Single select | `No CC`, `No Booking`, `No Approval`, `No Form`, `CSM Flagged`. Cleared when `At Risk` goes false. |

**Churned handling (decision):** No new `Lifecycle Status` field. The existing `Customers.Current Stage = "Churned"` value already covers the terminal bucket — "Mark Churned" sets `Current Stage = "Churned"` and clears `At Risk`. The kanban filter is `At Risk = true AND Current Stage != "Churned"`, which is exactly the "show me everyone the cron flagged but the CSM hasn't touched yet" view section 7 wants.

Reason mapping (cron sets):

| Stalled task | At Risk Reason |
|---|---|
| Capture Payment Method | `No CC` |
| Schedule Your Onboarding Call | `No Booking` |
| Review & Approve Your Brand Kit (or design approval task) | `No Approval` |
| Confirm Your Information / Complete Your Onboarding Form | `No Form` |
| (manual) | `CSM Flagged` |

Auto-clearing:
- `setup_intent.succeeded` → if `At Risk Reason = No CC`, clear both fields.
- Calendly `invitee.created` → if `At Risk Reason = No Booking`, clear both.
- Design approval → if `At Risk Reason = No Approval`, clear both.
- Form submission → if `At Risk Reason = No Form`, clear both.
- `CSM Flagged` is cleared only by CSM action (or "Mark Churned").

### 7. CSM workspace surfacing

`/workspace/book` already has an "At Risk" kanban column. Wire it to filter `At Risk = true AND Current Stage != "Churned"`. Add a small badge on the customer row showing `At Risk Reason`.

CSM action panel on `/workspace/customers/[id]` for at-risk customers:
- **Snooze 3 days** — clears `At Risk` and `At Risk Reason`, sets `Tasks.Last Reminder At = now` on the offending task (so the cron waits a full interval before re-evaluating).
- **Mark Churned** — sets `Current Stage = "Churned"`, clears `At Risk` / `At Risk Reason`, marks all Active tasks as Completed (existing status; no new "Canceled" status needed).
- **Flag (manual)** — sets `At Risk = true, At Risk Reason = CSM Flagged`. CSM can use this when they hear bad signal outside the cron's view.

---

## Schema changes (Phase 0)

### Workflow Templates table (new fields, denormalized per Workflow Key)
- `Payment Mode` — single select: `pre-paid`, `setup-intent-at-intake`, `invoice`, `none`
- `Stripe Price ID` — text (nullable; required when `Payment Mode = setup-intent-at-intake`)
- `Trial Days` — number (default 0; required when `Payment Mode = setup-intent-at-intake`)

### Customers table
- `At Risk` — checkbox (default unchecked)
- `At Risk Reason` — single select: `No CC`, `No Booking`, `No Approval`, `No Form`, `CSM Flagged` (nullable)
- `Stripe Customer ID` — text (nullable; populated per Section 4 timing rules)
- `Stripe Subscription ID` — text (nullable; populated when sub is created)
- **Delete** `Customers.Reminder Count` (resolves v1 Open Question 4 — field is unused per current code; deleting now beats leaving deprecated cruft).

### Tasks table
- `Last Reminder At` — date w/ time (nullable)
- (No `Reminder Count` field. Compute on the fly per Section 5.)

### Workflow Templates row edits
- Add "Capture Payment Method" row to `B2B-Keyes` (Stage: Getting Started, Order: 2, Attachment: Embed, Embed URL: `/r/{token}/payment-setup`).
- Remove placeholder "Start Your Trial" row from `B2B-Keyes`.
- Set `Payment Mode` per Workflow Key:
  - `D2C-Standard` rows → `pre-paid`
  - `B2B-Keyes` rows → `setup-intent-at-intake` (with `Stripe Price ID` and `Trial Days`)
  - `B2B-BW` rows → `invoice`

### Brokerages table
- **No new fields.** No `Billing Status`, no `Payment Mode`, no `Stripe Price ID`, no `Trial Days`. Brokerages stays as-is.

### NOT changing
- The `Workflow Key` formula (`{Type} & "-" & {Channel}`) — stays as-is. (Resolves v1 Open Question 5 — no synthetic brokerage means no formula change needed.)
- D2C customer parent records — no backfill.
- The Brokerage table's semantic meaning.

---

## Phasing

### Phase 0 — Schema only (1 day)
- Meta-API script: add fields above to Workflow Templates, Customers, Tasks; populate `Payment Mode` / `Stripe Price ID` / `Trial Days` on existing template rows; delete `Customers.Reminder Count`.
- Update TypeScript types (`WorkflowTemplate`, `Customer`, `Task`).
- Update mappers in `src/lib/airtable.ts`.
- Supersede the `Auto 8` reference in `docs/schema/production-schema.md`.
- Lint, typecheck, smoke test.
- **No behavior change yet.**

### Phase 1 — SetupIntent flow + Calls-trigger sub creation + workflow gating (3-4 days)
- Stripe lib setup; `POST /api/customers/[id]/payment-setup` route; `/r/[token]/payment-setup` portal page (Stripe Elements).
- Stripe Customer creation at B2B agent intake (for `setup-intent-at-intake` workflows).
- Add "Capture Payment Method" task to `B2B-Keyes` template; remove "Start Your Trial".
- Stripe webhook (`POST /api/webhooks/stripe`) for `setup_intent.succeeded` → marks task Completed (idempotent: no-op if already Completed).
- Auto 2 unblocks any downstream `Depends On = "Capture Payment Method"` tasks.
- Calls-driven sub creation: Airtable automation on `Calls.Status` change → calls `POST /api/webhooks/calls/completed` → LaunchPad re-checks guards → calls Stripe → writes `Customers.Stripe Subscription ID` (idempotent: no-op if already non-empty).

### Phase 2 — Reminder cron + At Risk fields (2 days)
- `vercel.json` cron config.
- `/api/cron/dropoff-reminders` route — single global `+3/+7/+12d` schedule, race-guard via task re-read.
- Email templates per At Risk Reason.
- At Risk auto-clearing in `setup_intent.succeeded`, Calendly webhook, form-submission action, design-approval action.
- CSM workspace at-risk filter wiring + reason badges.

### Phase 3 — CSM actions (1 day)
- "Snooze 3 days", "Mark Churned", "Flag (CSM Flagged)" action panel on customer detail.
- Wire to the two-field At Risk shape and `Current Stage = "Churned"` semantics.

### Phase 4 — Stripe Subscription ID backfill (0.5 day)
- One-time CSV map: existing customers' Stripe sub IDs → `Customers.Stripe Subscription ID`.
- No re-parenting, no synthetic brokerage, no formula change.
- Can run anytime after Phase 0; not on the critical path.

---

## Resolved Open Questions (from v1)

1. **Attachment Type for "Capture Payment Method":** Use `Embed`. No new `Stripe Setup` type. Stripe Elements page is a normal Next.js route the iframe loads.
2. **Per-task reminder schedules:** Punted. Single global `+3/+7/+12d` for all stalled-task types. Tune from data only when needed.
3. **Sub creation timing:** Trigger off the `Calls` table (`Status = Completed AND Type = Onboarding AND Customer.Stripe Subscription ID empty`), not off the `Mark Onboarding Call Complete` task. Survives reschedules, no-shows, and CSM forgetfulness; idempotent by guard.
4. **`Customers.Reminder Count` collision:** Delete the field in Phase 0. Per-task tracking lives in `Tasks.Last Reminder At` (computed reminder number).
5. **Backfill safety / Workflow Key formula:** Moot — no synthetic D2C-Prepaid brokerage means no backfill, no formula change. Existing customers untouched.

---

## Decisions for Poorab

These two are genuinely ambiguous and the architect did not pick:

1. **Where `Stripe Price ID` lives if you ever need per-brokerage pricing within a single workflow.** Today every Keyes customer pays the same price; same for IP. If/when one brokerage on the `B2B-Keyes` workflow needs a different price than another (e.g., Keyes pays $X, IP pays $Y, both on the same template set), `Stripe Price ID` should migrate from Workflow Templates to Brokerages while `Payment Mode` stays on Workflow Templates. **Today's plan puts it on Workflow Templates.** Confirm that today's reality (one price per workflow) is expected to hold; flag if not.

2. **Whether the Calls-driven sub creation should also support a `Type = Check-In 1` or other call types as a fallback.** Today the trigger is `Type = Onboarding` only — if the Onboarding call is somehow skipped (deal closes via async path), the sub is never created and the safety-net audit catches it. Alternative: extend the trigger to any `Status = Completed` call where `Stripe Subscription ID` is still empty. Cleaner failure mode but blurs the "onboarding call is the moment we charge" semantics. **Today's plan uses `Type = Onboarding` only**; the safety-net audit covers the gap.

---

## What this plan does NOT cover

- The SetupIntent UI itself (Stripe Elements integration on the portal page) — Phase 1 build, not architectural.
- Voice/Avatar add-on payment flows — separate Phase 5.
- Engagement-data dump for CSM signals (e.g. "agent hasn't logged in") — deferred until the dump API exists.
- Dunning / failed-payment handling on existing subs — out of scope for onboarding; lives in Rejig core app.
- B&W `invoice` mode behavior — `Payment Mode = invoice` is informational only today. No reminder, no task, no gating, no `Brokerages.Billing Status` field. Add behavior the day a feature actually reads it.
