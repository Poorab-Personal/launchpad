/**
 * GET /api/cron/branch-report
 *
 * Runs on the 1st of each month (14:00 UTC = 09:00 Central during CDT) and
 * emails each configured B2B brokerage their own per-office onboarding
 * picture: who raised a hand, where they stalled, who subscribed, and how much
 * of each office's roster is still untouched.
 *
 * Same report the `branch-report` skill sends by hand — one implementation in
 * src/lib/reports/branch-report.ts, so a scheduled send and an ad-hoc CLI run
 * can never disagree about a number we put in front of a brokerage.
 *
 * Every recipient here is EXTERNAL, so the three guards in RECIPIENTS are not
 * optional:
 *   stripe  — subscription state from a live Stripe pull. customers.
 *             subscription_status is a mirror that goes stale silently.
 *   external— drops phone numbers, plan prices and our product name.
 *   exclude — nothing in the data marks internal accounts; without this
 *             Matt Madden counts as a paying Keyes agent.
 *
 * Query params:
 *   ?dryRun=1       compute and return the summary without sending.
 *   ?slug=keyes     run one brokerage instead of all configured ones.
 *   ?to=a@b.com     override recipients (comma-separated). Dry-run testing.
 *
 * A brokerage that throws does not stop the others — each is sent
 * independently and the response reports per-brokerage outcomes.
 */
import type { NextRequest } from 'next/server';
import {
  computeBranchReport,
  renderBranchReportHtml,
  sendBranchReportEmail,
} from '@/lib/reports/branch-report';

type Recipient = {
  slug: string;
  to: string[];
  exclude: string[];
  subject: string;
};

/**
 * Who gets which report. Add a brokerage here once its roster sync and Stripe
 * plans are live — nothing else needs to change.
 *
 * Currently routed internally while the format is reviewed; swap `to` for the
 * brokerage's own distribution list to send direct.
 */
const RECIPIENTS: Recipient[] = [
  {
    slug: 'keyes',
    to: ['poorab@rejig.ai'],
    exclude: ['@rejig.ai', 'mattmadden@kw.com'],
    subject: 'Rejig across Keyes — where every agent stands',
  },
  {
    slug: 'ipre',
    to: ['poorab@rejig.ai'],
    exclude: ['@rejig.ai'],
    subject: 'Rejig across Illustrated Properties — where every agent stands',
  },
];

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
  const only = url.searchParams.get('slug');
  const toOverride = (url.searchParams.get('to') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const targets = only ? RECIPIENTS.filter((r) => r.slug === only) : RECIPIENTS;
  if (targets.length === 0) {
    return Response.json({ error: `no configured brokerage with slug "${only}"` }, { status: 404 });
  }

  const started = Date.now();
  const results: Array<Record<string, unknown>> = [];

  for (const target of targets) {
    try {
      const report = await computeBranchReport({
        slug: target.slug,
        stripe: true,
        external: true,
        exclude: target.exclude,
      });

      const outcome: Record<string, unknown> = {
        slug: target.slug,
        brokerage: report.brokerage,
        rosterAgents: report.totals.rosterAgents,
        raisedHand: report.totals.inLp,
        subscribed: report.totals.paying + report.totals.trial,
        stages: report.totals.stages,
        rejigSnapshot: report.stripeStats.rejigSnapshot,
        to: toOverride.length > 0 ? toOverride : target.to,
        emailSent: false,
      };

      if (dryRun) {
        results.push({ ...outcome, dryRun: true });
        continue;
      }

      // detail stays on, exactly as the CLI sends it. The renderer itself caps
      // the inline roster at 60 agents and moves anything larger to the
      // attachment (Gmail clips past ~102KB), so a brokerage-wide send is an
      // attachment either way — but a small brokerage still gets its roster
      // inline, and the "full list attached" notice only renders when detail
      // was actually requested.
      await sendBranchReportEmail({
        to: outcome.to as string[],
        subject: target.subject,
        html: renderBranchReportHtml(report),
        attachments: [
          { filename: report.branchCsvName, content: report.branchCsv },
          { filename: report.agentCsvName, content: report.agentCsv },
        ],
      });
      outcome.emailSent = true;
      console.log('[branch-report] sent', target.slug, outcome.raisedHand, 'in funnel');
      results.push(outcome);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[branch-report] failed for', target.slug, msg);
      results.push({ slug: target.slug, error: msg, emailSent: false });
    }
  }

  const failed = results.filter((r) => r.error).length;
  return Response.json(
    { dryRun, durationMs: Date.now() - started, sent: results.length - failed, failed, results },
    { status: failed > 0 ? 500 : 200 },
  );
}
