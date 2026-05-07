# Integration Notes — Payment Mode + DMG Roster

**Status:** Companion doc to the two v2 plans
**Date:** 2026-05-06

These two plans were drafted independently and reviewed independently. This doc captures the places they touch each other so neither implementation surprises the other.

**The two plans:**
- `docs/plans/payment-mode-dropoff.md` — Workflow-Templates `Payment Mode`, gated design, Calls-driven sub creation, drop-off reminder cron, `At Risk` surfacing.
- `docs/integrations/dmg-roster-plan.md` — Vercel Postgres for bulk DMG roster, daily sync cron, magic-link agent verification, Airtable handoff.

---

## 1. Brokerages table — combined delta

After both architect reviews, **only the roster plan adds fields to `Brokerages`**. The payment-mode plan moved `Payment Mode` / `Stripe Price ID` / `Trial Days` to `Workflow Templates`. So:

| Field | Plan | Notes |
|---|---|---|
| `Support Contact Name` | roster | New |
| `Support Contact Email` | roster | New |
| `Support Contact Phone` | roster | New |
| `Roster API URL` / `Roster API Key` / `Roster Refresh Interval` | roster | Delete or rename-as-vestigial — Decision for Poorab #1 in roster v2 |

No conflicts. Brokerages keeps its semantic meaning ("a real estate brokerage we have a deal with").

---

## 2. Workflow Templates — single home for payment-mode config

The payment-mode plan owns this table's new fields. The roster plan does not touch it. This is clean — payment policy and roster sync are orthogonal.

When the roster plan creates a Customer, Auto 1 fires with the `Workflow Key` derived from `Customer.Channel` (e.g. `B2B-Keyes`). Auto 1 reads `Payment Mode` off any matching Workflow Templates row and generates the right tasks (including or excluding "Capture Payment Method"). **No code change needed in either plan to compose them** — Auto 1 is the integration point and already exists.

---

## 3. B2B-Keyes flow doc gets two simultaneous edits

`docs/flows/b2b-keyes.md` is tagged `VETTED, SOURCE OF TRUTH`. Both plans require updates to it:

- **Roster plan:** entry-point flow changes from "6-digit verification code" to "magic link."
- **Payment-mode plan:** "Start Your Trial" placeholder task replaced with "Capture Payment Method" (Stripe SetupIntent).

**Coordination rule:** whoever touches `b2b-keyes.md` first must ship BOTH edits in the same PR, OR explicitly note in their PR that the other edit is pending and the doc will be inconsistent until the second PR lands. Don't leave the vetted doc half-updated.

Same coordination for `b2b-bw.md` (only roster touches it — magic-link change — but we should double-check no payment-mode edit lands there since B&W is `invoice` mode).

---

## 4. Stripe Customer creation lives in the magic-link click handler (Keyes path)

Per payment-mode v2 (Section 4): for `setup-intent-at-intake` workflows, `Customers.Stripe Customer ID` is populated **at Customer record creation**. Per roster v2 (Section 4.2): for B2B-Keyes, the Customer record is created inside the **magic-link click handler's advisory-lock transaction**.

**Therefore:** the Stripe `customers.create()` call lands inside the roster click handler's `createCustomerFromAgent()` function (`src/lib/roster/create-customer.ts`), gated by the workflow's `Payment Mode = setup-intent-at-intake`.

This is one extra Stripe API call inside the locked transaction. Acceptable — it's ~200ms, idempotent (Stripe `customers.create` is safe to retry with the same idempotency key), and keeps the Stripe Customer existing before the SetupIntent route runs.

**Implementation note:** pass `idempotencyKey = roster_agent.id` to `stripe.customers.create()` so a retry of the click path doesn't create two Stripe customers. The `customer_record_id` check makes a full retry rare, but a partial failure between Stripe call and Airtable Customer write is the exact scenario the idempotency key handles.

If Stripe fails inside the lock: roll back the Postgres transaction, return an error to the user, do NOT create the Airtable Customer row. The advisory lock releases on rollback. Next click retries cleanly.

---

## 5. Two drop-off categories, two mechanisms

Don't build the same reminder twice:

| Category | When | Mechanism | Plan |
|---|---|---|---|
| Pre-verification | Agent never enters email at `/b/{slug}`, OR enters email but never clicks magic link | Sales-driven SQL nudges via Neon SQL console, querying `roster_agents WHERE customer_record_id IS NULL` | Roster plan §4.3 |
| Post-verification | Customer record created, but stalls on Capture Payment Method / Schedule Onboarding Call / form submission / design approval | Vercel cron `/api/cron/dropoff-reminders` + `Customers.At Risk` flag | Payment-mode plan §5–§7 |

These don't overlap. A pre-verification agent has no Customer record, so no Active tasks for the reminder cron to find. A post-verification customer is gone from the "unboarded" Postgres view (`customer_record_id IS NOT NULL`). Each mechanism has its own surface.

Don't add reminder logic to the roster path; don't add SQL nudge queries to the payment-mode path. Keep the boundary clean.

---

## 6. Vercel Cron — first cron infrastructure in this repo

Both plans add a `vercel.json` cron entry. There is currently no `vercel.json` in the repo. **Whoever ships their cron first creates the file with both entries pre-listed** (even if only one route exists yet — a missing route is a 404, not a failure mode that breaks Vercel deploys).

Combined `vercel.json`:
```json
{
  "crons": [
    { "path": "/api/cron/sync-roster-all", "schedule": "0 6 * * *" },
    { "path": "/api/cron/dropoff-reminders", "schedule": "0 14 * * *" }
  ]
}
```

`CRON_SECRET` env var is shared. Both handlers use `Authorization: Bearer ${CRON_SECRET}` as the literal first line. One env var, two handlers.

---

## 7. Combined env var additions

Both plans together add these to Vercel (Production + Preview):

```
# From payment-mode plan
STRIPE_SECRET_KEY=...
STRIPE_WEBHOOK_SECRET=...

# From roster plan
POSTGRES_URL=...                  # auto-set by Vercel-Neon integration
POSTGRES_URL_NON_POOLING=...      # auto-set by Vercel-Neon integration
DMG_KEYES_CLIENT_ID=...
DMG_KEYES_CLIENT_SECRET=...
DMG_BAIRD_WARNER_CLIENT_ID=...
DMG_BAIRD_WARNER_CLIENT_SECRET=...
ALERTS_EMAIL=alerts@rejig.ai

# Shared
CRON_SECRET=...                   # used by BOTH cron handlers
SESSION_SECRET=...                # already set; reused by roster magic-link
```

Document all of these in `.env.local.example` (if it exists) or a new env-vars README at the same time.

---

## 8. Combined Airtable Events table additions

Only the roster plan adds a new Event Type:

- `Roster Synced` — fired by the daily roster cron, one row per brokerage per run.

Payment-mode plan doesn't add new Event Types. The existing `Task Completed`, `Task Activated`, etc. cover everything the new flows need.

When updating the Events table single-select, add only `Roster Synced` (and any others either plan introduces during implementation).

---

## 9. Implementation order recommendation

Both plans are mostly independent and can ship in any order. **Recommended sequence** to minimize risk:

1. **Payment-mode Phase 0** (schema-only, no behavior change) — 1 day. Adds Workflow Templates / Customers / Tasks fields, deletes deprecated fields. Safe baseline.
2. **Roster Phase 1** (Postgres provisioning + DMG client + manual sync script) — no user-facing change. Validates the Postgres principle in production.
3. **Roster Phase 2** (cron) — daily sync running, Events writes confirmed for 3 days before promoting.
4. **Payment-mode Phase 1** (SetupIntent flow, Calls-driven sub creation, workflow gating) — this is the heaviest single phase.
5. **Roster Phase 3** (lookup + landing pages + magic-link verification) — depends on Stripe `customers.create()` integration from payment-mode Phase 1 if going live with Keyes.
6. **Payment-mode Phase 2** (reminder cron + At Risk).
7. **Payment-mode Phase 3** (CSM actions).
8. **Roster Phase 4** (cutover, sunset legacy app).
9. **Payment-mode Phase 4** (Stripe Subscription ID backfill).

The natural dependency: Roster Phase 3 (which creates B2B Customers) needs Payment-mode Phase 1's Stripe Customer creation logic to be ready, since `setup-intent-at-intake` workflows require a Stripe Customer at Customer creation time. Reorder if ship cadence demands.

---

## 10. Open coordination items (not blockers)

- **Both plans add a `safety net` audit query for CSM workspace.** Payment-mode wants "customers in Stage 4+ with `Payment Mode = setup-intent-at-intake` and no `Stripe Subscription ID`." Roster doesn't add an audit, but the at-risk surfacing needs to handle B2B customers with stalled Capture Payment Method. Likely the same kanban column. Wire once, not twice.

- **`Customer.Brokerage` link** — the roster plan creates B2B Customers with the `Brokerage` link populated. Payment-mode plan doesn't read this field (config is on Workflow Templates), so no read-path conflict. But: if Decision-for-Poorab #1 from the payment-mode plan ever flips (per-brokerage Stripe pricing on the same workflow), this link becomes the join key. Worth knowing it's reliably populated for B2B from day one.

- **Decisions for Poorab** — each plan has its own list at the end. Total: 4 items across both plans. Resolve all four before kicking off the phases that depend on them (mostly Phase 1 and Phase 3 of each plan).

---

## 11. What this doc does NOT cover

- Implementation details of either plan (read the plans).
- The four "Decisions for Poorab" — those live in their respective plan docs.
- Future plans (add-on Voice/Avatar payment, engagement-data dump, etc.) — those will get their own integration notes when they land.
