/**
 * GET /api/cron/monthly-cohort
 *
 * Runs on the 2nd of each month (14:00 UTC = 09:00 Central during CDT) and
 * emails the PRIOR month's new B2B signups per brokerage, with a date
 * against every funnel milestone they reached. Vercel-cron scheduled in
 * vercel.json. Bearer-auth gated, same as the other cron routes.
 *
 * The 2nd rather than the 1st: month-end signups need a few hours of
 * settling (a customer who signs up at 11pm on the 31st has tasks and
 * HubSpot state landing shortly after midnight), and a monthly review isn't
 * urgent enough to want a partial picture a few hours earlier.
 *
 * Query params:
 *   ?month=YYYY-MM   report a specific month instead of last month. Useful
 *                    for re-running a past month — the report is derived,
 *                    so re-runs reproduce the same result.
 *   ?dryRun=1        compute and return JSON without sending the email.
 *
 * Unlike daily-checks, an empty cohort still sends: "no new signups last
 * month" is the answer to a monthly review, not an absence of news.
 */
import type { NextRequest } from 'next/server';
import { computeMonthlyCohort } from '@/lib/automations/monthly-cohort-digest';
import { sendMonthlyCohortDigestEmail } from '@/lib/email/send';

const DIGEST_RECIPIENTS = ['poorab@rejig.ai'];

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
  const month = url.searchParams.get('month') ?? undefined;

  let result;
  try {
    result = await computeMonthlyCohort({ month });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[monthly-cohort] compute failed', msg);
    return Response.json({ error: 'compute failed', detail: msg }, { status: 500 });
  }

  const summary = {
    month: result.month,
    totalNew: result.totalNew,
    durationMs: result.durationMs,
    byBrokerage: Object.fromEntries(
      result.cohorts.map((c) => [c.brokerageName, c.rows.length]),
    ),
    unmappedMilestones: result.unmappedMilestones,
    emailSent: false as boolean,
    dryRun,
  };

  if (dryRun) {
    console.log('[monthly-cohort] dry-run — skipping send', summary);
    return Response.json({ ...summary, cohorts: result.cohorts });
  }

  try {
    await sendMonthlyCohortDigestEmail({ to: DIGEST_RECIPIENTS, result });
    summary.emailSent = true;
    console.log('[monthly-cohort] digest sent', summary);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[monthly-cohort] digest send failed', msg);
    return Response.json({ ...summary, error: 'send failed', detail: msg }, { status: 500 });
  }

  return Response.json(summary);
}
