# HubSpot → LaunchPad Customer Creation

**Status (post-cutover 2026-05-12):** **DEFERRED rewire.** This doc described the old Airtable-based Zap. Post-cutover, HubSpot deals **do not yet flow into LaunchPad** — Phase 6 of the migration plan (rewire the Zap to POST to `/api/customers`) is deferred until LaunchPad has a stable production custom domain.

While deferred, new HubSpot deals go nowhere — they sit in HubSpot. The Airtable Zap that previously created Customer rows has been disabled (or its target base deleted). New LaunchPad customers must be created manually via `/admin → Add Customer`.

**This doc is retained as the reference for what the rewired Zap should produce.** Once a production domain is in place, follow this spec but point at the LaunchPad route, not Airtable.

---

## What the rewired Zap will do

When a D2C deal closes in HubSpot, Zapier POSTs to LaunchPad's customer-creation endpoint. LaunchPad's `POST /api/customers` route inserts the customer + generates tasks atomically (Auto 1 runs inline in the transaction).

## Zapier setup (when ready)

### Trigger
- **App:** HubSpot
- **Event:** Deal Stage Changed (or Deal Created)
- **Filter:** Deal Stage = "Closed Won"

### Action
- **App:** Webhooks by Zapier
- **Event:** POST
- **URL:** `https://<production-domain>/api/customers`
- **Headers:**
  - `Content-Type: application/json`
  - `X-Zapier-API-Key: <shared secret>` (add an auth check to the route — see notes below)
- **Body (JSON):** map HubSpot fields:

```json
{
  "name": "{{HubSpot.full_name_or_deal_name}}",
  "type": "D2C",
  "channel": "Standard",
  "email": "{{HubSpot.contact_email}}",
  "phone": "{{HubSpot.contact_phone}}",
  "businessName": "{{HubSpot.company_name}}",
  "hubspotDealId": "{{HubSpot.deal_id}}"
}
```

### Response handling

The route returns:
```json
{
  "id": "<uuid>",
  "accessToken": "<uuid>",
  "name": "...",
  ...
}
```

Use `accessToken` to build the portal URL: `https://<production-domain>/r/{{accessToken}}`. Optionally have Zapier send that link in a follow-up notification.

### Welcome email

Already handled — LaunchPad's `POST /api/customers` triggers the Welcome email via Resend automatically (Auto 5 port). No separate Zapier step needed.

## Notes for the rewire

1. **Auth.** Today's `POST /api/customers` has no API-key check. Before pointing real HubSpot deals at it, add a `X-Zapier-API-Key` header validation gate.
2. **Channel mapping.** HubSpot won't natively know about B2B brokerages. For B2B deals, use a different Zap or include the `channel` value (`Keyes`, `BW`, etc.) explicitly in the deal data.
3. **Idempotency.** If Zapier retries on transient failures, you may get duplicate customer rows. Consider:
   - Adding a UNIQUE index on `customers.hubspot_deal_id` (currently nullable; would need a NOT-VALID check first)
   - Or having the route detect-and-skip when `hubspotDealId` already exists
4. **Stripe Customer creation.** For D2C-Standard with `payment_mode = pre-paid`, no Stripe Customer is created at customer-insert time (legacy assumption: payment already happened in HubSpot via Stripe). If you later move D2C to setup-intent-at-intake, the route will auto-create the Stripe Customer per Phase 1 logic.

## What's gone vs. the legacy spec

The legacy doc had ~14 fields mapped from HubSpot → Airtable, including `HubSpot Contact URL`, `HubSpot Deal URL`, `Sales Rep`, `Lead Source`, `Deal Value`, `Deal Close Date`, `Product Tier`, `Payment Status`. None of those columns exist in the Postgres `customers` schema today — they were stored in Airtable but never read by app code. If any of them turn out to be useful for the CSM workspace later, add the columns then (one migration each, no big deal).

## See also

- `docs/plans/airtable-to-postgres-migration.md` — Phase 6 description
- `CLAUDE.md` — overall architecture; `POST /api/customers` flow
- Memory: `pending_todos.md` Phase 6 entry
