# Plan — Payment Mode Config + Drop-off Handling

**Status:** Draft, pending architect review
**Author:** Claude (LaunchPad)
**Date:** 2026-05-06

## Problem

Today's workflow assumes payment is settled before LaunchPad gets the customer:
- D2C: Stripe sub created at HubSpot deal close, customer is billing-active on day one.
- B2B-Keyes: trial concept exists in template ("Start Your Trial") but no actual SetupIntent is captured. If the customer never sets up a card or never books, the workflow doesn't notice — design picks up assets and works for free.
- B2B-BW: invoice-based, no Stripe at all.

We need three things:

1. **Per-brokerage payment-mode config** so each onboarding flow knows whether/when to capture a card.
2. **Workflow gating**: design tasks must not activate for `setup-intent-at-intake` customers until the card is on file.
3. **Drop-off handling**: customers who submit intake but stall on CC capture or onboarding booking get reminded, then escalated to CSM.

## Design

### 1. `Brokerages.paymentMode` (single select)

| Value | Behavior |
|---|---|
| `pre-paid` | Sub already exists at customer creation. No SetupIntent task. Design unblocks per template. **Used by D2C-Prepaid.** |
| `setup-intent-at-intake` | Customer portal exposes Stripe SetupIntent step. "Capture Payment Method" task gates "Create Designs". Sub is created (with trial) on `Mark Onboarding Call Complete`. **Used by Keyes, IP.** |
| `invoice` | No Stripe involvement. Design unblocks per template. Billing tracked via `Brokerages.billingStatus`. **Used by B&W.** |
| `none` | Demo / lighthouse customers. No billing. |

### 2. `D2C-Prepaid` synthetic Brokerage

D2C currently has no Brokerage parent. We unify by treating D2C as a Brokerage row:

- Create `Brokerages.D2C-Prepaid` with `paymentMode = pre-paid`, `Default Workflow Key = D2C-Standard`.
- Backfill `Customers.Brokerage = D2C-Prepaid` for all existing D2C customers.
- Future variants (`D2C-Trial`, `D2C-Promo`) become new Brokerage rows with their own `paymentMode` and workflow key.

Trade-off: Brokerage table grows by 1 row + we own a migration. Win: every customer has a brokerage parent → one branching point in code (`paymentMode`), not two (`Type`, then `Channel`).

### 3. New task: "Capture Payment Method"

Added to `B2B-Keyes` and any future `setup-intent-at-intake` workflow templates. Inserted in stage 1 ("Getting Started").

```
Stage: Getting Started, Order: 2
Task Type: Client
Visible To Client: ✓
Initial Status: Active
Attachment Type: Embed (or new "Stripe Setup" type — see Open Question 1)
Depends On: (blank)
Embed URL: /r/{token}/payment-setup  (Stripe-hosted card collection page)
Instructions: "Add a payment method to start your free trial. You won't be charged until your onboarding call is complete."
```

**Workflow template surgery for B2B-Keyes:**
- Add "Capture Payment Method" (Order 2 in Getting Started).
- Update "Create Designs" task (currently absent in Keyes — Keyes has no design step). For brokerages that *do* have design (none today, but future ones might), `Depends On = Capture Payment Method, Confirm Your Information`.
- Replace existing "Start Your Trial" placeholder with this real task.

**B2B-Keyes is design-less today**, so the design-gating concern doesn't bite Keyes itself. The architecture handles it for future brokerages that combine `setup-intent-at-intake` + design (e.g. IP if they want a brand kit).

### 4. SetupIntent flow

- New API route: `POST /api/customers/[id]/payment-setup` — server-side creates Stripe SetupIntent, returns client secret.
- New customer-portal page: `/r/[token]/payment-setup` — Stripe Elements, collects card, confirms SetupIntent.
- New webhook: `POST /api/webhooks/stripe` — handles `setup_intent.succeeded` → finds customer by `Stripe Customer ID` → marks "Capture Payment Method" task Completed → Auto 2 unblocks dependents.
- On `Mark Onboarding Call Complete`: Auto X creates the actual Subscription using stored payment method + `Brokerages.priceId` + `Brokerages.trialDays`. Stores `Customers.stripeSubscriptionId`.

### 5. Reminder cron

Vercel cron (daily at 14:00 UTC ≈ 9am CT):

```
GET /api/cron/dropoff-reminders
  → Find Tasks where:
       Status = Active
       Task Name IN ("Capture Payment Method", "Schedule Your Onboarding Call",
                     "Confirm Your Information", "Complete Your Onboarding Form")
       AND Activated At < now - threshold
       AND (Last Reminder At is null OR Last Reminder At < now - reminder_interval)
       AND Reminder Count < 3
  → For each: send templated email, increment Reminder Count, set Last Reminder At
  → If Reminder Count just hit 3:
       Set Customer.atRisk = "Stalled - {reason}"
       Skip further reminders
```

Thresholds (per task name):
- `Capture Payment Method`: first reminder at +2d, then +5d, then +9d
- `Schedule Your Onboarding Call`: first at +2d, +5d, +9d
- `Confirm Your Information` / `Complete Your Onboarding Form`: first at +3d, +7d, +12d (form is more involved than a click)

Cron timing: daily is enough — we're not chasing minutes here. Vercel Hobby allows 2 cron jobs; Pro removes that. User confirmed Pro.

### 6. `Customers.atRisk` (single select)

| Value | Set By | Cleared By |
|---|---|---|
| `none` (default) | — | — |
| `Stalled - No CC` | reminder cron after 3rd reminder on "Capture Payment Method" | webhook on `setup_intent.succeeded` |
| `Stalled - No Booking` | reminder cron after 3rd reminder on "Schedule Your Onboarding Call" | Calendly webhook on `invitee.created` |
| `Stalled - No Approval` | reminder cron after 3rd reminder on design approval task | design approval action |
| `Stalled - No Form` | reminder cron after 3rd reminder on intake form task | form submission action |
| `At Risk - CSM Flagged` | manual CSM action | manual CSM action |
| `Churned` | manual CSM action | — (terminal) |

### 7. CSM workspace surfacing

`/workspace/book` already has an "At Risk" kanban column. Wire it to filter `Customers.atRisk != none AND atRisk != Churned`. Add a small badge on the customer row showing the specific stall reason.

Add a CSM action panel on `/workspace/customers/[id]` for at-risk customers:
- "Snooze 3 days" — clears `atRisk` to `none`, resets `Reminder Count = 0` on the offending task. Cron will re-evaluate after threshold.
- "Mark Churned" — sets `atRisk = Churned`, marks all active tasks as Completed (or new "Canceled" status — TBD), sets Customer.Current Stage = "Churned".

## Schema changes (Phase 0)

### Brokerages table
- `Payment Mode` — single select: `pre-paid`, `setup-intent-at-intake`, `invoice`, `none`
- `Stripe Price ID` — text (nullable; required when paymentMode = setup-intent-at-intake)
- `Trial Days` — number (default 0; required when paymentMode = setup-intent-at-intake)
- `Billing Status` — single select: `active`, `paused`, `churned` (used for `invoice` mode)

### Customers table
- `At Risk` — single select with values listed above (default `none`)
- `Stripe Customer ID` — text (nullable; populated lazily on first Stripe interaction)
- `Stripe Subscription ID` — text (nullable; populated when sub is created)

### Tasks table
- `Last Reminder At` — date w/ time (nullable)
- (`Reminder Count` already exists on Customers but is per-customer; we want per-task. Add `Tasks.Reminder Count` — number, default 0. Leave `Customers.Reminder Count` deprecated/unused or repurpose later.)

### New Brokerage rows
- `D2C-Prepaid`: paymentMode = `pre-paid`, workflowKey = `D2C-Standard`
- (Existing) `Keyes`, `Baird & Warner`: update with `paymentMode = setup-intent-at-intake` / `invoice`
- (Future) `Illustrated Properties`: paymentMode = `setup-intent-at-intake`

### Workflow Templates
- Add "Capture Payment Method" row to `B2B-Keyes` (and future Keyes-like flows).
- Remove placeholder "Start Your Trial" from `B2B-Keyes`.

### Migration
- Backfill `Customers.Brokerage = D2C-Prepaid` for all existing D2C customers.
- Backfill `Customers.At Risk = none` (Airtable single-select default handles this; verify).

## Phasing

### Phase 0 — Schema only (1 day)
- Meta-API script: add fields above, create `D2C-Prepaid` brokerage row, backfill.
- Update TypeScript types (`Brokerage`, `Customer`, `Task`).
- Update mappers in `src/lib/airtable.ts`.
- Lint, typecheck, smoke test.
- **No behavior change yet.**

### Phase 1 — SetupIntent flow + workflow gating (3-4 days)
- Stripe lib setup; SetupIntent API route; `/r/[token]/payment-setup` portal page.
- Add "Capture Payment Method" task to `B2B-Keyes` template; remove "Start Your Trial".
- Stripe webhook for `setup_intent.succeeded` → marks task Completed.
- Auto-completion of "Capture Payment Method" unblocks any downstream `Depends On = "Capture Payment Method"` task.
- Sub creation on `Mark Onboarding Call Complete` (Airtable automation calls webhook on LaunchPad → LaunchPad calls Stripe → stores sub ID).

### Phase 2 — Reminder cron + atRisk (2 days)
- `vercel.json` cron config.
- `/api/cron/dropoff-reminders` route.
- Email template for each stall reason.
- atRisk-clearing logic in webhooks (Stripe, Calendly) and form/approval actions.
- CSM workspace at-risk filter wiring + badges.

### Phase 3 — CSM actions (1 day)
- "Snooze" + "Mark Churned" action panel on customer detail.

### Phase 4 — Migration (2 days)
- CSV upload script for ~500 existing customers.
- Maps existing Stripe sub IDs → `Customers.Stripe Subscription ID`.
- Sets `paymentMode` correctly per customer based on Brokerage.

## Open questions for architect

1. **Attachment Type for "Capture Payment Method"** — should we add a new `Stripe Setup` value to the existing `Attachment Type` enum, or piggyback on `Embed` and route the URL? `Stripe Setup` is more explicit but adds a new component branch in `TaskRenderer`. `Embed` is reusable but loses type-safety on what the task does.

2. **Per-task reminder schedules** — coding the thresholds inline in the cron handler is simple but means brokerage-specific tweaks (e.g. Keyes wants slower reminders) require code changes. Alternative: `Workflow Templates.Reminder Schedule` field (e.g. `"2,5,9"`) — more flexible but more schema. Recommend inline for now, move to template-driven only if a brokerage actually asks.

3. **Sub creation timing** — currently planned for `Mark Onboarding Call Complete`. What if the call no-shows and gets rescheduled? Should sub creation wait until *all* check-ins? Recommend: trigger on first call completion only, since trial covers the "no-show then reschedule" case naturally (trial days continue).

4. **`Customers.Reminder Count` collision** — existing field is unused per current code. Either delete it (cleanest, but `Auto 8` references it in older docs) or repurpose for "total reminders sent across all tasks" as a soft engagement metric. Recommend: delete; keep new `Tasks.Reminder Count` only.

5. **Backfill safety** — D2C customers currently have `Channel = "Direct Sales"` etc. After backfill they'll have `Brokerage = D2C-Prepaid` AND keep their `Channel`. Workflow Key formula stays `{Type}-{Channel}` → `D2C-Direct Sales` won't match any template. Need to either (a) change formula to `{Brokerage.Default Workflow Key}` or (b) leave formula alone and rely on Channel staying canonical. Recommend (a) — formula reads from Brokerage. Cleaner, and unifies template lookup with payment-mode lookup.

## What this plan does NOT cover

- The SetupIntent UI itself (Stripe Elements integration on the portal page) — that's part of Phase 1 build, not architectural.
- Voice/Avatar add-on payment flows — separate Phase 5.
- Engagement-data dump for CSM signals (e.g. "agent hasn't logged in") — deferred until the dump API exists.
- Dunning / failed-payment handling on existing subs — out of scope for onboarding; lives in Rejig core app.
