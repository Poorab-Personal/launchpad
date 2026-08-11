/**
 * Monthly B2B cohort digest — "who signed up last month, and how far did
 * they get?"
 *
 * Runs on the 2nd of each month and reports the PRIOR month's new B2B
 * signups per brokerage, with a date against every funnel milestone they
 * reached. Replaces the manual funnel-audit run (scripts/funnel-audit.ts)
 * for the recurring monthly review.
 *
 * Differences from the funnel-audit script, and why:
 *
 *  1. Cohort-scoped, not point-in-time. funnel-audit reports EVERY customer
 *     on a workflow, which for B&W means 227 backfilled legacy rows drowning
 *     out the handful of real new signups. This reports only rows created
 *     inside the month.
 *
 *  2. Per-milestone DATES, not just the furthest bucket. The monthly review
 *     wants "submitted 7/11, booked 7/11, call 7/20", not "Booked".
 *
 *  3. Truthful onboarded gate. funnel-audit's 'stage' rule marks a customer
 *     Onboarded the moment currentStage advances, which happens right after
 *     Schedule completes — i.e. before the call has actually happened. Here,
 *     a call-gated workflow is Onboarded only once the call date has passed.
 *
 * Milestones auto-derive from `workflow_templates` (Stage 1, client-visible,
 * in task order), so a new brokerage is picked up with no code change.
 *
 * Scope note: LaunchPad data only. Someone who was onboarded entirely
 * outside LP — a HubSpot Customer Journey ticket with no LP customer row —
 * will NOT appear here. That gap is real (one such case in June 2026); a
 * HubSpot cross-check was considered and deliberately deferred.
 *
 * Stateless/derived, same philosophy as daily-checks: no "reported" flag,
 * no persistence. Re-running for a past month reproduces the same report.
 */
import { and, asc, eq, gte, inArray, lt, like, sql } from 'drizzle-orm';
import { db } from '@/db';
import * as schema from '@/db/schema';

/**
 * Timezone used to decide which calendar month a signup falls in.
 *
 * A single constant rather than per-brokerage local time: the brokerages
 * span Central (B&W, Ruhl) and Eastern (Keyes, IPRE), and the only rows
 * affected are those created within a couple of hours of midnight on the
 * 1st. Documented here so a boundary case is explainable rather than
 * mysterious.
 */
export const REPORT_TIMEZONE = 'America/Chicago';

/**
 * Display labels for milestone task titles.
 *
 * The live task titles are customer-facing imperatives ("Capture Payment
 * Method"); a report wants the past-tense state ("Card saved"). Unmapped
 * titles fall back to the raw title and are surfaced in `unmappedMilestones`
 * so a new brokerage's odd task name is visible rather than silently ugly.
 *
 * Mirrors scripts/funnel-audit-labels.ts. Kept as a separate copy on
 * purpose: scripts/ is excluded from the Next build (see tsconfig), so
 * src/ cannot import from it.
 */
const MILESTONE_LABELS: Record<string, string> = {
  'Confirm Your Information': 'Submitted',
  'Capture Payment Method': 'Card saved',
  'Schedule Your Onboarding Call': 'Booked',
};

const STARTED_LABEL = 'Started';
const ONBOARDED_LABEL = 'Onboarded';

/**
 * How "Onboarded" is detected per workflow.
 *
 *  - 'subscription' — a Stripe sub exists. For Keyes/IPRE the trial sub is
 *    created when the HubSpot ticket flips to Active, which only happens
 *    post-meeting, so the sub is a reliable "the meeting happened" signal.
 *  - 'call-held'    — the first onboarding call's scheduled date is in the
 *    past. For B&W there is no per-agent Stripe sub (brokerage-paid), so
 *    there is no billing signal to key off.
 *  - 'signed-in'    — the Sign In & Reset Password task completed. Ruhl's
 *    flow has no onboarding call at all (design + account creation only),
 *    so 'call-held' could never fire and nobody would ever count as
 *    onboarded. Sign-in is that flow's terminal state — LaunchPad's
 *    definition of Launched.
 *
 * Default for an unlisted workflow: 'subscription'.
 */
const ONBOARDED_RULE: Record<string, 'subscription' | 'call-held' | 'signed-in'> = {
  'B2B-IPRE': 'subscription',
  'B2B-Keyes': 'subscription',
  'B2B-BW': 'call-held',
  'B2B-RUHL': 'signed-in',
};

/** Tasks read for post-funnel context, beyond the Stage 1 milestones. */
const CREDENTIALS_TASK = 'Send Credentials';
const SIGN_IN_TASK = 'Sign In & Reset Password';

export type CohortMilestone = {
  taskTitle: string;
  label: string;
  completedAt: Date | null;
};

export type CohortRow = {
  customerId: string;
  customerName: string;
  contactEmail: string;
  phone: string | null;
  officeName: string | null;
  startedAt: Date;
  milestones: CohortMilestone[];
  /** Earliest onboarding call on file. Future date = booked but not yet held. */
  callDate: Date | null;
  callHeld: boolean;
  /** More than one onboarding call — a reschedule or a follow-up. */
  extraCallDate: Date | null;
  credentialsSentAt: Date | null;
  signedInAt: Date | null;
  /** Furthest bucket reached: 'Started' | <milestone label> | 'Onboarded'. */
  stage: string;
  subscriptionStatus: string | null;
  /** Call has happened but the HubSpot ticket never flipped to Active. */
  hsOutcomeMissing: boolean;
  /** This email already had a customer row predating the month. */
  isReturning: boolean;
  hubspotTicketId: string | null;
};

export type BrokerageCohort = {
  brokerageName: string;
  workflowKey: string;
  /** Bucket labels in funnel order, for rendering the counts table. */
  funnelLabels: string[];
  /** Cumulative count reaching each bucket, index-aligned to funnelLabels. */
  funnelCounts: number[];
  rows: CohortRow[];
};

export type MonthlyCohortResult = {
  /** 'YYYY-MM' */
  month: string;
  /** e.g. 'July 2026' */
  monthLabel: string;
  cohorts: BrokerageCohort[];
  totalNew: number;
  unmappedMilestones: string[];
  durationMs: number;
};

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The calendar month before `now` in REPORT_TIMEZONE, as 'YYYY-MM'. */
export function previousMonth(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD, so the slice is a stable way to read the
  // wall-clock date in the reporting timezone without a date library.
  const local = new Intl.DateTimeFormat('en-CA', {
    timeZone: REPORT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const [y, m] = local.split('-').map(Number);
  const prevMonth = m === 1 ? 12 : m - 1;
  const prevYear = m === 1 ? y - 1 : y;
  return `${prevYear}-${String(prevMonth).padStart(2, '0')}`;
}

function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/**
 * Month boundary as an absolute instant, interpreting midnight on the 1st
 * as local time in REPORT_TIMEZONE.
 *
 * sql.raw is safe here: `month` is regex-validated against MONTH_RE by the
 * caller and REPORT_TIMEZONE is a module constant — neither is user input.
 * Parameter binding can't be used because Postgres rejects `timestamp $1`.
 */
function monthBoundary(month: string) {
  return sql.raw(`(timestamp '${month}-01 00:00:00' at time zone '${REPORT_TIMEZONE}')`);
}

export async function computeMonthlyCohort(
  opts: { month?: string } = {},
): Promise<MonthlyCohortResult> {
  const t0 = Date.now();
  const month = opts.month ?? previousMonth();
  if (!MONTH_RE.test(month)) {
    throw new Error(`Invalid month '${month}' — expected YYYY-MM`);
  }
  const windowStart = monthBoundary(month);
  const windowEnd = monthBoundary(nextMonth(month));
  const now = new Date();

  // 1. B2B brokerages. Ordered by name so the email section order is stable
  //    month to month.
  const brokerageRows = await db
    .select({
      name: schema.brokerages.name,
      workflowKey: schema.brokerages.defaultWorkflowKey,
    })
    .from(schema.brokerages)
    .where(like(schema.brokerages.defaultWorkflowKey, 'B2B-%'))
    .orderBy(asc(schema.brokerages.name));

  const workflowKeys = brokerageRows.map((b) => b.workflowKey).filter(Boolean) as string[];
  if (workflowKeys.length === 0) {
    return {
      month,
      monthLabel: monthLabel(month),
      cohorts: [],
      totalNew: 0,
      unmappedMilestones: [],
      durationMs: Date.now() - t0,
    };
  }

  // 2. Funnel milestones per workflow: Stage 1, client-visible, in order.
  const templateRows = await db
    .select({
      workflowKey: schema.workflowTemplates.workflowKey,
      taskTitle: schema.workflowTemplates.taskTitle,
      taskOrder: schema.workflowTemplates.taskOrder,
    })
    .from(schema.workflowTemplates)
    .where(
      and(
        inArray(schema.workflowTemplates.workflowKey, workflowKeys),
        eq(schema.workflowTemplates.stageOrder, 1),
        eq(schema.workflowTemplates.visibleToClient, true),
      ),
    )
    .orderBy(asc(schema.workflowTemplates.taskOrder));

  const milestonesByWorkflow = new Map<string, string[]>();
  for (const t of templateRows) {
    const arr = milestonesByWorkflow.get(t.workflowKey) ?? [];
    arr.push(t.taskTitle);
    milestonesByWorkflow.set(t.workflowKey, arr);
  }

  const unmapped = new Set<string>();
  const labelFor = (taskTitle: string) => {
    const label = MILESTONE_LABELS[taskTitle];
    if (!label) {
      unmapped.add(taskTitle);
      return taskTitle;
    }
    return label;
  };

  // 3. Customers created inside the month, with their roster office.
  const customerRows = await db
    .select({
      id: schema.customers.id,
      name: schema.customers.name,
      contactEmail: schema.customers.contactEmail,
      phone: schema.customers.phone,
      workflowKey: schema.customers.workflowKey,
      createdAt: schema.customers.createdAt,
      onboardingState: schema.customers.onboardingState,
      subscriptionStatus: schema.customers.subscriptionStatus,
      hubspotTicketId: schema.customers.hubspotTicketId,
      environment: schema.customers.environment,
      officeName: schema.brokerageRoster.officeName,
      rosterFirstName: schema.brokerageRoster.firstName,
      rosterLastName: schema.brokerageRoster.lastName,
    })
    .from(schema.customers)
    .leftJoin(
      schema.brokerageRoster,
      sql`lower(coalesce(${schema.brokerageRoster.publicEmail}, ${schema.brokerageRoster.privateEmail})) = lower(${schema.customers.contactEmail})`,
    )
    .where(
      and(
        inArray(schema.customers.workflowKey, workflowKeys),
        gte(schema.customers.createdAt, windowStart),
        lt(schema.customers.createdAt, windowEnd),
      ),
    )
    .orderBy(asc(schema.customers.createdAt));

  // Test-env rows never belong in a business report.
  const cohortCustomers = customerRows.filter(
    (c) => !(c.environment ?? []).includes('test'),
  );
  const customerIds = cohortCustomers.map((c) => c.id);

  // 4. Tasks + calls + prior rows for the cohort, one query each.
  const taskRows = customerIds.length
    ? await db
        .select({
          customerId: schema.tasks.customerId,
          taskName: schema.tasks.taskName,
          completedAt: schema.tasks.completedAt,
        })
        .from(schema.tasks)
        .where(inArray(schema.tasks.customerId, customerIds))
    : [];

  const callRows = customerIds.length
    ? await db
        .select({
          customerId: schema.calls.customerId,
          scheduledDate: schema.calls.scheduledDate,
        })
        .from(schema.calls)
        .where(
          and(
            inArray(schema.calls.customerId, customerIds),
            eq(schema.calls.type, 'Onboarding'),
          ),
        )
        .orderBy(asc(schema.calls.scheduledDate))
    : [];

  // A returning customer is one whose email already had a row before this
  // month — an existing customer re-entering the flow, not a new signup.
  // Worth flagging: it inflates the cohort and reads as a false drop-off.
  const emails = cohortCustomers.map((c) => c.contactEmail.toLowerCase());
  const priorRows = emails.length
    ? await db
        .select({ contactEmail: schema.customers.contactEmail })
        .from(schema.customers)
        .where(
          and(
            inArray(sql`lower(${schema.customers.contactEmail})`, emails),
            lt(schema.customers.createdAt, windowStart),
          ),
        )
    : [];
  const returningEmails = new Set(priorRows.map((r) => r.contactEmail.toLowerCase()));

  const tasksByCustomer = new Map<string, Map<string, Date | null>>();
  for (const t of taskRows) {
    const m = tasksByCustomer.get(t.customerId) ?? new Map();
    m.set(t.taskName, t.completedAt);
    tasksByCustomer.set(t.customerId, m);
  }

  const callsByCustomer = new Map<string, Date[]>();
  for (const c of callRows) {
    const arr = callsByCustomer.get(c.customerId) ?? [];
    arr.push(c.scheduledDate);
    callsByCustomer.set(c.customerId, arr);
  }

  // 5. Assemble one cohort per brokerage.
  const cohorts: BrokerageCohort[] = [];
  for (const brokerage of brokerageRows) {
    const workflowKey = brokerage.workflowKey;
    if (!workflowKey) continue;

    const milestoneTitles = milestonesByWorkflow.get(workflowKey) ?? [];
    const milestoneLabels = milestoneTitles.map(labelFor);
    const rule = ONBOARDED_RULE[workflowKey] ?? 'subscription';

    const rows: CohortRow[] = cohortCustomers
      .filter((c) => c.workflowKey === workflowKey)
      .map((c) => {
        const taskMap = tasksByCustomer.get(c.id) ?? new Map<string, Date | null>();
        const milestones: CohortMilestone[] = milestoneTitles.map((title, i) => ({
          taskTitle: title,
          label: milestoneLabels[i],
          completedAt: taskMap.get(title) ?? null,
        }));

        const calls = callsByCustomer.get(c.id) ?? [];
        const callDate = calls[0] ?? null;
        const extraCallDate = calls.length > 1 ? calls[calls.length - 1] : null;
        const callHeld = !!callDate && callDate < now;

        const signedInAt = taskMap.get(SIGN_IN_TASK) ?? null;
        const onboarded =
          rule === 'subscription'
            ? !!c.subscriptionStatus
            : rule === 'signed-in'
              ? !!signedInAt
              : callHeld;

        // Furthest milestone reached, walking the funnel in order so a
        // skipped-but-later-completed task can't overstate progress.
        let stage = STARTED_LABEL;
        for (const m of milestones) {
          if (!m.completedAt) break;
          stage = m.label;
        }
        if (onboarded) stage = ONBOARDED_LABEL;

        const displayName =
          c.name?.trim() ||
          [c.rosterFirstName, c.rosterLastName].filter(Boolean).join(' ').trim() ||
          c.contactEmail;

        return {
          customerId: c.id,
          customerName: displayName,
          contactEmail: c.contactEmail,
          phone: c.phone,
          officeName: c.officeName,
          startedAt: c.createdAt,
          milestones,
          callDate,
          callHeld,
          extraCallDate,
          credentialsSentAt: taskMap.get(CREDENTIALS_TASK) ?? null,
          signedInAt,
          stage,
          subscriptionStatus: c.subscriptionStatus,
          // Still sitting in 'Onboarding Scheduled' after the call date
          // means the CSM never marked the meeting outcome — the same gap
          // daily-checks surfaces. Tested against that exact state rather
          // than `!== 'Active'`, because onboardingState legitimately moves
          // PAST Active into the post-launch lifecycle (Watch, At-Risk),
          // and those must not read as a missing outcome.
          hsOutcomeMissing: callHeld && c.onboardingState === 'Onboarding Scheduled',
          isReturning: returningEmails.has(c.contactEmail.toLowerCase()),
          hubspotTicketId: c.hubspotTicketId,
        };
      });

    // Cumulative funnel: reaching a later bucket implies the earlier ones.
    const funnelLabels = [STARTED_LABEL, ...milestoneLabels, ONBOARDED_LABEL];
    const funnelCounts = funnelLabels.map((label, i) => {
      if (i === 0) return rows.length;
      if (i === funnelLabels.length - 1) {
        return rows.filter((r) => r.stage === ONBOARDED_LABEL).length;
      }
      return rows.filter((r) => r.milestones[i - 1]?.completedAt).length;
    });

    cohorts.push({
      brokerageName: brokerage.name,
      workflowKey,
      funnelLabels,
      funnelCounts,
      rows,
    });
  }

  return {
    month,
    monthLabel: monthLabel(month),
    cohorts,
    totalNew: cohortCustomers.length,
    unmappedMilestones: [...unmapped],
    durationMs: Date.now() - t0,
  };
}
