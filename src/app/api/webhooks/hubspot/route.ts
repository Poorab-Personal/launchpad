import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { customers } from '@/db/schema/customers';
import { customerStateTransitions } from '@/db/schema/customerStateTransitions';
import { hubspotInboundEvents } from '@/db/schema/hubspotInboundEvents';
import { tasks } from '@/db/schema/tasks';
import { updateTaskFields } from '@/lib/db';
import { processDealClosedWon } from '@/lib/integrations/hubspot/closedwon-handler';
import { getStageLabelById } from '@/lib/integrations/hubspot/client';
import { createTrialSubscriptionForCustomer } from '@/lib/automations/handle-call-completed';

/**
 * Our HubSpot App ID. Set when LaunchPad makes API calls — HubSpot stamps
 * INTEGRATION events with sourceId=this value so we can distinguish OUR
 * writes from other integrations' writes for loop prevention.
 *
 * Discovered from production webhook traffic (sourceId in raw_payload).
 * If we ever rotate the HubSpot app, update here.
 */
const LP_HUBSPOT_APP_ID = '39386685';

/**
 * Map a HubSpot webhook `changeSource` value onto our locked `change_source`
 * vocabulary for customer_state_transitions. Phase 3 of the post-launch
 * migration — see docs/plans/post-launch-migration.md scrutiny point 5.
 *
 * HubSpot's actual changeSource values (verified from production webhooks
 * 2026-05-14):
 *   AUTOMATION_PLATFORM   — HubSpot Workflow fired the change (Workflow A/F/etc)
 *   CRM_UI                — a HubSpot user changed it manually (CSM in kanban)
 *   INTEGRATION           — an API call from a connected app set it. sourceId
 *                           identifies which app. If our app ID, it's an LP
 *                           write coming back (loop prevention case — caller
 *                           filters before mapping). If another integration,
 *                           land it as hubspot_api_other.
 *   IMPORT / CALCULATED   — other rare cases; bucket as hubspot_api_other
 */
function mapHubspotChangeSource(hubspotSource: string | undefined): string {
  switch (hubspotSource) {
    case 'AUTOMATION_PLATFORM':
      return 'hubspot_workflow';
    case 'CRM_UI':
      return 'hubspot_csm_ui';
    case 'INTEGRATION':
    case 'IMPORT':
    case 'CALCULATED':
    default:
      // Catch-all for anything not Workflows/CSM. Other integrations or
      // HubSpot-internal sources land here. Stored so we can audit later
      // via the change_source index.
      return 'hubspot_api_other';
  }
}

/**
 * Should we filter this event as LP's own write coming back?
 *
 * LP makes API calls to HubSpot via the @hubspot/api-client SDK (e.g.
 * createCustomerJourneyTicket, pushTicketStage, updateContactProperties).
 * HubSpot emits webhook events for those property changes with
 * changeSource=INTEGRATION + sourceId=our-app-id. Without filtering, we'd
 * log them as if HubSpot did them, causing double-logging + wrong
 * change_source attribution.
 *
 * Phase 4+ LP-side writers will own their own transition logging with
 * proper change_source (lp_auto2 / lp_bi / lp_admin), so filtering the
 * webhook echo is the right call.
 */
function isLPOwnWrite(event: HubSpotWebhookEvent): boolean {
  return event.changeSource === 'INTEGRATION' && event.sourceId === LP_HUBSPOT_APP_ID;
}

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
 * Ticket pipeline-stage change handler. Two responsibilities:
 *
 *   1. Phase 3 bi-directional sync — log the transition into
 *      customer_state_transitions + update customers.onboardingState mirror.
 *      Runs for EVERY non-API_CHANGE stage move regardless of target stage.
 *      Source of truth for LP's view of post-launch state.
 *
 *   2. B2B trial activation (belt A) — for the specific case of stage → Active
 *      on a setup-intent-at-intake workflow (B2B-Keyes today), fire the trial
 *      subscription creation. This runs AFTER the transition is logged.
 *
 * Loop prevention: API_CHANGE events are LP's own writes coming back to us
 * (e.g. Auto 2 pushes ticket to Onboarding Scheduled via createCustomerJourneyTicket
 * or pushTicketStage). Those don't get logged via this path — LP-side writers
 * are responsible for their own transition logging via applyStateTransition()
 * (Phase 4 helper) so the change_source reflects the real LP origin (lp_auto2 /
 * lp_bi / lp_admin) instead of a generic API_CHANGE.
 */
async function processTicketStageChange(eventIdStr: string, event: HubSpotWebhookEvent) {
  // ─── Loop prevention ───────────────────────────────────────────────────
  // LP's own API writes come back as INTEGRATION events with sourceId set
  // to our HubSpot app ID. Skip — the LP-side writer will log the transition
  // explicitly with proper change_source (lp_auto2 / lp_bi / lp_admin).
  if (isLPOwnWrite(event)) {
    await markProcessed(eventIdStr, 'ignored', `LP own write (INTEGRATION + sourceId=${LP_HUBSPOT_APP_ID}) — loop prevention`);
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

  if (!stageLabel) {
    await markProcessed(eventIdStr, 'error', `unknown HubSpot stage ID ${event.propertyValue}`);
    return;
  }

  // ─── Find the LP customer ──────────────────────────────────────────────
  const ticketId = String(event.objectId);
  const customer = await db.query.customers.findFirst({
    where: eq(customers.hubspotTicketId, ticketId),
    columns: {
      id: true,
      workflowKey: true,
      stripeSubscriptionId: true,
      onboardingState: true,
    },
  });

  if (!customer) {
    // Ticket exists in HS but not in LP. Common case: pre-Phase-1.5.5 tickets
    // backfilled into HS only, or third-party tickets not from LP. Log + skip.
    await markProcessed(eventIdStr, 'ignored', `no LP customer for ticket ${ticketId}`);
    return;
  }

  // Skip no-op transitions (e.g. LP just seeded onboardingState='Pre-Onboarding'
  // and HubSpot's webhook echoes back the same value from the ticket-create
  // API call — handled above by the LP-own-write filter, but defense-in-depth
  // for other no-op cases).
  if (customer.onboardingState === stageLabel) {
    await markProcessed(eventIdStr, 'ignored', `no-op transition (${stageLabel} → ${stageLabel})`);
    return;
  }

  // ─── Log the transition + update mirror (atomic) ───────────────────────
  const changeSource = mapHubspotChangeSource(event.changeSource);
  try {
    await db.transaction(async (tx) => {
      await tx.insert(customerStateTransitions).values({
        customerId: customer.id,
        fromState: customer.onboardingState,           // null on initial entry — OK
        toState: stageLabel,
        changeSource,
        sourceDetail: event.sourceId ?? null,          // HubSpot user/app id that drove the change
        changedAt: new Date(event.occurredAt),
        rawHubspotEventId: eventIdStr,
        payload: { hubspotTicketId: ticketId, hubspotChangeSourceRaw: event.changeSource },
      });
      await tx
        .update(customers)
        .set({ onboardingState: stageLabel })
        .where(eq(customers.id, customer.id));
    });
    console.log('[hubspot webhook] stage transition logged', {
      customerId: customer.id,
      from: customer.onboardingState,
      to: stageLabel,
      changeSource,
    });
  } catch (err) {
    // If the local log/update fails, halt — don't run trial activation
    // against an unrecorded transition. HubSpot retry will re-deliver.
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[hubspot webhook] transition log failed', msg);
    await markProcessed(eventIdStr, 'error', `transition log failed: ${msg}`);
    return;
  }

  // ─── LP Schedule-task auto-complete (belt C) — on stage → Onboarding Scheduled ──
  // The HS Workflow "CSM Meeting Onboarding Created via LaunchPad" moves the
  // ticket to Onboarding Scheduled when the customer books a meeting via the
  // embedded HS Meetings scheduler. Mirror that into LP by completing the
  // Active Schedule task — routes through updateTaskFields → handleTaskCompleted
  // so dependents activate and the LP customer state advances. Idempotent:
  // handleTaskCompleted early-returns if the task isn't Active.
  if (stageLabel === 'Onboarding Scheduled') {
    const scheduleTask = await db.query.tasks.findFirst({
      where: and(
        eq(tasks.customerId, customer.id),
        eq(tasks.status, 'Active'),
        inArray(tasks.taskName, [
          'Schedule Your Onboarding Call',
          'Reschedule Your Onboarding Call',
        ]),
      ),
    });
    if (scheduleTask) {
      try {
        await updateTaskFields(scheduleTask.id, {
          status: 'Completed',
          completedAt: new Date(),
        });
        console.log('[hubspot webhook] auto-completed LP Schedule task', {
          taskId: scheduleTask.id,
          taskName: scheduleTask.taskName,
          customerId: customer.id,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[hubspot webhook] auto-complete Schedule task failed (non-blocking)', msg);
      }
    } else {
      console.log('[hubspot webhook] no Active Schedule task to auto-complete', {
        customerId: customer.id,
      });
    }
  }

  // ─── B2B trial activation (belt A) — only on stage → Active ────────────
  if (stageLabel !== 'Active') {
    await markProcessed(eventIdStr, 'processed', null);
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
