import { NextRequest } from 'next/server';
import {
  createCustomer,
  getBrokerageByDefaultWorkflowKey,
  getWorkflowTemplates,
  updateCustomerFields,
} from '@/lib/db';
import { createStripeCustomer } from '@/lib/stripe';
import type { Customer } from '@/types';

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

  // For B2B, link the Brokerage record so Auto 1 (Phase 3) can pull the
  // brokerage's Default Calendly URL into the Schedule task. We match on
  // Default Workflow Key (e.g., B2B-Keyes) — the canonical join — instead of
  // Channel name, since BW's Channel="BW" but Brokerage.Name="Baird & Warner".
  const workflowKey = `${type}-${channel}`;
  const brokerage =
    type === 'B2B' ? await getBrokerageByDefaultWorkflowKey(workflowKey) : null;

  const customer = await createCustomer({
    name,
    type: type as Customer['type'],
    channel,
    contactEmail: email,
    platformEmail: email,                                            // defaults to contact email; AccountCreator can override later
    currentStage: 'Getting Started',                                 // first stage across all workflows
    businessName,
    businessAddress,
    website,
    phone,
    hasVoice: hasVoice ?? false,
    hasAvatar: hasAvatar ?? false,
    brokerageId: brokerage?.id ?? null,
  });

  // For setup-intent-at-intake workflows (e.g., B2B-Keyes), create the
  // Stripe Customer up-front so the SetupIntent route can assume it exists.
  // Soft-fail on Stripe error.
  let stripeCustomerId: string | null = null;
  let stripeSyncPending = false;
  const templates = await getWorkflowTemplates(workflowKey);
  const paymentMode = templates[0]?.paymentMode ?? null;

  if (paymentMode === 'setup-intent-at-intake') {
    try {
      const stripeCustomer = await createStripeCustomer({
        airtableCustomerId: customer.id,                             // arg name preserved in lib/stripe.ts — metadata key on Stripe side
        email,
        name,
      });
      stripeCustomerId = stripeCustomer.id;
      await updateCustomerFields(customer.id, { stripeCustomerId: stripeCustomer.id });
    } catch (err) {
      console.error('[customers POST] Stripe customer creation failed:', err);
      stripeSyncPending = true;
    }
  }

  return Response.json({
    id: customer.id,
    accessToken: customer.accessToken,
    name,
    type,
    channel,
    stripeCustomerId,
    stripeSyncPending,
  });
}
