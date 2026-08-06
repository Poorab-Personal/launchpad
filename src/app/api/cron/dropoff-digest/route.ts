/**
 * GET /api/cron/dropoff-digest
 *
 * Tracks 3/4 of docs/plans/dropoff-reminder-cron.md — the B2B weekly
 * drop-off summary. Not on its own vercel.json schedule; dispatched via
 * after() from /api/cron/weekly (Sundays), same pattern as that route's
 * BI chain dispatch. Own route rather than inlined into weekly/route.ts
 * because that handler is already close to its maxDuration budget once
 * BI chunk-0's ~150s await is counted (see architect review §7).
 *
 * Skips send entirely when there's nothing stalled — same "quiet weeks
 * don't email" convention as daily-checks.
 *
 * Auth: Bearer ${CRON_SECRET}.
 */
import type { NextRequest } from 'next/server';
import { computeB2BDropoffDigest } from '@/lib/automations/dropoff-b2b-digest';
import { sendDropoffB2BDigestEmail } from '@/lib/email/send';

const DIGEST_TO = 'success@rejig.ai';
const DIGEST_CC = ['poorab@rejig.ai', 'matt@rejig.ai'];

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return Response.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const url = new URL(request.url);
  const dryRun = url.searchParams.get('dryRun') === '1';

  let result;
  try {
    result = await computeB2BDropoffDigest();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[dropoff-digest] computeB2BDropoffDigest failed', msg);
    return Response.json({ error: 'computeB2BDropoffDigest failed', detail: msg }, { status: 500 });
  }

  const summary = {
    durationMs: result.durationMs,
    count: result.rows.length,
    hotCount: result.rows.filter((r) => r.isHotCase).length,
    emailSent: false as boolean,
    dryRun,
  };

  if (result.rows.length === 0 && !dryRun) {
    console.log('[dropoff-digest] all clear — skipping email send');
    return Response.json(summary);
  }

  if (dryRun) {
    console.log('[dropoff-digest] dry-run mode — skipping email send', summary);
    return Response.json({ ...summary, rows: result.rows });
  }

  try {
    const digestDate = new Date().toISOString().slice(0, 10);
    await sendDropoffB2BDigestEmail({
      to: DIGEST_TO,
      cc: DIGEST_CC,
      digestDate,
      rows: result.rows,
    });
    summary.emailSent = true;
    console.log('[dropoff-digest] digest sent', summary);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[dropoff-digest] digest send failed', msg);
    return Response.json({ ...summary, error: 'digest send failed', detail: msg }, { status: 500 });
  }

  return Response.json(summary);
}
