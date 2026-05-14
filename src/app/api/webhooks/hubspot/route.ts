import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { customers } from '@/db/schema/customers';
import { hubspotInboundEvents } from '@/db/schema/hubspotInboundEvents';
import { processDealClosedWon } from '@/lib/integrations/hubspot/closedwon-handler';
import { getStageLabelById } from '@/lib/integrations/hubspot/client';
import { createTrialSubscriptionForCustomer } from '@/lib/automations/handle-call-completed';

/**
 * POST /api/webhooks/hubspot
 *
 * HubSpot webhook receiver. Subscribed events live in
 * `launchpad-integration/src/app/webhooks/webhooks-hsmeta.json`.
 *
 * Architecture per `docs/integrations/hubspot-integration.md`:
 *  1. Verify HubSpot signature (HMAC-SHA256, X-HubSpot-Signature-v3).
 *  2. Idempotency: insert into hubspot_inbound_events keyed on eventId;
 *     ON CONFLICT DO NOTHING.
 *  3. Filter for events we act on (initial slice: deal.dealstage → closedwon,
 *     changeSource=CRM_UI).
 *  4. Dispatch to business-logic handler (D2C customer creation flow).
 *  5. Mark the inbound event as processed.
 *
 * Return 200 quickly even on filter-skip or duplicate — HubSpot retries on
 * non-2xx, and we want to deduplicate silently.
 */

// Max age (ms) for the request timestamp. HubSpot recommends 5 minutes.
const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;

type HubSpotWebhookEvent = {
  eventId: number;
  subscriptionId: number;
  portalId: number;
  appId: number;
  occurredAt: number;
  subscriptionType: string;
  attemptNumber: number;
  objectId: number;
  objectTypeId?: string;
  propertyName?: string;
  propertyValue?: string;
  changeSource?: string;
  sourceId?: string;
  isSensitive?: boolean;
};

export async function POST(request: NextRequest) {
  const clientSecret = process.env.HUBSPOT_CLIENT_SECRET;
  if (!clientSecret) {
    console.error('[hubspot webhook] HUBSPOT_CLIENT_SECRET not set');
    return Response.json({ error: 'Webhook not configured' }, { status: 500 });
  }

  const signature = request.headers.get('x-hubspot-signature-v3');
  const timestamp = request.headers.get('x-hubspot-request-timestamp');
  if (!signature || !timestamp) {
    return new Response('Missing HubSpot signature headers', { status: 400 });
  }

  const rawBody = await request.text();

  // Verify signature
  const tsMs = Number(timestamp);
  if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > SIGNATURE_MAX_AGE_MS) {
    return new Response('Stale or invalid timestamp', { status: 400 });
  }

  const url = request.url;
  const method = 'POST';
  const source = method + url + rawBody + timestamp;
  const expected = crypto.createHmac('sha256', clientSecret).update(source).digest('base64');

  if (
    expected.length !== signature.length ||
    !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  ) {
    console.error('[hubspot webhook] signature mismatch');
    return new Response('Invalid signature', { status: 401 });
  }

  // Parse events. HubSpot delivers an array of events per POST.
  let events: HubSpotWebhookEvent[];
  try {
    events = JSON.parse(rawBody);
    if (!Array.isArray(events)) {
      throw new Error('Expected array');
    }
  } catch {
    return new Response('Invalid JSON payload', { status: 400 });
  }

  // Process each event. Errors on individual events don't fail the whole batch
  // (return 200 to HubSpot regardless; we log + flag in the DB row).
  for (const event of events) {
    await processInboundEvent(event);
  }

  return Response.json({ ok: true, count: events.length });
}

async function processInboundEvent(event: HubSpotWebhookEvent) {
  // 1. Idempotency insert. If we've seen this eventId, ON CONFLICT skips.
  const eventIdStr = String(event.eventId);
  const inserted = await db
    .insert(hubspotInboundEvents)
    .values({
      hubspotEventId: eventIdStr,
      subscriptionType: event.subscriptionType,
      objectType: deriveObjectType(event.objectTypeId, event.subscriptionType),
      objectId: String(event.objectId),
      propertyName: event.propertyName ?? null,
      propertyValue: event.propertyValue ?? null,
      changeSource: event.changeSource ?? null,
      sourceId: event.sourceId ?? null,
      occurredAt: new Date(event.occurredAt),
      rawPayload: event,
      processingStatus: 'pending',
    })
    .onConflictDoNothing({ target: hubspotInboundEvents.hubspotEventId })
    .returning({ id: hubspotInboundEvents.id });

  if (inserted.length === 0) {
    // Already processed (idempotency). Silent success.
    console.log('[hubspot webhook] duplicate event ignored', eventIdStr);
    return;
  }

  // 2. Filter + dispatch by event shape.
  const objectType = deriveObjectType(event.objectTypeId, event.subscriptionType);

  const isDealStageChange =
    event.subscriptionType === 'object.propertyChange' &&
    objectType === 'deal' &&
    event.propertyName === 'dealstage';

  const isTicketStageChange =
    event.subscriptionType === 'object.propertyChange' &&
    objectType === 'ticket' &&
    event.propertyName === 'hs_pipeline_stage';

  if (isDealStageChange) {
    await processDealStageChange(eventIdStr, event);
    return;
  }

  if (isTicketStageChange) {
    await processTicketStageChange(eventIdStr, event);
    return;
  }

  await markProcessed(eventIdStr, 'ignored', `unhandled event: ${event.subscriptionType} on ${objectType}.${event.propertyName ?? ''}`);
}

/**
 * D2C closedwon: HubSpot Deal moves to closedwon → create LP customer.
 * Existing slice.
 */
async function processDealStageChange(eventIdStr: string, event: HubSpotWebhookEvent) {
  if (event.propertyValue !== 'closedwon') {
    await markProcessed(eventIdStr, 'ignored', `propertyValue=${event.propertyValue}, not closedwon`);
    return;
  }

  if (event.changeSource !== 'CRM_UI') {
    // Loop-prevention: ignore our own API-driven changes.
    await markProcessed(eventIdStr, 'ignored', `changeSource=${event.changeSource}, not CRM_UI`);
    return;
  }

  console.log('[hubspot webhook] closedwon event — processing', {
    eventId: eventIdStr,
    dealId: event.objectId,
    sourceUserId: event.sourceId,
  });

  try {
    const result = await processDealClosedWon(String(event.objectId));
    console.log('[hubspot webhook] closedwon processed', result);
    await markProcessed(eventIdStr, 'processed', null);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[hubspot webhook] closedwon failed', msg);
    await markProcessed(eventIdStr, 'error', msg);
  }
}

/**
 * B2B-Keyes Stripe trial activation — "belt A" of the belts-and-suspenders
 * design in docs/plans/post-launch-migration.md Q6.
 *
 * When a Customer Journey ticket moves to "Active" (the post-onboarding-call
 * stage), check whether the associated LaunchPad customer is on a
 * setup-intent-at-intake workflow (B2B-Keyes today) without a Stripe
 * subscription created yet. If so, fire the trial-sub-creation flow.
 *
 * Narrow scope — this handler does NOT transition LP tasks, set callBooked,
 * or do any other side effects. Those used to be Auto 4's job (via the now-
 * deleted Mark Onboarding Call Complete task). Post-Phase-1, the trial
 * subscription is the only LP-side post-meeting action.
 *
 * Idempotent: createTrialSubscriptionForCustomer() guards on existing sub.
 */
async function processTicketStageChange(eventIdStr: string, event: HubSpotWebhookEvent) {
  // Loop prevention: skip API-driven stage changes (LP's own pushes from Auto 2
  // — though Auto 2 only pushes to "Onboarding Scheduled" not "Active", we
  // still defend in case future code paths push to "Active" from LP).
  if (event.changeSource === 'API_CHANGE') {
    await markProcessed(eventIdStr, 'ignored', `changeSource=API_CHANGE — loop prevention`);
    return;
  }

  if (!event.propertyValue) {
    await markProcessed(eventIdStr, 'ignored', 'no propertyValue on ticket stage change');
    return;
  }

  // HubSpot delivers the stage ID, not the label. Resolve.
  let stageLabel: string | null;
  try {
    stageLabel = await getStageLabelById(event.propertyValue);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markProcessed(eventIdStr, 'error', `stage label lookup failed: ${msg}`);
    return;
  }

  if (stageLabel !== 'Active') {
    await markProcessed(eventIdStr, 'ignored', `stage=${stageLabel ?? '(unknown)'}, only Active triggers trial activation`);
    return;
  }

  const ticketId = String(event.objectId);
  const customer = await db.query.customers.findFirst({
    where: eq(customers.hubspotTicketId, ticketId),
    columns: { id: true, workflowKey: true, stripeSubscriptionId: true },
  });

  if (!customer) {
    await markProcessed(eventIdStr, 'ignored', `no LP customer for ticket ${ticketId}`);
    return;
  }

  console.log('[hubspot webhook] ticket → Active — checking trial activation', {
    eventId: eventIdStr,
    ticketId,
    customerId: customer.id,
    workflowKey: customer.workflowKey,
    hasStripeSub: Boolean(customer.stripeSubscriptionId),
  });

  try {
    const result = await createTrialSubscriptionForCustomer(customer.id, 'ticket-stage-active');
    console.log('[hubspot webhook] trial activation result', result);
    if (result.kind === 'error') {
      await markProcessed(eventIdStr, 'error', result.error);
    } else {
      await markProcessed(eventIdStr, 'processed', result.kind === 'skipped' ? result.reason : null);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[hubspot webhook] trial activation threw', msg);
    await markProcessed(eventIdStr, 'error', msg);
  }
}

/**
 * HubSpot's `objectTypeId` is sometimes formatted like `0-3` (deal) or `0-5`
 * (ticket). Map to a friendly name when present; fall back to a heuristic
 * based on subscriptionType (legacy events sometimes omit objectTypeId).
 */
function deriveObjectType(
  objectTypeId: string | undefined,
  subscriptionType: string,
): string {
  if (objectTypeId === '0-1') return 'contact';
  if (objectTypeId === '0-3') return 'deal';
  if (objectTypeId === '0-5') return 'ticket';
  if (objectTypeId === '0-2') return 'company';

  // Legacy fallback: subscriptionType prefixes for older webhook formats.
  if (subscriptionType.startsWith('deal.')) return 'deal';
  if (subscriptionType.startsWith('ticket.')) return 'ticket';
  if (subscriptionType.startsWith('contact.')) return 'contact';
  if (subscriptionType.startsWith('company.')) return 'company';

  return objectTypeId ?? 'unknown';
}

async function markProcessed(eventId: string, status: string, note: string | null) {
  const { eq } = await import('drizzle-orm');
  await db
    .update(hubspotInboundEvents)
    .set({
      processingStatus: status,
      processingError: status === 'error' ? note : null,
      processedAt: new Date(),
    })
    .where(eq(hubspotInboundEvents.hubspotEventId, eventId));
}
