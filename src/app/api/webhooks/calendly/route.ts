import { NextRequest } from 'next/server';
import {
  createCall,
  getCallByCalendlyUuid,
  getCustomerByEmail,
  getTasksForCustomer,
  getTeamMemberByEmail,
  updateCall,
  updateCustomerFields,
  updateTaskFields,
} from '@/lib/db';
import type { CallType } from '@/types';

/**
 * Calendly Webhook — backend confirmation for bookings.
 *
 * Called by Calendly's webhook system when an event is scheduled.
 * Portal's postMessage listener handles instant UI feedback; this is the
 * reliable backend confirmation.
 *
 * What it does:
 *   1. Resolves the customer (by email).
 *   2. Determines call type (Onboarding / Check-In 1 / Check-In 2):
 *      - explicit `callType` in simplified payload, OR
 *      - inferred from the active task name on the customer.
 *   3. Upserts a Calls row keyed by Calendly Event UUID (idempotent).
 *   4. For Onboarding type: looks up the Calendly assignee (CSM by email)
 *      and writes Customer.CSM Assigned + Call.CSM.
 *   5. Marks the matching Schedule task Completed.
 *   6. Backwards compat: also stamps Customer.Call Booked + Call Date for
 *      Onboarding only (existing portal code reads these).
 *
 * Native Calendly payload (event = "invitee.created"):
 *   payload.invitee.email
 *   payload.event.start_time
 *   payload.event.uri              ← https://api.calendly.com/scheduled_events/{UUID}
 *   payload.event.event_memberships[0].user_email   ← assignee (CSM)
 *
 * Simplified payload (Zapier or test):
 *   { customerEmail, eventDate, callType?, assigneeEmail?, calendlyEventUuid? }
 */

const SCHEDULE_TASK_TO_TYPE: Record<string, CallType> = {
  'Schedule Your Onboarding Call': 'Onboarding',
  'Reschedule Your Onboarding Call': 'Onboarding',
  'Schedule Check-In 1': 'Check-In 1',
  'Schedule Check-In 2': 'Check-In 2',
};

/** Extract last URL path segment from a Calendly event URI. */
function uuidFromCalendlyUri(uri?: string): string {
  if (!uri || typeof uri !== 'string') return '';
  const trimmed = uri.replace(/\/+$/, '');
  const last = trimmed.split('/').pop() ?? '';
  return last;
}

export async function POST(request: NextRequest) {
  const body = await request.json();

  // ── Parse payload (native Calendly OR simplified) ─────────────────
  let customerEmail = '';
  let eventDate = '';
  let calendlyEventUuid = '';
  let assigneeEmail = '';
  let explicitCallType: CallType | '' = '';

  if (body.event === 'invitee.created' && body.payload) {
    customerEmail = body.payload.invitee?.email ?? '';
    eventDate = body.payload.event?.start_time ?? '';
    calendlyEventUuid = uuidFromCalendlyUri(body.payload.event?.uri);
    const memberships = body.payload.event?.event_memberships;
    if (Array.isArray(memberships) && memberships.length > 0) {
      assigneeEmail = memberships[0]?.user_email ?? '';
    }
  } else {
    customerEmail = body.customerEmail ?? '';
    eventDate = body.eventDate ?? '';
    calendlyEventUuid = body.calendlyEventUuid ?? '';
    assigneeEmail = body.assigneeEmail ?? '';
    if (body.callType && typeof body.callType === 'string') {
      const t = body.callType as string;
      if (t === 'Onboarding' || t === 'Check-In 1' || t === 'Check-In 2' || t === 'Ad-hoc') {
        explicitCallType = t;
      }
    }
  }

  if (!customerEmail) {
    return Response.json({ error: 'No customer email found' }, { status: 400 });
  }

  // ── Resolve customer ──────────────────────────────────────────────
  const customer = await getCustomerByEmail(customerEmail);
  if (!customer) {
    return Response.json({ error: 'Customer not found', email: customerEmail }, { status: 404 });
  }
  const custId = customer.id;

  // ── Find the matching active Schedule task ────────────────────────
  const customerTasks = await getTasksForCustomer(custId);
  const scheduleTask = customerTasks.find(
    (t) => t.status === 'Active' && SCHEDULE_TASK_TO_TYPE[t.taskName] !== undefined,
  );

  // ── Determine call type ───────────────────────────────────────────
  let callType: CallType;
  if (explicitCallType) {
    callType = explicitCallType;
  } else if (scheduleTask) {
    callType = SCHEDULE_TASK_TO_TYPE[scheduleTask.taskName] ?? 'Ad-hoc';
  } else {
    callType = 'Ad-hoc';
  }

  // ── Resolve CSM (only for Onboarding, only if assignee provided) ──
  let csmMemberId: string | null = null;
  if (callType === 'Onboarding' && assigneeEmail) {
    const member = await getTeamMemberByEmail(assigneeEmail);
    if (member) csmMemberId = member.id;
  }

  // ── Upsert the Call row (idempotent on Calendly Event UUID) ───────
  let callId: string;
  let callAction: 'created' | 'updated' | 'created-no-uuid';

  const callFields = {
    title: `${callType} — ${customer.name}`.trim(),
    customer: [custId],
    type: callType,
    scheduledDate: eventDate || undefined,
    status: 'Scheduled' as const,
    calendlyEventUuid: calendlyEventUuid || undefined,
    notes: 'Created from Calendly webhook.',
    csm: csmMemberId ? [csmMemberId] : [],
  };

  if (calendlyEventUuid) {
    const existing = await getCallByCalendlyUuid(calendlyEventUuid);
    if (existing) {
      // On update, don't overwrite Notes (CSM may have edited them) and
      // don't downgrade Status if it's already past Scheduled. Just refresh
      // scheduledDate, type, customer, csm.
      const updateFields: Parameters<typeof updateCall>[1] = {
        customer: [custId],
        type: callType,
      };
      if (eventDate) updateFields.scheduledDate = eventDate;
      if (csmMemberId) updateFields.csm = [csmMemberId];
      const updated = await updateCall(existing.id, updateFields);
      callId = updated.id;
      callAction = 'updated';
    } else {
      const created = await createCall(callFields);
      callId = created.id;
      callAction = 'created';
    }
  } else {
    const created = await createCall(callFields);
    callId = created.id;
    callAction = 'created-no-uuid';
  }

  // ── Mark Schedule task Completed ──────────────────────────────────
  if (scheduleTask) {
    await updateTaskFields(scheduleTask.id, {
      status: 'Completed',
      completedAt: new Date(),
    });
  }

  // ── Backwards-compat customer flags (Onboarding only) ─────────────
  if (callType === 'Onboarding') {
    const update: Parameters<typeof updateCustomerFields>[1] = {
      callBooked: true,
    };
    if (eventDate) update.callDate = new Date(eventDate);
    if (csmMemberId) update.csmTeamMemberId = csmMemberId;
    await updateCustomerFields(custId, update);
  }

  // ── Re-route "Mark Onboarding Call Complete" to the booking host ──
  if (callType === 'Onboarding' && csmMemberId) {
    const markTask = customerTasks.find(
      (t) => t.taskName === 'Mark Onboarding Call Complete' && t.status !== 'Completed',
    );
    if (markTask) {
      await updateTaskFields(markTask.id, { assignedToTeamMemberId: csmMemberId });
    }
  }

  return Response.json({
    ok: true,
    customerId: custId,
    callId,
    callAction,
    callType,
    csmAssigned: csmMemberId,
    scheduledDate: eventDate || null,
    taskCompleted: scheduleTask?.id ?? null,
    calendlyEventUuid: calendlyEventUuid || null,
  });
}
