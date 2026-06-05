import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import * as schema from '@/db/schema';
import { getBrokerageByDefaultWorkflowKey } from '@/lib/db';
import { generateTasksFromTemplate } from '@/lib/automations/generate-tasks';
import { triggerCustomerEmail } from '@/lib/automations/trigger-email';
import { notifyAssigneesForNewCustomer } from '@/lib/automations/notify-assignee';
import { notifyCustomerCreated } from '@/lib/automations/notify-new-customer';
import { INTAKE_PUSH_TRIGGER_TASK } from '@/lib/automations/activate-dependents';
import { pushCustomerIntakeToHubSpot } from '@/lib/integrations/hubspot/intake-handler';
import { getSession, isEffectiveAdminWriter } from '@/lib/auth/dal';
import type { Customer } from '@/types';

export async function POST(request: NextRequest) {
  // /admin "Add Customer" form posts here. Restricted to admin-write users
  // (poorab@rejig.ai). Everyone else gets 403 — matches the UI gating in
  // /admin which hides the form for non-writers.
  const session = await getSession();
  if (!session || !(await isEffectiveAdminWriter(session))) {
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

  // Defensive: scan post-commit for any Active+Team+assigned tasks and notify
  // the assignees. All current workflows have only the Client intake task
  // starting Active, so typically a no-op — but a future template row with
  // initial_status='Active' on a Team task would otherwise silently skip.
  await notifyAssigneesForNewCustomer(customer.id);

  // Internal alert to the monitoring inbox.
  await notifyCustomerCreated(customer.id);

  // Stripe Customer creation moved to the SetupIntent route (lazy-create).
  // Pre-Phase-1.5.6 this fired here at intake for setup-intent-at-intake
  // workflows; that left orphan Stripe Customers for B2B-Keyes agents who
  // submitted the form but never reached the payment step. The SetupIntent
  // route now creates the Stripe Customer on first use + persists the ID.

  // HubSpot intake push — gated on whether the workflow has a commitment-task
  // trigger wired in Auto 2's INTAKE_PUSH_TRIGGER_TASK.
  //
  //   - D2C-Standard (no trigger task): push HS immediately here. Admin is
  //     the canonical D2C entry-point alongside closedwon-handler; D2C has
  //     no "commitment" task to defer to.
  //   - B2B-IPRE / B2B-Keyes (setup-intent-at-intake): SKIP — wait for the
  //     customer to actually complete Capture Payment Method. Auto 2's
  //     trigger fires HS push at that point. Matches landing-flow behavior.
  //   - B2B-BW (intake-only, no payment): SKIP — wait for Confirm Your
  //     Information completion. Auto 2 fires there.
  //
  // Pre-2026-06-05 this was unconditional, which created admin↔landing
  // divergence: admin-created B2B customers got HS tickets immediately
  // while landing-created customers correctly deferred. This now aligns
  // both paths to the same model.
  //
  // closedwon-handler.ts (D2C deal closedwon) is unaffected — it creates
  // customers via its own path and stays immediate.
  //
  // See src/lib/integrations/hubspot/intake-handler.ts for the object
  // graph + association rules.
  let hubspotTicketId: string | null = null;
  let hubspotPushError: string | null = null;
  const hasDeferredTrigger = customer.workflowKey in INTAKE_PUSH_TRIGGER_TASK;
  if (hasDeferredTrigger) {
    console.log(
      `[customers POST] HS push deferred for workflow ${customer.workflowKey} — Auto 2 will fire at "${INTAKE_PUSH_TRIGGER_TASK[customer.workflowKey]}" completion.`,
    );
  } else {
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
