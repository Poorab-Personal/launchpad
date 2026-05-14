import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import * as schema from '@/db/schema';
import {
  getBrokerageByDefaultWorkflowKey,
  getWorkflowTemplates,
  updateCustomerFields,
} from '@/lib/db';
import { generateTasksFromTemplate } from '@/lib/automations/generate-tasks';
import { triggerCustomerEmail } from '@/lib/automations/trigger-email';
import { createStripeCustomer } from '@/lib/stripe';
import { pushB2BCustomerToHubSpot } from '@/lib/integrations/hubspot/b2b-intake-handler';
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

  // For B2B, link the Brokerage record so Auto 1 can pull the brokerage's
  // Default Calendly URL into the Schedule task.
  const workflowKey = `${type}-${channel}`;
  const brokerage =
    type === 'B2B' ? await getBrokerageByDefaultWorkflowKey(workflowKey) : null;

  // Resolve channel FK once, before the tx
  const channelRow = await db.query.channels.findFirst({
    where: eq(schema.channels.code, channel),
  });
  if (!channelRow) {
    return Response.json({ error: `Unknown channel: ${channel}` }, { status: 400 });
  }

  // Atomic: Customer insert + Auto 1 task generation in one transaction.
  // Either both land or neither does. Replaces the legacy Airtable Auto 1
  // which fired async after row insert (a class of partial-failure bug
  // we no longer have).
  const customer = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(schema.customers)
      .values({
        name,
        type: type as Customer['type'],
        channelId: channelRow.id,
        workflowKey,
        contactEmail: email,
        platformEmail: email,
        currentStage: 'Getting Started',
        businessName: businessName ?? null,
        businessAddress: businessAddress ?? null,
        website: website ?? null,
        phone: phone ?? null,
        hasVoice: hasVoice ?? false,
        hasAvatar: hasAvatar ?? false,
        brokerageId: brokerage?.id ?? null,
      })
      .returning();

    await generateTasksFromTemplate(tx, {
      customerId: inserted.id,
      type: inserted.type,
      channel,
      brokerageId: inserted.brokerageId,
      hasVoice: inserted.hasVoice,
      hasAvatar: inserted.hasAvatar,
    });

    return inserted;
  });

  // Auto 5: Welcome email, fire-and-forget post-tx. Errors logged but
  // don't fail the response — the Customer + Tasks already landed.
  void triggerCustomerEmail('welcome', customer.id);

  // For setup-intent-at-intake workflows (e.g., B2B-Keyes), create the
  // Stripe Customer up-front so the SetupIntent route can assume it exists.
  // Outside the tx — Stripe call is slow + must not abort the local insert
  // on a transient Stripe outage. Soft-fail.
  let stripeCustomerId: string | null = null;
  let stripeSyncPending = false;
  const templates = await getWorkflowTemplates(workflowKey);
  const paymentMode = templates[0]?.paymentMode ?? null;

  if (paymentMode === 'setup-intent-at-intake') {
    try {
      const stripeCustomer = await createStripeCustomer({
        customerId: customer.id,
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

  // B2B HubSpot push — fire-and-forget. Creates the agent Contact (or finds
  // existing) + Pre-Onboarding Ticket associated to brokerage Company. Soft-
  // fails on any HS error: LP customer already landed, customer can use the
  // portal; CSM-side experience just won't have a ticket until we fix.
  // See src/lib/integrations/hubspot/b2b-intake-handler.ts for the full
  // object graph + association rules.
  if (type === 'B2B') {
    void pushB2BCustomerToHubSpot(customer.id).then((result) => {
      if (result.kind === 'error') {
        console.error('[customers POST] B2B HS push failed:', result.error);
      } else if (result.kind === 'skipped') {
        console.log('[customers POST] B2B HS push skipped:', result.reason);
      }
    }).catch((err) => {
      console.error('[customers POST] B2B HS push threw:', err);
    });
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
