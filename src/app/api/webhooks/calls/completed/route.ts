import { NextRequest } from 'next/server';
import { handleCallCompleted } from '@/lib/automations/handle-call-completed';

/**
 * POST /api/webhooks/calls/completed
 * body: { recordId: string }
 * headers: Authorization: Bearer ${AIRTABLE_WEBHOOK_SECRET}
 *
 * Legacy entry point for Airtable Auto 8 — the automation still POSTs here
 * during the cutover window. Post-cutover (Phase 7), the Airtable trigger
 * retires and this route can be deleted too; updateCall() in src/lib/db.ts
 * already calls handleCallCompleted directly when call.status transitions
 * to Completed for an Onboarding call.
 */
export async function POST(request: NextRequest) {
  const expectedSecret = process.env.AIRTABLE_WEBHOOK_SECRET;
  if (!expectedSecret) {
    console.error('[calls/completed] AIRTABLE_WEBHOOK_SECRET not set in env');
    return Response.json({ error: 'Webhook not configured' }, { status: 500 });
  }
  const authHeader = request.headers.get('authorization') ?? '';
  if (authHeader !== `Bearer ${expectedSecret}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const recordId = body?.recordId as string | undefined;
  if (!recordId) {
    return Response.json({ error: 'recordId is required' }, { status: 400 });
  }

  const result = await handleCallCompleted(recordId);

  switch (result.kind) {
    case 'created':
      return Response.json({
        ok: true,
        stripeSubscriptionId: result.subscriptionId,
        status: result.status,
        trialEnd: result.trialEnd,
      });
    case 'skipped':
      return Response.json({ skipped: true, reason: result.reason });
    case 'error':
      return Response.json({ error: result.error }, { status: result.status ?? 500 });
  }
}
