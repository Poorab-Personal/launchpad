/**
 * GET /api/cron/weekly
 *
 * Sunday weekly orchestrator — the SINGLE Vercel cron entry on the
 * Hobby plan (Hobby caps the number of active cron jobs and silently
 * drops extras). Sequences three jobs that used to be separate crons:
 *
 *   1. importRejigSnapshot()  — synchronous; writes rejig.* signals
 *   2. runAllActiveSyncs()    — synchronous; refreshes brokerage rosters
 *   3. /api/cron/bi?offset=0  — fired via after() once 1+2 are committed;
 *                                the BI route auto-chains its own chunks
 *
 * Order matters for 1 → 3: BI reads the `rejig.*` signals written by
 * import. Sequencing here is guaranteed because BI is only dispatched
 * after both awaits resolve and the response has returned. Roster sync
 * is fully independent and just rides along.
 *
 * Auth: Bearer ${CRON_SECRET}.
 */
import type { NextRequest } from 'next/server';
import { after } from 'next/server';
import { importRejigSnapshot } from '@/lib/integrations/rejig/import';
import { runAllActiveSyncs } from '@/lib/roster/sync';

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
    rosterSync: Awaited<ReturnType<typeof runAllActiveSyncs>> | { error: string };
    biChainDispatched: boolean;
    durationMs: number;
  } = {
    importRejig: { error: 'not run' },
    rosterSync: { error: 'not run' },
    biChainDispatched: false,
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

  try {
    summary.rosterSync = await runAllActiveSyncs();
  } catch (err) {
    summary.rosterSync = { error: err instanceof Error ? err.message : String(err) };
    console.error('[weekly cron] runAllActiveSyncs failed', err);
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

  summary.durationMs = Date.now() - t0;
  console.log('[weekly cron] complete', summary);
  return Response.json(summary);
}
