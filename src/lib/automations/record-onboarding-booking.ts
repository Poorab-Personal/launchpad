/**
 * Record an onboarding booking captured by the LP portal directly from the
 * HubSpot Meetings embed's `meetingBookSucceeded` postMessage. This is the
 * "LP-knows-the-customer" path that solves the case where the booker types
 * a different email than the LP customer's email (e.g. a VA, or an alternate
 * persona contact). In that case HS's own "Onboarding Scheduled" workflow
 * doesn't enroll the right ticket and the existing HS webhook never fires —
 * but the portal session DOES know which LP customer is booking, so we
 * record it ourselves.
 *
 * Idempotent / race-safe with the existing HS "Onboarding Scheduled"
 * webhook handler (src/app/api/webhooks/hubspot/route.ts):
 *   - Task completion: `handleTaskCompleted` early-returns if not Active
 *   - Calls row: `calls.hubspotMeetingId` is UNIQUE — duplicate inserts fail
 *     gracefully
 *   - callDate: same value written twice is a no-op
 *   - Meeting↔Ticket association: `ensureMeetingTicketAssociation` swallows
 *     the HS 409 "already exists"
 *
 * What postMessage gives us (booker email/name + YYYY-MM-DD dateString) is
 * not enough on its own — HubSpot's payload does not include the meeting
 * engagement ID or the exact start time. We round-trip to HS to find the
 * just-booked meeting on the booker's contact and read those off.
 *
 * Failure modes that alert the ops inbox:
 *   - HS contact-by-email lookup returns null (booker email not yet indexed)
 *   - No recent meeting found on the contact (HS engagement indexing lag)
 *   - HS API throws
 * Task still gets marked Complete in all cases — booking did happen from
 * the user's perspective; the gap is only in the LP-side bookkeeping, which
 * an operator can reconcile manually from the alert email.
 */
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import * as schema from '@/db/schema';
import {
  applyStateTransition,
  createCall,
  getCallByHubspotMeetingId,
  updateCall,
  updateCustomerFields,
  updateTaskFields,
} from '@/lib/db';
import {
  ensureMeetingTicketAssociation,
  findRecentMeetingByContactEmail,
} from '@/lib/integrations/hubspot/client';
import { sendAlertEmail } from '@/lib/email/send';

const HUBSPOT_PORTAL_ID = '44956899';

export interface OnboardingBookingPayload {
  customerId: string;
  taskId: string;
  bookerEmail: string;
  bookerFirstName?: string | null;
  bookerLastName?: string | null;
  /** YYYY-MM-DD from HS postMessage. Informational only — actual startTime comes from HS API. */
  dateString?: string | null;
}

export async function recordOnboardingBooking(
  payload: OnboardingBookingPayload,
): Promise<{ ok: boolean; reason?: string }> {
  const { customerId, taskId, bookerEmail } = payload;

  const customer = await db.query.customers.findFirst({
    where: eq(schema.customers.id, customerId),
  });
  if (!customer) {
    return { ok: false, reason: 'customer-not-found' };
  }

  // ── 1. Mark Schedule task Completed. Idempotent: handleTaskCompleted
  //       early-returns if not Active, so safe to race with HS webhook.
  try {
    await updateTaskFields(taskId, {
      status: 'Completed',
      completedAt: new Date(),
    });
  } catch (err) {
    console.error(
      '[record-onboarding-booking] task complete failed',
      err instanceof Error ? err.message : String(err),
    );
    // Don't return — try the meeting capture anyway. Worst case the task
    // is still Active and the HS webhook (or a manual retry) finishes it.
  }

  // ── 2. Find the booked meeting on the booker's HS contact. ────────────
  let meeting: { meetingId: string; startTime: string; title: string | null; contactId: string } | null = null;
  try {
    meeting = await findRecentMeetingByContactEmail(bookerEmail);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[record-onboarding-booking] HS meeting lookup threw', msg);
    await alertFailure({
      customer,
      bookerEmail,
      payload,
      reason: `HS meeting lookup threw: ${msg}`,
    });
    return { ok: false, reason: 'hs-lookup-threw' };
  }
  if (!meeting) {
    console.warn(
      '[record-onboarding-booking] no recent meeting found on booker contact',
      { bookerEmail, customerId },
    );
    await alertFailure({
      customer,
      bookerEmail,
      payload,
      reason:
        'No recent meeting found on the booker\'s HubSpot contact. Possible causes: contact not yet indexed, meeting not yet associated, or wrong email.',
    });
    return { ok: false, reason: 'no-meeting-found' };
  }

  // ── 3. Upsert the call row (UNIQUE on hubspotMeetingId). ──────────────
  try {
    const existing = await getCallByHubspotMeetingId(meeting.meetingId);
    if (existing) {
      await updateCall(existing.id, {
        scheduledDate: meeting.startTime,
        status: 'Scheduled',
      });
    } else {
      await createCall({
        title: `Onboarding — ${customer.name}`,
        customer: [customer.id],
        type: 'Onboarding',
        scheduledDate: meeting.startTime,
        status: 'Scheduled',
        hubspotMeetingId: meeting.meetingId,
        notes: 'Created from LP portal onboarding-booked endpoint.',
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[record-onboarding-booking] calls upsert failed', msg);
    await alertFailure({ customer, bookerEmail, payload, reason: `Calls upsert failed: ${msg}`, meeting });
    return { ok: false, reason: 'calls-upsert-failed' };
  }

  // ── 4. Stamp customer flags. ──────────────────────────────────────────
  try {
    await updateCustomerFields(customer.id, {
      callBooked: true,
      callDate: new Date(meeting.startTime),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[record-onboarding-booking] customer field update failed', msg);
    await alertFailure({ customer, bookerEmail, payload, reason: `Customer update failed: ${msg}`, meeting });
    // Don't return — association still worth attempting.
  }

  // ── 5. Associate Meeting ↔ Ticket in HS so CSMs see the meeting on the
  //       ticket card. HS Meetings only auto-associates to Contacts. 409 is
  //       treated as success by the helper.
  if (customer.hubspotTicketId) {
    try {
      await ensureMeetingTicketAssociation(meeting.meetingId, customer.hubspotTicketId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        '[record-onboarding-booking] meeting↔ticket association failed',
        msg,
      );
      await alertFailure({ customer, bookerEmail, payload, reason: `Meeting↔Ticket association failed: ${msg}`, meeting });
      // Non-blocking — call row + callDate are already written.
    }
  }

  // ── 6. Advance the HS ticket stage to "Onboarding Scheduled". The HS-side
  //       workflow "CSM Meeting Onboarding Created via LaunchPad" tries to
  //       do this, but only enrolls cleanly on first-time meeting bookings
  //       for the contact (re-enrollment quirks bite repeat bookers). LP
  //       drives the transition canonically here — applyStateTransition
  //       does an atomic LP onboardingState update + transition-log row +
  //       best-effort HS push, with idempotent no-op detection if the stage
  //       is already there (e.g. HS workflow beat us). The webhook that
  //       comes back from the HS push is caught by the LP-own-write loop
  //       prevention.
  try {
    await applyStateTransition({
      customerId: customer.id,
      toState: 'Onboarding Scheduled',
      attentionReason: null,
      changeSource: 'lp_portal',
      sourceDetail: 'onboarding-booked',
      payload: {
        hubspotMeetingId: meeting.meetingId,
        bookerEmail,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[record-onboarding-booking] state transition failed (non-blocking)', msg);
    await alertFailure({ customer, bookerEmail, payload, reason: `Ticket stage advance failed: ${msg}`, meeting });
  }

  console.log('[record-onboarding-booking] success', {
    customerId: customer.id,
    bookerEmail,
    meetingId: meeting.meetingId,
    startTime: meeting.startTime,
  });
  return { ok: true };
}

async function alertFailure(args: {
  customer: typeof schema.customers.$inferSelect;
  bookerEmail: string;
  payload: OnboardingBookingPayload;
  reason: string;
  meeting?: { meetingId: string; startTime: string } | null;
}): Promise<void> {
  const { customer, bookerEmail, payload, reason, meeting } = args;
  try {
    await sendAlertEmail({
      to: process.env.ALERTS_EMAIL ?? 'poorab@rejig.ai',
      subject: `[LaunchPad] Onboarding booking captured but bookkeeping incomplete for ${customer.name}`,
      text:
        `The customer's portal reported a successful booking, but follow-up writes failed.\n\n` +
        `Reason: ${reason}\n\n` +
        `Customer: ${customer.name} (${customer.id})\n` +
        `Customer email: ${customer.contactEmail ?? '(none)'}\n` +
        `Booker email (typed in HS Meetings form): ${bookerEmail}\n` +
        `Booker name: ${[payload.bookerFirstName, payload.bookerLastName].filter(Boolean).join(' ') || '(none)'}\n` +
        `Date (postMessage): ${payload.dateString ?? '(none)'}\n` +
        (meeting
          ? `\nHS Meeting found:\n  meetingId: ${meeting.meetingId}\n  startTime: ${meeting.startTime}\n`
          : '\nHS Meeting: not found via booker email lookup.\n') +
        (customer.hubspotTicketId
          ? `\nHS Ticket: https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-5/${customer.hubspotTicketId}\n`
          : '\nHS Ticket: (none on customer)\n') +
        `\nLP customer: ${process.env.NEXT_PUBLIC_APP_URL ?? ''}/workspace/customers/${customer.id}\n`,
    });
  } catch (mailErr) {
    console.error(
      '[record-onboarding-booking] alert email failed',
      mailErr instanceof Error ? mailErr.message : String(mailErr),
    );
  }
}
