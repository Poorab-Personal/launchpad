import { NextRequest } from 'next/server';
import { createRecord, updateRecord } from '@/lib/airtable-client';
import { getWorkflowTemplates } from '@/lib/airtable';
import { createStripeCustomer } from '@/lib/stripe';

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { name, type, channel, email, businessName, businessAddress, website, phone, hasVoice, hasAvatar } = body as {
    name: string;
    type: string;
    channel: string;
    email: string;
    businessName?: string;
    businessAddress?: string;
    website?: string;
    phone?: string;
    hasVoice?: boolean;
    hasAvatar?: boolean;
  };

  if (!name || !type || !channel || !email) {
    return Response.json(
      { error: 'Missing required fields: name, type, channel, email' },
      { status: 400 },
    );
  }

  // Create the customer record — Airtable Auto 1 handles task generation
  const customerFields: Record<string, unknown> = {
    Name: name,
    Type: type,
    Channel: channel,
    'Contact Email': email,
  };
  if (businessName) customerFields['Business Name'] = businessName;
  if (businessAddress) customerFields['Business Address'] = businessAddress;
  if (website) customerFields['Website'] = website;
  if (phone) customerFields['Phone'] = phone;
  if (hasVoice) customerFields['Has Voice'] = true;
  if (hasAvatar) customerFields['Has Avatar'] = true;

  const customerRecord = await createRecord('Customers', customerFields);

  // For setup-intent-at-intake workflows (e.g., B2B-Keyes), create the
  // Stripe Customer up-front so the SetupIntent route can assume it exists.
  // Soft-fail on Stripe error: log + return success with a flag — admin
  // can manually retry; we don't want a half-created Airtable record on
  // a transient Stripe outage.
  let stripeCustomerId: string | null = null;
  let stripeSyncPending = false;
  const workflowKey = `${type}-${channel}`;
  const templates = await getWorkflowTemplates(workflowKey);
  const paymentMode = templates[0]?.paymentMode ?? null;

  if (paymentMode === 'setup-intent-at-intake') {
    try {
      const stripeCustomer = await createStripeCustomer({
        airtableCustomerId: customerRecord.id,
        email,
        name,
      });
      stripeCustomerId = stripeCustomer.id;
      await updateRecord('Customers', customerRecord.id, {
        'Stripe Customer ID': stripeCustomer.id,
      });
    } catch (err) {
      console.error('[customers POST] Stripe customer creation failed:', err);
      stripeSyncPending = true;
    }
  }

  return Response.json({
    id: customerRecord.id,
    accessToken: customerRecord.id,
    name,
    type,
    channel,
    stripeCustomerId,
    stripeSyncPending,
  });
}
