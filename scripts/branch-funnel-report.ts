/**
 * Branch funnel report — B2B brokerages with an office/branch roster.
 *
 * Same funnel buckets as `funnel-audit.ts`, but grouped by the agent's
 * primary branch (brokerage_roster.office_name / primary_office_id) so a
 * branch manager or concierge can see exactly who at THEIR office started
 * onboarding and where they stalled — plus how many agents on the branch
 * roster haven't touched LaunchPad at all (the push list denominator).
 *
 * Runbook: .claude/skills/branch-report/SKILL.md  (say "send the Keyes report")
 *
 * Usage:
 *   npx tsx scripts/branch-funnel-report.ts <brokerage_slug> [flags]
 *
 *   <brokerage_slug>   e.g. keyes, ipre, bw   (brokerages.landing_page_slug)
 *
 * The send that goes to a brokerage — all three flags matter:
 *   npx tsx scripts/branch-funnel-report.ts keyes --stripe --external \
 *     --exclude @rejig.ai,mattmadden@kw.com --email someone@keyes.com
 *   ...add --branch Doral (name OR number, substring) to scope it to one office.
 *   ...add --preview /tmp/x.html to render the email without sending it.
 *
 * Flags:
 *   --csv                 write two joined CSVs to scripts/data/ —
 *                         <slug>-branches-<date>.csv (one row per branch) and
 *                         <slug>-branch-agents-<date>.csv (one row per LP agent,
 *                         joined back on branch_id)
 *   --include-test        include customers with 'test' in their environment array
 *   --branch <q>          only branches whose name/number matches <q> (substring)
 *   --email <a,b,c>       email the report (HTML body + both CSVs attached)
 *   --subject <s>         override email subject
 *   --stuck-days N        days in a non-terminal bucket before a row is flagged (default 3)
 *   --no-detail           summary table only, skip the per-agent listing
 *   --json                write the whole report as JSON to
 *                         scripts/data/<slug>-branch-report-<date>.json (for charts / artifacts)
 *   --stripe              take subscription state from a LIVE Stripe pull instead of
 *                         customers.subscription_status, and fold in any live Stripe
 *                         subscriber who has no LaunchPad customer record at all
 *   --exclude <a,b,c>     with --stripe: drop Stripe rows whose email contains any of
 *                         these substrings (internal/test accounts)
 *   --preview <path>      write the email HTML to a file instead of sending it
 *   --external            shape the output for a BROKERAGE recipient rather than for us:
 *                         collapses the terminal stages into what they mean commercially
 *                         (Subscribed / Unbilled / Lapsed), and drops phone numbers and
 *                         plan prices from the email and CSV. Requires --stripe.
 *
 * Why --stripe exists: `customers.subscription_status` is a mirror field, and for the
 * Keyes Oct-2025 backfill cohort it was stamped once at import and never moved again —
 * 26 of those rows even share one placeholder subscription id. Counting Trial/Paying off
 * that column overstates live subscriptions and misses Stripe subscribers who never had
 * an LP record. With --stripe the counts reconcile to `scripts/stripe-subs.ts`, which is
 * what the board/KPI numbers are built from. Prefer it for anything customer-facing.
 *
 * Branch attribution, in order:
 *   1. brokerage_roster.customer_id === customer.id   (the sync-set link)
 *   2. customer contact/platform email matches roster public/private email
 *   3. unattributed  → reported in its own bucket, never silently dropped
 *
 * Step 2 matters: roster.customer_id is only set on the landing-page
 * verification path, so backfilled customers have no link and would
 * otherwise vanish from every branch.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { STUCK_DAYS_THRESHOLD } from './funnel-audit-labels';
import type { BranchReportResult } from '../src/lib/reports/branch-report';

dotenv.config({ path: '.env.local' });

type Branch = BranchReportResult['branches'][number];
type Agent = Branch['agents'][number];

type Args = {
  slug: string;
  csv: boolean;
  includeTest: boolean;
  branch: string | null;
  email: string[];
  subject: string | null;
  stuckDays: number;
  detail: boolean;
  json: boolean;
  stripe: boolean;
  exclude: string[];
  external: boolean;
  preview: string | null;
};

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const a: Args = {
    slug: '',
    csv: false,
    includeTest: false,
    branch: null,
    email: [],
    subject: null,
    stuckDays: STUCK_DAYS_THRESHOLD,
    detail: true,
    json: false,
    stripe: false,
    exclude: [],
    external: false,
    preview: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === '--csv') a.csv = true;
    else if (f === '--json') a.json = true;
    else if (f === '--stripe') a.stripe = true;
    else if (f === '--external') a.external = true;
    else if (f === '--preview') a.preview = argv[++i] ?? null;
    else if (f === '--exclude') {
      a.exclude = (argv[++i] ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    }
    else if (f === '--include-test') a.includeTest = true;
    else if (f === '--no-detail') a.detail = false;
    else if (f === '--branch') a.branch = argv[++i] ?? null;
    else if (f === '--subject') a.subject = argv[++i] ?? null;
    else if (f === '--email') {
      a.email = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    } else if (f === '--stuck-days') {
      const v = parseInt(argv[++i] ?? '', 10);
      if (Number.isNaN(v) || v < 0) {
        console.error('--stuck-days requires a non-negative integer');
        process.exit(2);
      }
      a.stuckDays = v;
    } else if (f.startsWith('--')) {
      console.error(`Unknown flag: ${f}`);
      process.exit(2);
    } else positional.push(f);
  }
  if (positional.length === 0) {
    console.error(
      'Usage: npx tsx scripts/branch-funnel-report.ts <brokerage_slug> [--csv] [--branch <q>] [--email <a,b>] [--include-test] [--no-detail]',
    );
    process.exit(2);
  }
  a.slug = positional[0].toLowerCase();
  return a;
}

type SummaryRow = {
  branch: string;
  rosterAgents: number;
  inLp: number;
  pct: string;
  stages: Record<string, number>;
  trial: number;
  paying: number;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // The report itself lives in src/lib/reports/branch-report.ts so the monthly
  // cron route can import it too (tsconfig excludes scripts/ from the build).
  // Imported lazily so dotenv has populated the environment first.
  const {
    computeBranchReport,
    renderBranchReportHtml,
    sendBranchReportEmail,
  } = await import('../src/lib/reports/branch-report');

  const r = await computeBranchReport({
    slug: args.slug,
    stripe: args.stripe,
    external: args.external,
    exclude: args.exclude,
    branch: args.branch,
    includeTest: args.includeTest,
    stuckDays: args.stuckDays,
  });
  const { labelOrder, shortLabel, summary, totals, totalRow, stripeStats, branchLabel, today } = r;
  const displayBranches = r.branches;
  const workflowKey = r.workflowKey;
  const unmapped = r.unmapped;

  console.log(`\n${r.header}\n`);

  if (args.stripe) {
    const dupSubs = stripeStats.subs - (stripeStats.paying + stripeStats.trial);
    console.log(
      `Subscription state from live Stripe: ${stripeStats.subs} live subscription(s) on ${workflowKey} plan prices ` +
        `(${stripeStats.payingSubs} paying, ${stripeStats.trialSubs} trialing)` +
        `\n  held by ${stripeStats.paying + stripeStats.trial} agent(s) — ${stripeStats.paying} paying, ${stripeStats.trial} trialing` +
        (dupSubs > 0 ? ` (${dupSubs} agent(s) hold a second live sub)` : ''),
    );
    console.log(
      `  corrected ${stripeStats.corrected} LP row(s) · cleared ${stripeStats.cleared} stale "live" row(s) · ` +
        `added ${stripeStats.added} subscriber(s) with no LaunchPad record`,
    );
    if (stripeStats.unbilled > 0) {
      console.log(
        `  ${stripeStats.unbilled} agent(s) are live in Rejig (pull ${stripeStats.rejigSnapshot || 'n/a'}) with NO subscription anywhere — served unbilled.`,
      );
    }
    for (const g of stripeStats.groupPlans) {
      console.log(
        `  GROUP PLAN ${g.id} — ${g.seats} seat(s) at ${g.amount}, ${g.members} LP customer(s) linked. ` +
          `Not on a stripe_plans price, so per-price pulls (stripe-subs.ts, KPI deck) miss it entirely.`,
      );
    }
    if (stripeStats.groupUnresolved > 0) {
      console.log(
        `  ⚠ ${stripeStats.groupMembers} agent(s) linked to a group plan but only ${stripeStats.groupSeats} seat(s) billed — ` +
          `${stripeStats.groupUnresolved} of them are no longer covered. Stripe stores seats as a quantity, not a list, ` +
          `so which ones cannot be determined here.`,
      );
    }
    console.log('');
  } else {
    console.log(
      '⚠  Trial/Paying come from customers.subscription_status (a stale mirror for the backfill cohort).\n' +
        '   Re-run with --stripe for counts that reconcile to Stripe.\n',
    );
  }

  if (unmapped.length > 0) {
    console.log(`⚠  Unmapped milestone(s) in ${workflowKey} — showing raw task title:`);
    for (const u of unmapped) console.log(`     - "${u}"`);
    console.log(`   Add to scripts/funnel-audit-labels.ts.\n`);
  }
  const sumCols: Array<{ label: string; get: (s: SummaryRow) => string; right?: boolean }> = [
    { label: 'Branch', get: (s) => s.branch },
    { label: 'Roster', get: (s) => String(s.rosterAgents || ''), right: true },
    { label: 'In LP', get: (s) => String(s.inLp), right: true },
    { label: '%', get: (s) => s.pct, right: true },
    {
      label: 'Untouched',
      get: (s) => (s.rosterAgents ? String(Math.max(0, s.rosterAgents - s.inLp)) : ''),
      right: true,
    },
    ...labelOrder.map((l) => ({
      label: shortLabel[l] ?? l,
      get: (s: SummaryRow) => String(s.stages[l] || ''),
      right: true,
    })),
    { label: 'Trial', get: (s) => String(s.trial || ''), right: true },
    { label: 'Paying', get: (s) => String(s.paying || ''), right: true },
  ];

  const printTable = (
    cols: Array<{ label: string; get: (r: never) => string; right?: boolean }>,
    data: unknown[],
  ) => {
    const cells = data.map((r) => cols.map((c) => c.get(r as never)));
    const w = cols.map((c, i) => Math.max(c.label.length, ...cells.map((row) => row[i].length)));
    const sep = '+' + w.map((x) => '-'.repeat(x + 2)).join('+') + '+';
    console.log(sep);
    console.log('| ' + cols.map((c, i) => (c.right ? c.label.padStart(w[i]) : c.label.padEnd(w[i]))).join(' | ') + ' |');
    console.log(sep);
    for (const row of cells) {
      console.log('| ' + row.map((v, i) => (cols[i].right ? v.padStart(w[i]) : v.padEnd(w[i]))).join(' | ') + ' |');
    }
    console.log(sep);
  };

  printTable(sumCols as never, [...summary, totalRow]);
  if (args.detail) {
    console.log('\nPer-agent detail\n');
    for (const b of displayBranches) {
      if (b.agents.length === 0) continue;
      console.log(
        `── ${branchLabel(b)}  (${b.agents.length} in LaunchPad${b.rosterAgents ? ` / ${b.rosterAgents} on roster` : ''})`,
      );
      const detCols = [
        { label: 'Name', get: (a: Agent) => a.name },
        { label: 'Funnel Stage', get: (a: Agent) => a.funnelStage },
        { label: 'Sub', get: (a: Agent) => a.subscriptionState },
        { label: 'Plan', get: (a: Agent) => a.monthlyAmount },
        { label: 'Call Date', get: (a: Agent) => a.callDate },
        { label: 'Email', get: (a: Agent) => a.contactEmail },
        { label: 'Phone', get: (a: Agent) => a.phone },
        { label: 'Created', get: (a: Agent) => a.created },
        { label: 'Days', get: (a: Agent) => String(a.daysSinceCreated), right: true },
      ];
      printTable(detCols as never, b.agents);
      console.log('');
    }
  }

  // ---------- CSV / JSON files ----------
  if (args.csv) {
    writeFileSync(resolve('scripts/data', r.branchCsvName), r.branchCsv);
    writeFileSync(resolve('scripts/data', r.agentCsvName), r.agentCsv);
    console.log(`CSV written: scripts/data/${r.branchCsvName}`);
    console.log(`CSV written: scripts/data/${r.agentCsvName}`);
  }

  if (args.json) {
    const jsonName = `${args.slug}-branch-report-${today}.json`;
    writeFileSync(resolve('scripts/data', jsonName), JSON.stringify(r.jsonPayload, null, 2));
    console.log(`JSON written: scripts/data/${jsonName}`);
  }

  // ---------- email ----------
  if (args.email.length > 0 || args.preview) {
    const html = renderBranchReportHtml(r, { detail: args.detail });
    if (args.preview) {
      writeFileSync(args.preview, html);
      console.log(`\nEmail HTML written: ${args.preview}`);
    }
    if (args.email.length === 0) return;
    await sendBranchReportEmail({
      to: args.email,
      subject: args.subject ?? `${r.brokerage} onboarding by branch — ${today}`,
      html,
      attachments: [
        { filename: r.branchCsvName, content: r.branchCsv },
        { filename: r.agentCsvName, content: r.agentCsv },
      ],
    });
    console.log(`\nEmail sent to: ${args.email.join(', ')}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
