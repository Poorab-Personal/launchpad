/**
 * GET /api/cron/daily-checks
 *
 * Daily B2B-onboarding gap detection. Runs every morning (16:00 UTC =
 * 09:00 PT during PDT, 08:00 PT during PST). Vercel-cron scheduled in
 * vercel.json. Bearer-auth gated.
 *
 * Two sections covered (see src/lib/automations/daily-checks.ts):
 *   1. LP has a Stripe sub but Rejig doesn't (or has a different one).
 *   2. B2B customers stuck in 'Onboarding Scheduled' past their callDate
 *      — the CSM didn't mark the meeting outcome, so the trial sub
 *      never got created.
 *
 * Recipients: success@/poorab@/matt@rejig.ai.
 * Skips send entirely when both sections are empty — quiet days should
 * not train people to ignore the digest.
 *
 * No persistence — gap detection is a derived view, not tracked state.
 * If a gap persists, it resurfaces tomorrow; once fixed, it drops off.
 */
import type { NextRequest } from 'next/server';
import { runDailyChecks } from '@/lib/automations/daily-checks';
import { sendDailyDigestEmail } from '@/lib/email/send';

const DIGEST_RECIPIENTS = [
  'success@rejig.ai',
  'poorab@rejig.ai',
  'matt@rejig.ai',
];

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return Response.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Dry-run mode for local sanity checks — returns the result JSON without
  // sending the email. Pass ?dryRun=1.
  const url = new URL(request.url);
  const dryRun = url.searchParams.get('dryRun') === '1';

  let result;
  try {
    result = await runDailyChecks();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[daily-checks] runDailyChecks failed', msg);
    return Response.json({ error: 'runDailyChecks failed', detail: msg }, { status: 500 });
  }

  const total = result.section1.length + result.section2.length;
  const summary = {
    durationMs: result.durationMs,
    rejigAccountsFetched: result.rejigAccountsFetched,
    section1Count: result.section1.length,
    section2Count: result.section2.length,
    total,
    emailSent: false as boolean,
    dryRun,
  };

  if (total === 0) {
    console.log('[daily-checks] all clear — skipping email send');
    return Response.json(summary);
  }

  if (dryRun) {
    console.log('[daily-checks] dry-run mode — skipping email send', summary);
    return Response.json({ ...summary, section1: result.section1, section2: result.section2 });
  }

  try {
    const digestDate = new Date().toISOString().slice(0, 10);
    await sendDailyDigestEmail({
      to: DIGEST_RECIPIENTS,
      digestDate,
      section1: result.section1,
      section2: result.section2,
    });
    summary.emailSent = true;
    console.log('[daily-checks] digest sent', summary);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[daily-checks] digest send failed', msg);
    return Response.json({ ...summary, error: 'digest send failed', detail: msg }, { status: 500 });
  }

  return Response.json(summary);
}
