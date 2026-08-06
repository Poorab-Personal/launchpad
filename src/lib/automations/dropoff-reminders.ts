/**
 * Drop-off reminder cron — Tracks 1, 2, 5 of docs/plans/dropoff-reminder-cron.md.
 *
 * State-based, not a hardcoded task-name list (plan Decision 1): any
 * non-Launched customer's Active, client-visible task, or any Active Team
 * task, sitting past a day threshold gets nudged — regardless of which
 * workflow/brokerage it belongs to. New workflows need zero changes here.
 *
 * Schedule is day 2 / 5 / 8 off `tasks.activatedAt`, tracked via two
 * separate fields (deliberately not one — see plan §6 / review §6):
 *   - `lastReminderAt` — which reminder tier was last sent (routine nudge).
 *   - `escalatedAt`    — one-shot signal that the day-8 escalation fired.
 *     Kept independent so a reminder send succeeding while the escalation
 *     send fails doesn't silently and permanently suppress a retry.
 *
 * Tracks:
 *   1. Customer reminder — Active Client task → contactEmail, day 2/5/8.
 *   2. D2C escalation    — day 8, D2C customer → salesRepEmail (real-time,
 *      CC'd to Matt/Poorab — temporary per 2026-08-05 discussion).
 *   5. Team reminder     — Active Team task → assignee, day 2/5/8, then
 *      escalate to the ops trio at day 8. Vendor-processing tasks (Voice/
 *      Avatar add-on kickoffs) are excluded from escalation only, not the
 *      routine nudge — see architect review §1, they're legitimately
 *      multi-day waiting on ElevenLabs/HeyGen, not neglect.
 *
 * Tracks 3/4 (B2B weekly digest) live in dropoff-b2b-digest.ts — different
 * cadence (weekly) and no per-task emails, just a summary table.
 *
 * ROLLOUT_CUTOFF_DATE gates which tasks are eligible at all. Originally set
 * to exclude the pre-existing backlog (go-forward only, matching the
 * daily-checks.ts DIGEST_CUTOFF_DATE precedent); reversed same-day after
 * reviewing the backlog via scripts/export-dropoff-backlog.ts (CSV) and
 * scripts/preview-dropoff-emails.ts (rendered samples) — decision was to
 * include the existing backlog in the first live run rather than
 * grandfather it out. See the constant's own comment for the current value.
 *
 * Every send re-checks the task's live status (and, for escalation,
 * `escalatedAt`) immediately before sending — the customer/assignee may
 * have acted between the initial query and now.
 *
 * `dryRun: true` runs every check but skips the email send and DB write,
 * returning the same action list a live run would produce. This is the
 * single source of truth both the live cron and the pre-deploy audit
 * script use, so there's no drift between what's previewed and what fires.
 */
import { and, eq, ne } from 'drizzle-orm';
import { db } from '@/db';
import * as schema from '@/db/schema';
import { getSetting } from '@/lib/db';
import { sendEmail } from '@/lib/email/send';

const REMINDER_TIER_DAYS = [2, 5, 8] as const;
const FINAL_TIER = REMINDER_TIER_DAYS.length; // 3
const DAY_MS = 24 * 60 * 60 * 1000;

// Go-forward rollout — tasks activated before this are grandfathered out of
// the automation entirely (see module header). Anchor date, not "N days
// before deploy": fixed so redeploys don't silently shift the boundary.
//
// 2026-08-06: after reviewing the backlog (scripts/export-dropoff-backlog.ts
// CSVs + scripts/preview-dropoff-emails.ts samples), decision reversed —
// include the existing backlog in the first live run rather than
// grandfathering it out. Set far enough in the past to cover every current
// task. Left in place (not removed) as the mechanism for any future reset;
// harmless once every current task has been processed once, since the
// day-2/5/8 dedupe then runs on lastReminderAt/escalatedAt as normal.
const ROLLOUT_CUTOFF_DATE = new Date('2020-01-01T00:00:00Z');

const OPS_ESCALATION_TO = 'success@rejig.ai';
const OPS_ESCALATION_CC = ['poorab@rejig.ai', 'matt@rejig.ai'];
const D2C_ESCALATION_CC = ['matt@rejig.ai', 'poorab@rejig.ai']; // temporary, per 2026-08-05 discussion
// Fallback recipient when a D2C customer has no captured salesRepEmail
// (pre-dates the closedwon integration, or admin-created) — escalate to the
// shared sales inbox instead of silently dropping the escalation.
const D2C_ESCALATION_FALLBACK_TO = 'sales@rejig.ai';

// Legitimately multi-day, vendor-processing Team tasks. The day-2/5/8
// assignee nudge still applies ("did you remember to kick this off"), but
// escalating "this has been stuck a week" to the ops trio would be a
// guaranteed false alarm every time a Voice/Avatar add-on is purchased.
// See docs/plans/dropoff-reminder-cron-review.md §1.
const VENDOR_WAIT_ESCALATION_EXCLUSIONS = new Set([
  'Create Voice Clone in ElevenLabs',
  'Create Avatar in HeyGen',
]);

type TaskRow = typeof schema.tasks.$inferSelect;
type CustomerRow = typeof schema.customers.$inferSelect;
type TeamMemberRow = typeof schema.teamMembers.$inferSelect;

export type DropoffAction =
  | {
      kind: 'customer-reminder';
      customerId: string;
      customerName: string;
      taskId: string;
      taskName: string;
      to: string;
      tier: number;
      daysStalled: number;
      isFinalReminder: boolean;
      // Carried along (not just used to send) so preview/audit tooling can
      // render the exact email offline without a second DB round-trip.
      instructions: string | null;
      portalUrl: string;
    }
  | {
      kind: 'customer-escalation';
      customerId: string;
      customerName: string;
      customerEmail: string;
      taskId: string;
      taskName: string;
      to: string;
      cc: string[];
      daysStalled: number;
      portalUrl: string;
    }
  | {
      kind: 'team-reminder';
      customerId: string;
      customerName: string;
      taskId: string;
      taskName: string;
      to: string;
      tier: number;
      daysStalled: number;
      isFinalReminder: boolean;
      instructions: string | null;
      workspaceUrl: string;
    }
  | {
      kind: 'team-escalation';
      customerId: string;
      customerName: string;
      taskId: string;
      taskName: string;
      to: string;
      cc: string[];
      assigneeName: string;
      daysStalled: number;
      workspaceUrl: string;
    }
  | {
      kind: 'skipped';
      customerId: string;
      customerName: string;
      taskId: string;
      taskName: string;
      reason: string;
    };

export type DropoffRunResult = {
  actions: DropoffAction[];
  durationMs: number;
};

function tierForDays(daysSince: number): number {
  let tier = 0;
  for (const threshold of REMINDER_TIER_DAYS) {
    if (daysSince >= threshold) tier++;
  }
  return tier;
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}

function firstName(fullName: string): string {
  const trimmed = fullName.trim();
  if (!trimmed) return 'there';
  return trimmed.split(/\s+/)[0];
}

async function portalBaseUrl(): Promise<string> {
  return (await getSetting('portal_base_url')) || 'https://onboarding.rejig.ai';
}

async function logEvent(customerId: string, eventType: string, taskId: string, details: string): Promise<void> {
  try {
    await db.insert(schema.events).values({
      customerId,
      eventType,
      actorType: 'System',
      details,
      relatedTaskId: taskId,
    });
  } catch (err) {
    console.error(`[dropoffReminders] event log failed for task ${taskId}:`, err);
  }
}

export async function runDropoffReminders(opts: { dryRun?: boolean } = {}): Promise<DropoffRunResult> {
  const dryRun = opts.dryRun ?? false;
  const t0 = Date.now();
  const now = new Date();
  const portalBase = await portalBaseUrl();

  const [customerActions, teamActions] = await Promise.all([
    runCustomerTrack(now, portalBase, dryRun),
    runTeamTrack(now, portalBase, dryRun),
  ]);

  return {
    actions: [...customerActions, ...teamActions],
    durationMs: Date.now() - t0,
  };
}

// ─── Track 1 (customer reminder) + Track 2 (D2C escalation) ───────────────

async function runCustomerTrack(now: Date, portalBase: string, dryRun: boolean): Promise<DropoffAction[]> {
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

  const actions: DropoffAction[] = [];

  for (const { task, customer } of rows) {
    if (!task.activatedAt) continue; // defensive — Active tasks should always have this
    if (task.activatedAt < ROLLOUT_CUTOFF_DATE) continue; // pre-existing backlog, grandfathered out
    const daysSince = daysBetween(task.activatedAt, now);
    if (daysSince < REMINDER_TIER_DAYS[0]) continue; // not due yet

    if (customer.createdVia === 'backfill') continue;
    if (customer.environment?.includes('test')) continue;
    if (!customer.contactEmail) {
      actions.push(skip(task, customer, 'no contactEmail'));
      continue;
    }

    const portalUrl = `${portalBase}/r/${customer.accessToken}`;
    const dueTier = tierForDays(daysSince);
    const sentTier = task.lastReminderAt ? tierForDays(daysBetween(task.activatedAt, task.lastReminderAt)) : 0;

    if (dueTier > sentTier) {
      const sent = await sendCustomerReminder({ task, customer, portalUrl, tier: dueTier, daysSince, dryRun });
      if (sent) actions.push(sent);
    }

    // Track 2 — independent of whether the tier-3 reminder above fired this
    // pass; escalatedAt is the sole gate, so a prior failed send retries.
    if (dueTier >= FINAL_TIER && task.escalatedAt === null && customer.type === 'D2C') {
      const escalated = await sendD2CEscalation({ task, customer, portalUrl, daysSince, dryRun });
      if (escalated) actions.push(escalated);
    }
  }

  return actions;
}

async function sendCustomerReminder(params: {
  task: TaskRow;
  customer: CustomerRow;
  portalUrl: string;
  tier: number;
  daysSince: number;
  dryRun: boolean;
}): Promise<DropoffAction | null> {
  const { task, customer, portalUrl, tier, daysSince, dryRun } = params;
  const isFinalReminder = tier >= FINAL_TIER;
  const base = {
    customerId: customer.id,
    customerName: customer.name,
    taskId: task.id,
    taskName: task.taskName,
    to: customer.contactEmail,
    tier,
    daysStalled: daysSince,
    isFinalReminder,
    instructions: task.instructions,
    portalUrl,
  } as const;

  if (dryRun) return { kind: 'customer-reminder', ...base };

  // Race guard — the customer may have acted between the query and now.
  const fresh = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, task.id),
    columns: { status: true },
  });
  if (!fresh || fresh.status !== 'Active') return null;

  try {
    await sendEmail({
      template: 'dropoff-reminder-customer',
      to: customer.contactEmail,
      subject: `Reminder: ${task.taskName}`,
      data: {
        firstName: firstName(customer.name),
        taskName: task.taskName,
        instructions: task.instructions,
        portalUrl,
        isFinalReminder,
      },
    });
  } catch (err) {
    console.error(`[dropoffReminders] customer reminder send failed for task ${task.id}:`, err);
    return null;
  }

  await db.update(schema.tasks).set({ lastReminderAt: new Date() }).where(eq(schema.tasks.id, task.id));
  await logEvent(customer.id, 'Dropoff Reminder Sent', task.id, `Reminder ${tier}/${FINAL_TIER} sent to ${customer.contactEmail} for "${task.taskName}".`);

  return { kind: 'customer-reminder', ...base };
}

async function sendD2CEscalation(params: {
  task: TaskRow;
  customer: CustomerRow;
  portalUrl: string;
  daysSince: number;
  dryRun: boolean;
}): Promise<DropoffAction | null> {
  const { task, customer, portalUrl, daysSince, dryRun } = params;
  // No deal-owner captured on this customer (pre-dates the closedwon
  // integration, or admin-created) — fall back to the shared sales inbox
  // rather than silently dropping the escalation. Same "Hey {email}" greeting,
  // just a general address instead of a specific rep.
  const escalateTo = customer.salesRepEmail ?? D2C_ESCALATION_FALLBACK_TO;

  const base = {
    customerId: customer.id,
    customerName: customer.name,
    customerEmail: customer.contactEmail,
    taskId: task.id,
    taskName: task.taskName,
    to: escalateTo,
    cc: D2C_ESCALATION_CC,
    daysStalled: daysSince,
    portalUrl,
  } as const;

  if (dryRun) return { kind: 'customer-escalation', ...base };

  const fresh = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, task.id),
    columns: { status: true, escalatedAt: true },
  });
  if (!fresh || fresh.status !== 'Active' || fresh.escalatedAt !== null) return null;

  try {
    await sendEmail({
      template: 'dropoff-escalation-salesrep',
      to: escalateTo,
      cc: D2C_ESCALATION_CC,
      subject: `${customer.name} could use a nudge`,
      data: {
        salesRepEmail: escalateTo,
        customerName: customer.name,
        customerEmail: customer.contactEmail,
        taskName: task.taskName,
        daysStalled: daysSince,
        portalUrl,
      },
    });
  } catch (err) {
    console.error(`[dropoffReminders] D2C escalation send failed for task ${task.id}:`, err);
    return null;
  }

  await db.update(schema.tasks).set({ escalatedAt: new Date() }).where(eq(schema.tasks.id, task.id));
  await logEvent(customer.id, 'Dropoff Escalated', task.id, `Escalated to ${escalateTo} for "${task.taskName}" (${daysSince}d stalled).`);

  return { kind: 'customer-escalation', ...base };
}

// ─── Track 5 (team reminder + internal escalation) ─────────────────────────

async function runTeamTrack(now: Date, portalBase: string, dryRun: boolean): Promise<DropoffAction[]> {
  const rows = await db
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

  const actions: DropoffAction[] = [];

  for (const { task, customer, assignee } of rows) {
    if (!task.activatedAt) continue;
    if (task.activatedAt < ROLLOUT_CUTOFF_DATE) continue; // pre-existing backlog, grandfathered out
    const daysSince = daysBetween(task.activatedAt, now);
    if (daysSince < REMINDER_TIER_DAYS[0]) continue;

    if (customer.createdVia === 'backfill') continue;
    if (customer.environment?.includes('test')) continue;

    const workspaceUrl = `${portalBase}/workspace/customers/${customer.id}`;
    const dueTier = tierForDays(daysSince);
    const sentTier = task.lastReminderAt ? tierForDays(daysBetween(task.activatedAt, task.lastReminderAt)) : 0;

    // Assignee nudge needs a real, active, non-CSM-only assignee — mirrors
    // notify-assignee.ts's exclusions (CSM lifecycle lives entirely in HubSpot).
    const nudgeable =
      assignee !== null
      && assignee.active
      && !(assignee.roles.length === 1 && assignee.roles[0] === 'CSM');
    if (nudgeable && dueTier > sentTier) {
      const sent = await sendTeamReminder({ task, customer, assignee: assignee as TeamMemberRow, workspaceUrl, tier: dueTier, daysSince, dryRun });
      if (sent) actions.push(sent);
    }

    // Ops-trio escalation — fires regardless of whether there was ever an
    // assignee to nudge; excludes vendor-wait tasks (see module header).
    if (
      dueTier >= FINAL_TIER
      && task.escalatedAt === null
      && !VENDOR_WAIT_ESCALATION_EXCLUSIONS.has(task.taskName)
    ) {
      const escalated = await sendTeamEscalation({
        task,
        customer,
        assigneeName: assignee?.name ?? 'unassigned',
        workspaceUrl,
        daysSince,
        dryRun,
      });
      if (escalated) actions.push(escalated);
    }
  }

  return actions;
}

async function sendTeamReminder(params: {
  task: TaskRow;
  customer: CustomerRow;
  assignee: TeamMemberRow;
  workspaceUrl: string;
  tier: number;
  daysSince: number;
  dryRun: boolean;
}): Promise<DropoffAction | null> {
  const { task, customer, assignee, workspaceUrl, tier, daysSince, dryRun } = params;
  const isFinalReminder = tier >= FINAL_TIER;
  const base = {
    customerId: customer.id,
    customerName: customer.name,
    taskId: task.id,
    taskName: task.taskName,
    to: assignee.email,
    tier,
    daysStalled: daysSince,
    isFinalReminder,
    instructions: task.instructions,
    workspaceUrl,
  } as const;

  if (dryRun) return { kind: 'team-reminder', ...base };

  const fresh = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, task.id),
    columns: { status: true },
  });
  if (!fresh || fresh.status !== 'Active') return null;

  try {
    await sendEmail({
      template: 'dropoff-reminder-team',
      to: assignee.email,
      subject: `Still open: ${task.taskName} for ${customer.name}`,
      data: {
        firstName: firstName(assignee.name),
        taskName: task.taskName,
        customerName: customer.name,
        instructions: task.instructions,
        workspaceUrl,
        isFinalReminder,
      },
    });
  } catch (err) {
    console.error(`[dropoffReminders] team reminder send failed for task ${task.id}:`, err);
    return null;
  }

  await db.update(schema.tasks).set({ lastReminderAt: new Date() }).where(eq(schema.tasks.id, task.id));
  await logEvent(customer.id, 'Dropoff Reminder Sent', task.id, `Reminder ${tier}/${FINAL_TIER} sent to ${assignee.email} for "${task.taskName}".`);

  return { kind: 'team-reminder', ...base };
}

async function sendTeamEscalation(params: {
  task: TaskRow;
  customer: CustomerRow;
  assigneeName: string;
  workspaceUrl: string;
  daysSince: number;
  dryRun: boolean;
}): Promise<DropoffAction | null> {
  const { task, customer, assigneeName, workspaceUrl, daysSince, dryRun } = params;
  const base = {
    customerId: customer.id,
    customerName: customer.name,
    taskId: task.id,
    taskName: task.taskName,
    to: OPS_ESCALATION_TO,
    cc: OPS_ESCALATION_CC,
    assigneeName,
    daysStalled: daysSince,
    workspaceUrl,
  } as const;

  if (dryRun) return { kind: 'team-escalation', ...base };

  const fresh = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, task.id),
    columns: { status: true, escalatedAt: true },
  });
  if (!fresh || fresh.status !== 'Active' || fresh.escalatedAt !== null) return null;

  try {
    await sendEmail({
      template: 'dropoff-escalation-team',
      to: OPS_ESCALATION_TO,
      cc: OPS_ESCALATION_CC,
      subject: `Internal task stuck: ${task.taskName} for ${customer.name}`,
      data: {
        taskName: task.taskName,
        customerName: customer.name,
        assigneeName,
        daysStalled: daysSince,
        workspaceUrl,
      },
    });
  } catch (err) {
    console.error(`[dropoffReminders] team escalation send failed for task ${task.id}:`, err);
    return null;
  }

  await db.update(schema.tasks).set({ escalatedAt: new Date() }).where(eq(schema.tasks.id, task.id));
  await logEvent(customer.id, 'Dropoff Escalated', task.id, `Escalated internally for "${task.taskName}" (assignee: ${assigneeName}, ${daysSince}d stalled).`);

  return { kind: 'team-escalation', ...base };
}

function skip(task: TaskRow, customer: CustomerRow, reason: string): DropoffAction {
  return {
    kind: 'skipped',
    customerId: customer.id,
    customerName: customer.name,
    taskId: task.id,
    taskName: task.taskName,
    reason,
  };
}
