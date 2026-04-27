# HubSpot → Zapier → Airtable Integration

## Overview

When a D2C deal closes in HubSpot, Zapier creates a Customer record in Airtable. Airtable Auto 1 generates tasks automatically.

## Zapier Setup

### Trigger
- **App:** HubSpot
- **Event:** Deal Stage Changed (or Deal Created)
- **Filter:** Deal Stage = "Closed Won"

### Action
- **App:** Airtable
- **Event:** Create Record
- **Table:** Customers

### Field Mapping

| Airtable Field | HubSpot Source | Notes |
|---|---|---|
| Name | Contact: Full Name | Or Deal: Deal Name |
| Type | (hardcode) "D2C" | All HubSpot deals are D2C |
| Channel | Deal: Lead Source or Pipeline | Maps to workflow key. Use "Standard" as default |
| Contact Email | Contact: Email | Primary email |
| Phone | Contact: Phone | |
| HubSpot Deal ID | Deal: Deal ID | |
| HubSpot Contact URL | (formula) | `https://app.hubspot.com/contacts/{YOUR_PORTAL_ID}/contact/` + Contact ID |
| HubSpot Deal URL | (formula) | `https://app.hubspot.com/contacts/{YOUR_PORTAL_ID}/deal/` + Deal ID |
| Stripe Payment ID | Deal: Custom Property | If you store Stripe ID on the deal |
| Product Tier | Deal: Product/Line Item | "Premium" or "Luxury" |
| Payment Status | (hardcode) "Paid" | Deal is closed = paid |
| Deal Value | Deal: Amount | |
| Deal Close Date | Deal: Close Date | |
| Sales Rep | Deal: Deal Owner Name | |
| Lead Source | Deal: Lead Source | Or Deal: Original Source |

### After Record Created

Airtable Auto 1 fires automatically:
1. Generates 16 tasks from D2C-Standard workflow templates
2. Sets Current Stage to "Getting Started"
3. Logs "Customer Created" event

### Welcome Email

Add a second Zapier step (or handle via Airtable automation):
- **Action:** Send Email (Gmail or SendGrid)
- **To:** Customer's Contact Email
- **From:** success@rejig.ai (or configured sender)
- **Subject:** "Welcome to Rejig — Let's get started!"
- **Body:** Include portal link: `https://onboarding.rejig.ai/r/{Airtable Record ID}`

Note: Zapier's Airtable "Create Record" action returns the record ID. Use this to construct the portal URL.

## HubSpot Portal ID

Replace `{YOUR_PORTAL_ID}` in the URL formulas with your actual HubSpot portal ID.
Find it at: HubSpot → Settings → Account Defaults → Portal ID.

## Stripe Data (Phase 2)

Subscription data from Stripe will be pulled separately (not through Zapier/HubSpot):
- Stripe webhook → our API → updates Customer record
- Fields: Subscription Status, Billing Cycle, MRR, Renewal Date
- This happens after the customer starts their subscription, not at deal close

## Testing

1. Create a test deal in HubSpot and move to "Closed Won"
2. Verify Zapier triggers and creates the Airtable record
3. Verify Auto 1 generates tasks
4. Check the portal URL works: `onboarding.rejig.ai/r/{record-id}`
5. Verify HubSpot Contact URL and Deal URL are clickable in Airtable
