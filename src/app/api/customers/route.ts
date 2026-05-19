import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import * as schema from '@/db/schema';
import { getBrokerageByDefaultWorkflowKey } from '@/lib/db';
import { generateTasksFromTemplate } from '@/lib/automations/generate-tasks';
import { triggerCustomerEmail } from '@/lib/automations/trigger-email';
import { pushCustomerIntakeToHubSpot } from '@/lib/integrations/hubspot/intake-handler';
import { getSession, isAdminWriter } from '@/lib/auth/dal';
import type { Customer } from '@/types';

export async function POST(request: NextRequest) {
  // /admin "Add Customer" form posts here. Restricted to admin-write users
  // (poorab@rejig.ai). Everyone else gets 403 — matches the UI gating in
  // /admin which hides the form for non-writers.
  const session = await getSession();
  if (!session || !isAdminWriter(session)) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

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

  // Auto 5: Welcome email — awaited (not fire-and-forget). Vercel serverless
  // terminates the function instance when the response returns, so void
  // would drop the Resend API call if Vercel kills the instance too quickly.
  // Adds ~500ms to response. Errors logged but don't fail the response —
  // the Customer + Tasks already landed.
  try {
    await triggerCustomerEmail('welcome', customer.id);
  } catch (err) {
    console.error('[customers POST] Welcome email failed (non-blocking):', err);
  }

  // Stripe Customer creation moved to the SetupIntent route (lazy-create).
  // Pre-Phase-1.5.6 this fired here at intake for setup-intent-at-intake
  // workflows; that left orphan Stripe Customers for B2B-Keyes agents who
  // submitted the form but never reached the payment step. The SetupIntent
  // route now creates the Stripe Customer on first use + persists the ID.

  // HubSpot intake push — awaited (not fire-and-forget). Vercel serverless
  // terminates the function instance when the response returns, so a void
  // promise would not complete reliably (verified 2026-05-14 — a Keyes
  // customer was created but the HS push never landed, only succeeded when
  // re-fired manually).
  //
  // Adds 2-5s to the response time but guarantees the HS Ticket exists
  // before we return success. Soft-fail: if HS push errors, we log it but
  // still return the LP customer — the customer record is canonical, HS is
  // the mirror. Admin can retry the push via backfill script if needed.
  //
  // Runs for BOTH D2C and B2B admin-created customers. D2C closedwon
  // customers come through src/lib/integrations/hubspot/closedwon-handler.ts
  // and skip this path entirely.
  //
  // See src/lib/integrations/hubspot/intake-handler.ts for the full
  // object graph + association rules per type.
  let hubspotTicketId: string | null = null;
  let hubspotPushError: string | null = null;
  try {
    const result = await pushCustomerIntakeToHubSpot(customer.id);
    if (result.kind === 'pushed') {
      hubspotTicketId = result.ticketId;
    } else if (result.kind === 'error') {
      hubspotPushError = result.error;
      console.error('[customers POST] HS intake push error:', result.error);
    } else {
      console.log('[customers POST] HS intake push skipped:', result.reason);
    }
  } catch (err) {
    hubspotPushError = err instanceof Error ? err.message : String(err);
    console.error('[customers POST] HS intake push threw:', err);
  }

  return Response.json({
    id: customer.id,
    accessToken: customer.accessToken,
    name,
    type,
    channel,
    hubspotTicketId,
    hubspotPushError,
  });
}
