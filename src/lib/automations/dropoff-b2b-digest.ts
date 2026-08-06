/**
 * B2B weekly drop-off digest — Tracks 3, 4 of docs/plans/dropoff-reminder-cron.md.
 *
 * No per-customer real-time escalation for B2B (Track 2 is D2C-only) —
 * instead a weekly summary table, grouped by brokerage + stuck task,
 * bucketed by which reminder tier the customer is in (day 2/5/8+).
 * Stateless/derived, same philosophy as daily-checks: a customer still
 * stuck next Sunday just reappears in the table, no dedupe tracking needed.
 *
 * Track 4 (card saved, call not booked — the "hot" case) isn't a separate
 * code path: it's detected the same way as everything else, purely from
 * state (workflow paymentMode = setup-intent-at-intake AND the stuck task
 * is "Schedule Your Onboarding Call", which is dependency-gated on Capture
 * Payment Method already being Completed) and just flagged so the digest
 * renderer can highlight the row.
 *
 * Go-forward only (per 2026-08-06 decision, same as dropoff-reminders.ts):
 * tasks activated before ROLLOUT_CUTOFF_DATE are excluded — the pre-existing
 * B2B backlog doesn't appear in this digest either.
 */
import { and, eq, ne } from 'drizzle-orm';
import { db } from '@/db';
import * as schema from '@/db/schema';

const REMINDER_TIER_DAYS = [2, 5, 8] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

// Same go-forward cutoff as dropoff-reminders.ts (kept in sync — both must
// agree on what counts as "pre-existing backlog" vs. a real new stall).
const ROLLOUT_CUTOFF_DATE = new Date('2026-08-06T00:00:00Z');

export type B2BDigestRow = {
  customerId: string;
  customerName: string;
  contactEmail: string;
  brokerageName: string;
  workflowKey: string;
  taskName: string;
  daysStalled: number;
  tier: number; // 1, 2, or 3 (capped — matches the day 2/5/8 reminder tiers)
  isHotCase: boolean; // card saved, call not booked
};

export type B2BDigestResult = {
  rows: B2BDigestRow[];
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

export async function computeB2BDropoffDigest(): Promise<B2BDigestResult> {
  const t0 = Date.now();
  const now = new Date();

  const rows = await db
    .select({
      task: schema.tasks,
      customer: schema.customers,
      brokerageName: schema.brokerages.name,
    })
    .from(schema.tasks)
    .innerJoin(schema.customers, eq(schema.tasks.customerId, schema.customers.id))
    .leftJoin(schema.brokerages, eq(schema.customers.brokerageId, schema.brokerages.id))
    .where(
      and(
        eq(schema.tasks.taskType, 'Client'),
        eq(schema.tasks.visibleToClient, true),
        eq(schema.tasks.status, 'Active'),
        eq(schema.customers.type, 'B2B'),
        ne(schema.customers.currentStage, 'Launched'),
      ),
    );

  // Payment mode is denormalized onto every workflow_templates row sharing
  // a workflow_key (payment-mode plan, shipped) — any one row per key gives
  // the value, so a distinct pull is enough for the lookup map.
  const templateRows = await db
    .selectDistinct({
      workflowKey: schema.workflowTemplates.workflowKey,
      paymentMode: schema.workflowTemplates.paymentMode,
    })
    .from(schema.workflowTemplates);
  const paymentModeByWorkflow = new Map(templateRows.map((t) => [t.workflowKey, t.paymentMode]));

  const digestRows: B2BDigestRow[] = [];
  for (const { task, customer, brokerageName } of rows) {
    if (!task.activatedAt) continue; // defensive — Active tasks should always have this
    if (task.activatedAt < ROLLOUT_CUTOFF_DATE) continue; // pre-existing backlog, grandfathered out
    const daysSince = daysBetween(task.activatedAt, now);
    if (daysSince < REMINDER_TIER_DAYS[0]) continue; // not stalled yet

    if (customer.createdVia === 'backfill') continue;
    if (customer.environment?.includes('test')) continue;

    const tier = tierForDays(daysSince);
    const isHotCase =
      task.taskName === 'Schedule Your Onboarding Call'
      && paymentModeByWorkflow.get(customer.workflowKey) === 'setup-intent-at-intake';

    digestRows.push({
      customerId: customer.id,
      customerName: customer.name,
      contactEmail: customer.contactEmail,
      brokerageName: brokerageName ?? customer.workflowKey,
      workflowKey: customer.workflowKey,
      taskName: task.taskName,
      daysStalled: daysSince,
      tier,
      isHotCase,
    });
  }

  // Hot cases first, then longest-stalled first within each group.
  digestRows.sort((a, b) => {
    if (a.isHotCase !== b.isHotCase) return a.isHotCase ? -1 : 1;
    return b.daysStalled - a.daysStalled;
  });

  return { rows: digestRows, durationMs: Date.now() - t0 };
}
