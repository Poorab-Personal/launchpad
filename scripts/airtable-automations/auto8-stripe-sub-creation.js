// Airtable Automation 8: Onboarding Call Completed → Create Stripe Subscription
//
// In your Airtable base, name this automation: "Auto 8 - Stripe Sub Creation"
//
// Trigger: When a record in Calls matches:
//   Status = "Completed" AND Type = "Onboarding"
//   (configure both as conditions in the "When record matches conditions" trigger)
//
// What it does: POSTs the Calls record ID to LaunchPad's
//   /api/webhooks/calls/completed endpoint. LaunchPad then:
//     - Re-validates the call state (defense in depth)
//     - Looks up the customer's selected Stripe price + workflow trial days
//     - Creates a Stripe subscription (with trial) using the saved card
//     - Writes back Stripe Subscription ID + Subscription Status
//
// Input variables (configure these in the automation script step):
//   - recordId      → Insert > Trigger record > Airtable record ID
//   - webhookUrl    → Static text: https://launchpad-indol-ten.vercel.app/api/webhooks/calls/completed
//   - webhookSecret → Static text: matches AIRTABLE_WEBHOOK_SECRET in Vercel env
//
// Idempotent: LaunchPad's endpoint is a no-op if the customer already has a
// Stripe Subscription ID, so re-runs are safe.

const config = input.config();
const { recordId, webhookUrl, webhookSecret } = config;

if (!recordId || !webhookUrl || !webhookSecret) {
    throw new Error('Missing recordId, webhookUrl, or webhookSecret. Check the automation Input variables.');
}

console.log(`Notifying LaunchPad of completed call: ${recordId}`);

const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
        'Authorization': `Bearer ${webhookSecret}`,
        'Content-Type': 'application/json',
    },
    body: JSON.stringify({ recordId }),
});

const text = await res.text();
console.log(`LaunchPad responded ${res.status}: ${text}`);

if (!res.ok) {
    throw new Error(`Webhook failed with status ${res.status}: ${text}`);
}
