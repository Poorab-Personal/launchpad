import { NextRequest } from 'next/server';
import { getRecords, updateRecord } from '@/lib/airtable-client';
import {
  createCall,
  getCallByCalendlyUuid,
  getTeamMemberByEmail,
  updateCall,
} from '@/lib/airtable';
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
  const safeEmail = customerEmail.replace(/'/g, "\\'");
  const customers = await getRecords('Customers', {
    filterByFormula: `LOWER({Contact Email}) = LOWER('${safeEmail}')`,
    maxRecords: 1,
  });
  if (customers.length === 0) {
    return Response.json({ error: 'Customer not found', email: customerEmail }, { status: 404 });
  }
  const custId = customers[0].id;

  // ── Find the matching active Schedule task ────────────────────────
  // We look through all tasks for one belonging to this customer whose
  // name is one of the recognized schedule task names AND status=Active.
  // (Same in-memory pattern the original webhook used — Airtable can't
  // filter linked-record arrays well via formula.)
  const allTasks = await getRecords('Tasks');
  const scheduleTask = allTasks.find((t) => {
    const linked = t.fields['Customer'];
    const isCustomer = Array.isArray(linked) && JSON.stringify(linked).includes(custId);
    const name = (t.fields['Task Name'] as string) ?? '';
    const status =
      typeof t.fields['Status'] === 'object'
        ? (t.fields['Status'] as { name: string }).name
        : t.fields['Status'];
    return isCustomer && status === 'Active' && SCHEDULE_TASK_TO_TYPE[name] !== undefined;
  });

  // ── Determine call type ───────────────────────────────────────────
  let callType: CallType;
  if (explicitCallType) {
    callType = explicitCallType;
  } else if (scheduleTask) {
    const name = (scheduleTask.fields['Task Name'] as string) ?? '';
    callType = SCHEDULE_TASK_TO_TYPE[name] ?? 'Ad-hoc';
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
    title: `${callType} — ${(customers[0].fields['Name'] as string) ?? ''}`.trim(),
    customer: [custId],
    type: callType,
    scheduledDate: eventDate || undefined,
    status: 'Scheduled' as const,
    calendlyEventUuid: calendlyEventUuid || undefined,
    notes: 'Created from Calendly webhook.',
    ...(csmMemberId ? { csm: [csmMemberId] } : {}),
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
    await updateRecord('Tasks', scheduleTask.id, {
      Status: 'Completed',
      'Completed At': new Date().toISOString(),
    });
  }

  // ── Backwards-compat customer flags (Onboarding only) ─────────────
  // Existing portal/components read Customer.Call Date + Call Booked.
  // Don't touch these for Check-Ins so they don't clobber prior values.
  const customerUpdate: Record<string, unknown> = {};
  if (callType === 'Onboarding') {
    customerUpdate['Call Booked'] = true;
    if (eventDate) customerUpdate['Call Date'] = eventDate;
    if (csmMemberId) customerUpdate['CSM Assigned'] = [csmMemberId];
  }
  if (Object.keys(customerUpdate).length > 0) {
    await updateRecord('Customers', custId, customerUpdate);
  }

  // ── Re-route "Mark Onboarding Call Complete" to the booking host ──
  // Auto 1 assigned this task to the default CSM at customer-creation time.
  // The actual host (round-robin pick or direct booking) may differ — make
  // sure the task lands in their queue, not the default CSM's. Skip if the
  // task is already Completed (don't rewrite history).
  if (callType === 'Onboarding' && csmMemberId) {
    const markTask = allTasks.find((t) => {
      const linked = t.fields['Customer'];
      const isCustomer = Array.isArray(linked) && JSON.stringify(linked).includes(custId);
      const name = (t.fields['Task Name'] as string) ?? '';
      const status =
        typeof t.fields['Status'] === 'object'
          ? (t.fields['Status'] as { name: string }).name
          : t.fields['Status'];
      return isCustomer && name === 'Mark Onboarding Call Complete' && status !== 'Completed';
    });
    if (markTask) {
      await updateRecord('Tasks', markTask.id, {
        'Assigned To': [csmMemberId],
      });
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
