/**
 * GET /api/cron/weekly
 *
 * Sunday weekly orchestrator. Sequences jobs that used to be (or could be)
 * separate crons — bundled here for cadence/audit-surface reasons, not
 * because Vercel forces it: as of the current Vercel docs (checked
 * 2026-08-05), Hobby allows up to 100 cron jobs per project; the only real
 * restriction is that a single job can't run more often than once/day.
 * (An earlier version of this comment claimed Hobby capped the job count —
 * that's stale; this repo already runs a second cron, /api/cron/daily-checks,
 * without issue.)
 *
 *   1. importRejigSnapshot()  — synchronous; writes rejig.* signals
 *   2. /api/cron/bi?offset=0  — fired via after() once 1 is committed;
 *                                the BI route auto-chains its own chunks
 *   3. /api/cron/dropoff-digest — fired via after() alongside BI. Own route
 *      (not inlined) because this handler is already close to its
 *      maxDuration budget once BI chunk-0's ~150s await is counted —
 *      see docs/plans/dropoff-reminder-cron-review.md §7.
 *
 * Order matters for 1 → 2: BI reads the `rejig.*` signals written by
 * import. Sequencing here is guaranteed because BI is only dispatched
 * after the await resolves and the response has returned. The dropoff
 * digest is independent and just rides along.
 *
 * Roster sync used to be step 2 here. On 2026-08-14 it moved back to its own
 * cron route (/api/cron/sync-roster-all, which already existed but had never
 * been registered in vercel.json): importRejigSnapshot() was eating ~170-255s
 * of the shared 300s budget before roster sync started, so the larger
 * brokerages were killed mid-sync without logging a failure. See that route's
 * header for the full post-mortem.
 *
 * Auth: Bearer ${CRON_SECRET}.
 */
import type { NextRequest } from 'next/server';
import { after } from 'next/server';
import { importRejigSnapshot } from '@/lib/integrations/rejig/import';

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return Response.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const t0 = Date.now();
  const summary: {
    importRejig: Awaited<ReturnType<typeof importRejigSnapshot>> | { error: string };
    biChainDispatched: boolean;
    dropoffDigestDispatched: boolean;
    durationMs: number;
  } = {
    importRejig: { error: 'not run' },
    biChainDispatched: false,
    dropoffDigestDispatched: false,
    durationMs: 0,
  };

  try {
    summary.importRejig = await importRejigSnapshot({
      apply: true,
      log: (msg) => console.log(`[weekly cron] ${msg}`),
    });
  } catch (err) {
    summary.importRejig = { error: err instanceof Error ? err.message : String(err) };
    console.error('[weekly cron] importRejigSnapshot failed', err);
  }

  const baseUrl = (() => {
    const fromEnv =
      process.env.VERCEL_PROJECT_PRODUCTION_URL ??
      process.env.VERCEL_URL ??
      process.env.NEXT_PUBLIC_APP_URL;
    if (fromEnv) return fromEnv.startsWith('http') ? fromEnv : `https://${fromEnv}`;
    return new URL(request.url).origin;
  })();
  const biUrl = `${baseUrl}/api/cron/bi?offset=0&limit=200`;
  const dropoffDigestUrl = `${baseUrl}/api/cron/dropoff-digest`;

  // Await the BI fetch fully inside after(). The previous 2-second race against
  // the fetch lost reliably: BI is cold (not hit between Sundays), and Vercel
  // killed the parent function before the cold-start TLS+route handshake
  // completed, so the request never landed. Awaiting keeps the runtime alive
  // until BI chunk 0 responds (~150s); BI's own after()-based chain then fires
  // chunks 1+ as independent warm invocations.
  after(async () => {
    try {
      const biRes = await fetch(biUrl, {
        method: 'GET',
        headers: { authorization: `Bearer ${cronSecret}` },
      });
      console.log('[weekly cron] BI chunk-0 returned', biRes.status, biUrl);
    } catch (err) {
      console.error('[weekly cron] BI dispatch failed', err);
    }
  });
  summary.biChainDispatched = true;

  // Independent of the BI chain — own after() so a slow/failed BI fetch
  // doesn't delay or block the B2B drop-off digest (Tracks 3/4).
  after(async () => {
    try {
      const digestRes = await fetch(dropoffDigestUrl, {
        method: 'GET',
        headers: { authorization: `Bearer ${cronSecret}` },
      });
      console.log('[weekly cron] dropoff-digest returned', digestRes.status, dropoffDigestUrl);
    } catch (err) {
      console.error('[weekly cron] dropoff-digest dispatch failed', err);
    }
  });
  summary.dropoffDigestDispatched = true;

  summary.durationMs = Date.now() - t0;
  console.log('[weekly cron] complete', summary);
  return Response.json(summary);
}
