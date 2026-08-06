/**
 * GET /api/cron/daily-checks
 *
 * Runs every morning (16:00 UTC = 09:00 PT during PDT, 08:00 PT during
 * PST). Vercel-cron scheduled in vercel.json. Bearer-auth gated.
 *
 * Step 1 — drop-off reminders (src/lib/automations/dropoff-reminders.ts,
 * see docs/plans/dropoff-reminder-cron.md). Customer- and team-facing
 * sends, runs first and independently of step 2 so a failure in the
 * internal digest never blocks customer/team nudges (and vice versa).
 *
 * Step 2 — internal gap-detection digest (src/lib/automations/daily-checks.ts):
 *   1. LP has a Stripe sub but Rejig doesn't (or has a different one).
 *   2. B2B customers stuck in 'Onboarding Scheduled' past their callDate
 *      — the CSM didn't mark the meeting outcome, so the trial sub
 *      never got created.
 *
 * Recipients: success@/poorab@/matt@rejig.ai.
 * Skips send entirely when both sections are empty — quiet days should
 * not train people to ignore the digest.
 *
 * No persistence for step 2 — gap detection is a derived view, not tracked
 * state. If a gap persists, it resurfaces tomorrow; once fixed, it drops off.
 */
import type { NextRequest } from 'next/server';
import { runDailyChecks } from '@/lib/automations/daily-checks';
import { runDropoffReminders } from '@/lib/automations/dropoff-reminders';
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
  // sending any email. Pass ?dryRun=1.
  const url = new URL(request.url);
  const dryRun = url.searchParams.get('dryRun') === '1';

  let dropoff;
  try {
    dropoff = await runDropoffReminders({ dryRun });
  } catch (err) {
    // Best-effort — a failure here shouldn't block the internal digest below.
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[daily-checks] runDropoffReminders failed (non-blocking)', msg);
    dropoff = { actions: [], durationMs: 0, error: msg };
  }
  console.log('[daily-checks] dropoff reminders', {
    durationMs: dropoff.durationMs,
    count: dropoff.actions.length,
    byKind: dropoff.actions.reduce<Record<string, number>>((acc, a) => {
      acc[a.kind] = (acc[a.kind] ?? 0) + 1;
      return acc;
    }, {}),
    dryRun,
  });

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
    dropoff: { durationMs: dropoff.durationMs, count: dropoff.actions.length },
  };

  if (total === 0 && !dryRun) {
    console.log('[daily-checks] all clear — skipping digest email send');
    return Response.json(summary);
  }

  if (dryRun) {
    console.log('[daily-checks] dry-run mode — skipping all email sends', summary);
    return Response.json({
      ...summary,
      section1: result.section1,
      section2: result.section2,
      dropoffActions: dropoff.actions,
    });
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
