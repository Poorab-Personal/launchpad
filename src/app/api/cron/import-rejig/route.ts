/**
 * GET /api/cron/import-rejig
 *
 * Weekly Rejig snapshot ingestion — runs Sunday 05:00 UTC via Vercel cron
 * (see vercel.json). Writes 6 fresh `customer_usage_signals` rows per Rejig
 * account, then `/api/cron/bi` fires an hour later at 06:00 UTC and reads
 * those rows.
 *
 * Auth: Bearer ${CRON_SECRET} header (Vercel cron sends this automatically
 * when the env var is configured in the Vercel project). Same auth pattern
 * as the BI cron.
 *
 * Idempotent: pre-checks (customer_id | rejig_user_id, signal_type,
 * observed_at) and skips duplicates, so manual re-runs (e.g. curl from a
 * laptop with the secret) are safe.
 *
 * Cadence rationale: see [[rejig_data_cadence]] memory — weekly avoids
 * trajectory-detection noise and mid-week CSM ticket-state churn.
 */
import type { NextRequest } from 'next/server';
import { importRejigSnapshot } from '@/lib/integrations/rejig/import';

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return Response.json(
      { error: 'CRON_SECRET not configured' },
      { status: 500 },
    );
  }
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${cronSecret}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const summary = await importRejigSnapshot({
      apply: true,
      log: (msg) => console.log(msg),
    });
    console.log('[import-rejig cron] complete', summary);
    return Response.json(summary);
  } catch (err) {
    console.error('[import-rejig cron] failed', err);
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
