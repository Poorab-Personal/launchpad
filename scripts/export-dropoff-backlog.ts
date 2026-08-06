/**
 * CSV export of the FULL pre-existing drop-off backlog — every non-Launched
 * customer's stalled Active task, customer-facing and team-facing, with NO
 * rollout cutoff applied (unlike the live dropoff-reminders.ts / dryRun
 * audit, which now excludes anything activated before ROLLOUT_CUTOFF_DATE
 * per the 2026-08-06 go-forward decision).
 *
 * Purpose: manual pruning pass before the automation goes live — this is
 * the backlog the cutoff deliberately keeps OUT of the automated tracks,
 * so it needs a human pass instead. Phase buckets match the funnel framing
 * from the 2026-08-05 discussion (never submitted / submitted no card /
 * card saved / D2C design approval / add-on kickoff / other).
 *
 * Run: npx tsx --env-file=.env.local scripts/export-dropoff-backlog.ts
 * Output: scripts/data/dropoff-backlog-customers-<date>.csv
 *         scripts/data/dropoff-backlog-team-<date>.csv
 */
import { writeFileSync } from 'node:fs';
import { and, eq, ne } from 'drizzle-orm';
import { db } from '../src/db';
import * as schema from '../src/db/schema';
import { getSetting } from '../src/lib/db';

const REMINDER_TIER_DAYS = [2, 5, 8] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

const PHASE_BUCKETS: { label: string; taskNames: string[] }[] = [
  { label: 'never-submitted', taskNames: ['Complete Your Onboarding Form', 'Confirm Your Information'] },
  { label: 'submitted-no-card', taskNames: ['Capture Payment Method'] },
  { label: 'card-saved', taskNames: ['Schedule Your Onboarding Call', 'Watch Setup Video', 'Sign In & Reset Password'] },
  { label: 'd2c-design-approval', taskNames: ['Review & Approve Your Brand Kit'] },
  { label: 'addon-kickoff', taskNames: ['Download Guide & Upload Videos', 'Download Script & Upload Recordings'] },
];

function phaseFor(taskName: string): string {
  return PHASE_BUCKETS.find((b) => b.taskNames.includes(taskName))?.label ?? 'other';
}

function tierForDays(daysSince: number): number {
  let tier = 0;
  for (const t of REMINDER_TIER_DAYS) if (daysSince >= t) tier++;
  return tier;
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}

function csvEscape(s: unknown): string {
  if (s == null) return '';
  const str = String(s);
  if (/[",\n\r]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}

function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const lines = [columns.join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvEscape(r[c])).join(','));
  return lines.join('\n');
}

async function main() {
  const now = new Date();
  const portalBase = (await getSetting('portal_base_url')) || 'https://onboarding.rejig.ai';
  const dateTag = now.toISOString().slice(0, 10);

  // Payment mode lookup, same as dropoff-b2b-digest.ts, for the hot-case flag.
  const templateRows = await db
    .selectDistinct({
      workflowKey: schema.workflowTemplates.workflowKey,
      paymentMode: schema.workflowTemplates.paymentMode,
    })
    .from(schema.workflowTemplates);
  const paymentModeByWorkflow = new Map(templateRows.map((t) => [t.workflowKey, t.paymentMode]));

  // ── Customer-facing backlog ─────────────────────────────────────────
  const customerRows = await db
    .select({ task: schema.tasks, customer: schema.customers, brokerageName: schema.brokerages.name })
    .from(schema.tasks)
    .innerJoin(schema.customers, eq(schema.tasks.customerId, schema.customers.id))
    .leftJoin(schema.brokerages, eq(schema.customers.brokerageId, schema.brokerages.id))
    .where(
      and(
        eq(schema.tasks.taskType, 'Client'),
        eq(schema.tasks.visibleToClient, true),
        eq(schema.tasks.status, 'Active'),
        ne(schema.customers.currentStage, 'Launched'),
      ),
    );

  const customerCsvRows = customerRows
    .filter(({ task }) => task.activatedAt !== null)
    .map(({ task, customer, brokerageName }) => {
      const daysStalled = daysBetween(task.activatedAt as Date, now);
      const isHotCase =
        task.taskName === 'Schedule Your Onboarding Call'
        && paymentModeByWorkflow.get(customer.workflowKey) === 'setup-intent-at-intake';
      return {
        customer_id: customer.id,
        customer_name: customer.name,
        contact_email: customer.contactEmail,
        customer_type: customer.type,
        workflow_key: customer.workflowKey,
        brokerage_name: brokerageName ?? '',
        phase_bucket: phaseFor(task.taskName),
        task_name: task.taskName,
        days_stalled: daysStalled,
        tier_if_enabled: `${tierForDays(daysStalled)}/3`,
        is_hot_case: isHotCase ? 'yes' : '',
        activated_at: (task.activatedAt as Date).toISOString().slice(0, 10),
        created_via: customer.createdVia,
        environment: (customer.environment ?? []).join('|'),
        portal_url: `${portalBase}/r/${customer.accessToken}`,
        prune_decision: '', // blank column for manual keep/drop/nudge-now notes
      };
    })
    .sort((a, b) => b.days_stalled - a.days_stalled);

  const customerCols = [
    'customer_id', 'customer_name', 'contact_email', 'customer_type', 'workflow_key',
    'brokerage_name', 'phase_bucket', 'task_name', 'days_stalled', 'tier_if_enabled',
    'is_hot_case', 'activated_at', 'created_via', 'environment', 'portal_url', 'prune_decision',
  ];
  const customerCsvPath = `scripts/data/dropoff-backlog-customers-${dateTag}.csv`;
  writeFileSync(customerCsvPath, toCsv(customerCsvRows, customerCols));

  // ── Team-facing backlog ─────────────────────────────────────────────
  const teamRows = await db
    .select({ task: schema.tasks, customer: schema.customers, assignee: schema.teamMembers })
    .from(schema.tasks)
    .innerJoin(schema.customers, eq(schema.tasks.customerId, schema.customers.id))
    .leftJoin(schema.teamMembers, eq(schema.tasks.assignedToTeamMemberId, schema.teamMembers.id))
    .where(
      and(
        eq(schema.tasks.taskType, 'Team'),
        eq(schema.tasks.status, 'Active'),
        ne(schema.customers.currentStage, 'Launched'),
      ),
    );

  const teamCsvRows = teamRows
    .filter(({ task }) => task.activatedAt !== null)
    .map(({ task, customer, assignee }) => {
      const daysStalled = daysBetween(task.activatedAt as Date, now);
      return {
        customer_id: customer.id,
        customer_name: customer.name,
        task_name: task.taskName,
        assignee_name: assignee?.name ?? '',
        assignee_email: assignee?.email ?? '',
        assignee_active: assignee ? (assignee.active ? 'yes' : 'no') : '',
        days_stalled: daysStalled,
        tier_if_enabled: `${tierForDays(daysStalled)}/3`,
        activated_at: (task.activatedAt as Date).toISOString().slice(0, 10),
        created_via: customer.createdVia,
        workspace_url: `${portalBase}/workspace/customers/${customer.id}`,
        prune_decision: '',
      };
    })
    .sort((a, b) => b.days_stalled - a.days_stalled);

  const teamCols = [
    'customer_id', 'customer_name', 'task_name', 'assignee_name', 'assignee_email',
    'assignee_active', 'days_stalled', 'tier_if_enabled', 'activated_at', 'created_via',
    'workspace_url', 'prune_decision',
  ];
  const teamCsvPath = `scripts/data/dropoff-backlog-team-${dateTag}.csv`;
  writeFileSync(teamCsvPath, toCsv(teamCsvRows, teamCols));

  // ── Summary ──────────────────────────────────────────────────────────
  console.log(`Customer backlog: ${customerCsvRows.length} rows → ${customerCsvPath}`);
  const byPhase = new Map<string, number>();
  for (const r of customerCsvRows) byPhase.set(r.phase_bucket, (byPhase.get(r.phase_bucket) ?? 0) + 1);
  for (const [phase, count] of byPhase) console.log(`  ${phase.padEnd(22)} ${count}`);

  console.log(`\nTeam backlog: ${teamCsvRows.length} rows → ${teamCsvPath}`);

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
