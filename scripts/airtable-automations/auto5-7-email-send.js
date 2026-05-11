// Airtable Automations 5/6/7: Send Customer Email via LaunchPad
//
// One shared script body — used by three separate Airtable automations,
// each with a different `template` input value and trigger condition.
// LaunchPad's POST /api/email/send route does the React Email render +
// Resend send using the customer record's data.
//
// In your Airtable base, the three automations are:
//
// ── Auto 5 — Email: Welcome ─────────────────────────────────────────────
//   Trigger:  When a Customers record is created
//   Inputs:
//     customerId → Trigger record → Airtable record ID
//     template   → Static text: welcome
//
// ── Auto 6 — Email: Design Ready ────────────────────────────────────────
//   Trigger:  When a Tasks record matches:
//             Task Name = "Review & Approve Your Brand Kit" AND Status = "Active"
//   Inputs:
//     customerId → Trigger record → Customer (linked) → Airtable record ID
//     template   → Static text: design-ready
//
// ── Auto 7 — Email: Credentials Sent ────────────────────────────────────
//   STATUS: paused / obsolete. Credentials emails are now sent server-side
//   from SendCredentialsAction → /api/workspace/send-credentials → Resend.
//   The Airtable trigger is no longer the source of truth. Safe to delete.
//
// LaunchPad endpoint expects: { template: string, customerId: string }
// Recipient + portal URL + first name + temp password are all derived
// server-side from the Customer record.

const { customerId, template } = input.config();

const settingsTable = base.getTable('Settings');
const sq = await settingsTable.selectRecordsAsync({ fields: ['Name', 'Portal Base URL'] });
const prod = sq.records.find(r => r.getCellValueAsString('Name') === 'Production');
const baseUrl = prod ? prod.getCellValueAsString('Portal Base URL') : '';
if (!baseUrl) throw new Error('No Portal Base URL in Settings.Production');

// Customer linked field comes through as an array — take the first
const custId = Array.isArray(customerId) ? customerId[0] : customerId;

const res = await fetch(`${baseUrl}/api/email/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ template, customerId: custId }),
});

const text = await res.text();
if (!res.ok) throw new Error(`Email API ${res.status}: ${text}`);
console.log(`Email "${template}" sent for ${custId}: ${text}`);
