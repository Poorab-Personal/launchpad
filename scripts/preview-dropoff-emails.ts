/**
 * Renders one REAL representative email per distinct stalled-task "bucket"
 * to local HTML files — so the actual copy/template/design can be reviewed
 * against real backlog data without sending all 60+ live emails or opening
 * a generic PreviewProps stub.
 *
 * Buckets (by which task is stalled, matching how the funnel actually forks):
 *   1. Never submitted   — "Complete Your Onboarding Form" (D2C) /
 *                           "Confirm Your Information" (B2B)
 *   2. Submitted, no card — "Capture Payment Method" (B2B setup-intent-at-intake)
 *   3. Card saved         — "Schedule Your Onboarding Call" / "Watch Setup
 *                            Video" / "Sign In & Reset Password"
 *   4. D2C design approval — "Review & Approve Your Brand Kit" (no B2B equivalent)
 *   5. Add-on kickoff      — "Download Guide & Upload Videos" / "Download
 *                            Script & Upload Recordings"
 * Anything not matching a named bucket falls into "Other" so nothing is
 * silently dropped from the preview.
 *
 * Also renders one D2C escalation sample (using the sales@ fallback, since
 * none of the current backlog has a captured salesRepEmail) and one team
 * escalation sample, so every email "flavor" in the plan has a preview.
 *
 * Deliberately does NOT go through runDropoffReminders() — that function is
 * gated by ROLLOUT_CUTOFF_DATE (go-forward only, per 2026-08-06 decision)
 * and returns nothing for the pre-existing backlog. This script's job is
 * content/design review using representative real data, independent of
 * whether the automation would actually fire on it today — so it queries
 * the backlog directly instead, same as scripts/export-dropoff-backlog.ts.
 *
 * Run: npx tsx --env-file=.env.local scripts/preview-dropoff-emails.ts
 * Output: HTML files under the path printed at the end of the run.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { render } from '@react-email/render';
import { and, eq, ne } from 'drizzle-orm';
import * as React from 'react';
import { db } from '../src/db';
import * as schema from '../src/db/schema';
import { getSetting } from '../src/lib/db';
import DropoffReminderCustomerEmail from '../src/lib/email/templates/dropoff-reminder-customer';
import DropoffEscalationSalesRepEmail from '../src/lib/email/templates/dropoff-escalation-salesrep';
import DropoffEscalationTeamEmail from '../src/lib/email/templates/dropoff-escalation-team';

const OUT_DIR = process.env.PREVIEW_OUT_DIR || '/tmp/dropoff-email-previews';
const DAY_MS = 24 * 60 * 60 * 1000;
const REMINDER_TIER_DAYS = [2, 5, 8] as const;
const FINAL_TIER = REMINDER_TIER_DAYS.length;
const D2C_ESCALATION_FALLBACK_TO = 'sales@rejig.ai';

const BUCKETS: { label: string; taskNames: string[] }[] = [
  { label: '1-never-submitted', taskNames: ['Complete Your Onboarding Form', 'Confirm Your Information'] },
  { label: '2-submitted-no-card', taskNames: ['Capture Payment Method'] },
  { label: '3-card-saved', taskNames: ['Schedule Your Onboarding Call', 'Watch Setup Video', 'Sign In & Reset Password'] },
  { label: '4-d2c-design-approval', taskNames: ['Review & Approve Your Brand Kit'] },
  { label: '5-addon-kickoff', taskNames: ['Download Guide & Upload Videos', 'Download Script & Upload Recordings'] },
];

function bucketFor(taskName: string): string {
  return BUCKETS.find((b) => b.taskNames.includes(taskName))?.label ?? '6-other';
}

function tierForDays(daysSince: number): number {
  let tier = 0;
  for (const t of REMINDER_TIER_DAYS) if (daysSince >= t) tier++;
  return tier;
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}

function firstName(fullName: string): string {
  const trimmed = fullName.trim();
  return trimmed ? trimmed.split(/\s+/)[0] : 'there';
}

async function writeHtml(filename: string, element: React.ReactElement) {
  const html = await render(element);
  writeFileSync(`${OUT_DIR}/${filename}`, html);
  return html.length;
}

async function main() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  const now = new Date();
  const portalBase = (await getSetting('portal_base_url')) || 'https://onboarding.rejig.ai';

  // Full backlog, no rollout cutoff — same query shape as export-dropoff-backlog.ts.
  const rows = await db
    .select({ task: schema.tasks, customer: schema.customers })
    .from(schema.tasks)
    .innerJoin(schema.customers, eq(schema.tasks.customerId, schema.customers.id))
    .where(
      and(
        eq(schema.tasks.taskType, 'Client'),
        eq(schema.tasks.visibleToClient, true),
        eq(schema.tasks.status, 'Active'),
        ne(schema.customers.currentStage, 'Launched'),
      ),
    );

  type CustomerSample = {
    customerName: string;
    contactEmail: string;
    customerType: string;
    taskName: string;
    instructions: string | null;
    portalUrl: string;
    daysStalled: number;
    tier: number;
  };

  const samples: CustomerSample[] = rows
    .filter(({ task }) => task.activatedAt !== null)
    .map(({ task, customer }) => {
      const daysStalled = daysBetween(task.activatedAt as Date, now);
      return {
        customerName: customer.name,
        contactEmail: customer.contactEmail,
        customerType: customer.type,
        taskName: task.taskName,
        instructions: task.instructions,
        portalUrl: `${portalBase}/r/${customer.accessToken}`,
        daysStalled,
        tier: tierForDays(daysStalled),
      };
    });

  const byTaskName = new Map<string, CustomerSample[]>();
  for (const s of samples) {
    const arr = byTaskName.get(s.taskName) ?? [];
    arr.push(s);
    byTaskName.set(s.taskName, arr);
  }

  console.log(`Total stalled client tasks (no rollout cutoff): ${samples.length}`);
  console.log(`Rendering ${byTaskName.size} representative samples (one per distinct task name)...\n`);

  const summary: { bucket: string; taskName: string; count: number; representative: string; tier: string }[] = [];

  for (const [taskName, group] of byTaskName) {
    // Most-stalled example — most likely tier-3/final, so the sample shows
    // the "last reminder" copy variant too.
    const rep = group.slice().sort((a, b) => b.daysStalled - a.daysStalled)[0];
    const bucket = bucketFor(taskName);
    const safeTaskName = taskName.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const isFinalReminder = rep.tier >= FINAL_TIER;

    await writeHtml(
      `${bucket}__${safeTaskName}.html`,
      React.createElement(DropoffReminderCustomerEmail, {
        firstName: firstName(rep.customerName),
        taskName: rep.taskName,
        instructions: rep.instructions,
        portalUrl: rep.portalUrl,
        isFinalReminder,
      }),
    );

    summary.push({
      bucket,
      taskName,
      count: group.length,
      representative: `${rep.customerName} (${rep.daysStalled}d)`,
      tier: `${rep.tier}/${FINAL_TIER}${isFinalReminder ? ' FINAL' : ''}`,
    });
  }

  summary.sort((a, b) => a.bucket.localeCompare(b.bucket));

  console.log('BUCKET'.padEnd(24) + 'TASK'.padEnd(34) + 'COUNT'.padEnd(7) + 'TIER'.padEnd(12) + 'REPRESENTATIVE');
  for (const s of summary) {
    console.log(
      s.bucket.padEnd(24) + s.taskName.padEnd(34) + String(s.count).padEnd(7) + s.tier.padEnd(12) + s.representative,
    );
  }

  // ── Escalation samples ──────────────────────────────────────────────
  console.log();
  const d2cCandidate = samples
    .filter((s) => s.customerType === 'D2C' && s.tier >= FINAL_TIER)
    .sort((a, b) => b.daysStalled - a.daysStalled)[0];
  if (d2cCandidate) {
    await writeHtml(
      '7-escalation__d2c-salesrep.html',
      React.createElement(DropoffEscalationSalesRepEmail, {
        salesRepEmail: D2C_ESCALATION_FALLBACK_TO, // none of the backlog has a captured salesRepEmail
        customerName: d2cCandidate.customerName,
        customerEmail: d2cCandidate.contactEmail,
        taskName: d2cCandidate.taskName,
        daysStalled: d2cCandidate.daysStalled,
        portalUrl: d2cCandidate.portalUrl,
      }),
    );
    console.log(`D2C sales-rep escalation sample: ${d2cCandidate.customerName} → ${D2C_ESCALATION_FALLBACK_TO} — 7-escalation__d2c-salesrep.html`);
  } else {
    console.log('No D2C escalation candidate (day 8+) in the current backlog to sample.');
  }

  // Team escalation sample — separate query, same "no cutoff" shape.
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
  const teamCandidate = teamRows
    .filter(({ task }) => task.activatedAt !== null && tierForDays(daysBetween(task.activatedAt as Date, now)) >= FINAL_TIER)
    .map(({ task, customer, assignee }) => ({
      taskName: task.taskName,
      customerName: customer.name,
      assigneeName: assignee?.name ?? 'unassigned',
      daysStalled: daysBetween(task.activatedAt as Date, now),
      workspaceUrl: `${portalBase}/workspace/customers/${customer.id}`,
    }))
    .sort((a, b) => b.daysStalled - a.daysStalled)[0];
  if (teamCandidate) {
    await writeHtml(
      '8-escalation__team-ops.html',
      React.createElement(DropoffEscalationTeamEmail, teamCandidate),
    );
    console.log(`Team/ops escalation sample: ${teamCandidate.customerName} (${teamCandidate.taskName}) — 8-escalation__team-ops.html`);
  }

  console.log(`\nWrote ${summary.length + (d2cCandidate ? 1 : 0) + (teamCandidate ? 1 : 0)} HTML files to ${OUT_DIR}`);
  console.log(`Open with: open ${OUT_DIR}/*.html`);

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
