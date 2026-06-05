import { NextRequest } from 'next/server';
import { recordOnboardingBooking } from '@/lib/automations/record-onboarding-booking';

/**
 * POST /api/customers/[id]/onboarding-booked
 *
 * Called by the LP portal when the HubSpot Meetings embed fires its
 * `meetingBookSucceeded` postMessage. The portal already knows the LP
 * customer (URL has its accessToken), so we trust that and route the
 * booking-side work (calls row, callDate, Meeting↔Ticket association)
 * through `recordOnboardingBooking`.
 *
 * See src/lib/automations/record-onboarding-booking.ts for the full rationale
 * and idempotency story. The existing HS "Onboarding Scheduled" webhook
 * stays as a parallel path for matching-email bookings — both paths are
 * idempotent via the calls.hubspot_meeting_id UNIQUE constraint and the
 * meeting↔ticket association's 409-on-duplicate behavior.
 *
 * Auth: matches the surface of /api/tasks/[taskId] (the existing portal
 * task-completion endpoint) — no token check, relies on non-guessable UUIDs
 * in customerId + taskId. Tighten in a separate pass if needed.
 *
 * Always returns 200 to the portal — task is marked Complete optimistically
 * even when the HS round-trip fails, and an ops alert fires for any partial
 * failure. The booking happened from the customer's perspective; we don't
 * want the UI to scare them if our bookkeeping is incomplete.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: customerId } = await params;
  const body = await request.json().catch(() => null);

  const taskId = body?.taskId as string | undefined;
  const bookerEmail = body?.bookerEmail as string | undefined;
  if (!taskId || !bookerEmail) {
    return Response.json({ error: 'taskId and bookerEmail are required' }, { status: 400 });
  }

  const result = await recordOnboardingBooking({
    customerId,
    taskId,
    bookerEmail,
    bookerFirstName: body?.bookerFirstName ?? null,
    bookerLastName: body?.bookerLastName ?? null,
    dateString: body?.dateString ?? null,
  });

  return Response.json(result);
}
