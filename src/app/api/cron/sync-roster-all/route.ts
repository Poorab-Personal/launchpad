/**
 * GET /api/cron/sync-roster-all
 *
 * Weekly roster sync cron — runs Sunday 10:00 UTC via Vercel cron (see
 * vercel.json). Fans out to every active brokerage via `runAllActiveSyncs()`
 * (Promise.allSettled inside) so one source outage never blocks another.
 *
 * Auth: Bearer ${CRON_SECRET} header (Vercel cron sends this automatically
 * when the env var is configured in the Vercel project). The Authorization
 * check is the LITERAL first line of the handler — without it, anyone can
 * DoS the DMG API by hitting this endpoint.
 *
 * On any per-brokerage failure, a Resend alert is sent to ALERTS_EMAIL
 * (fallback: poorab@rejig.ai). The handler ALWAYS returns 200 with a JSON
 * summary — even on partial failure — so Vercel cron doesn't auto-retry.
 * If freshness becomes urgent, add an /api/cron/sync-roster-now manual
 * trigger.
 *
 * Per docs/integrations/dmg-roster-plan.md §4.1 (sync flow), §6.2 (cron
 * auth), §6.3 (Resend alert).
 */
import { runAllActiveSyncs, type SyncSummary } from '@/lib/roster/sync';
import { sendAlertEmail } from '@/lib/email/send';

type CronResponse = {
  status: 'ok' | 'partial' | 'failed';
  summary: SyncSummary;
};

export async function GET(request: Request) {
  if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  console.log('[roster sync cron] start');

  const summary = await runAllActiveSyncs();
  const { results, failures } = summary;

  // Status: 'ok' if no failures; 'failed' if every brokerage failed;
  // 'partial' if at least one succeeded and at least one failed.
  let status: CronResponse['status'];
  if (failures.length === 0) {
    status = 'ok';
  } else if (results.length === 0) {
    status = 'failed';
  } else {
    status = 'partial';
  }

  // Fire Resend alert on any failure. Best-effort — don't let an email
  // outage flip the cron response or cause a Vercel retry. Fallback recipient
  // is a literal so the cron remains operational even if ALERTS_EMAIL is
  // unset in env.
  if (failures.length > 0) {
    const failedBrokerages = failures.map((f) => f.brokerageSlug);
    const errorList = failures
      .map((f) => `[${f.brokerageSlug} / ${f.sourceType}]\n${f.error}`)
      .join('\n\n');

    try {
      await sendAlertEmail({
        to: process.env.ALERTS_EMAIL ?? 'poorab@rejig.ai',
        subject: `[LaunchPad] Roster sync ${failedBrokerages.join(', ')} failed`,
        text: `Failed brokerages: ${failedBrokerages.join(', ')}\n\nErrors:\n${errorList}`,
      });
    } catch (err) {
      console.error(
        '[roster sync cron] alert email failed (continuing with 200 response)',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  console.log('[roster sync cron] complete', {
    status,
    succeeded: results.length,
    failed: failures.length,
  });

  const body: CronResponse = { status, summary };
  return Response.json(body);
}
