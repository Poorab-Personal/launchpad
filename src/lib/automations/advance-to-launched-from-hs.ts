import { db } from '@/db';
import * as schema from '@/db/schema';
import { and, eq, inArray } from 'drizzle-orm';

/**
 * HS-authoritative Launched advancement.
 *
 * The LP D2C/B2B flows assume a sign-in-then-meeting order: the customer
 * signs in via the LP portal, which completes "Sign In & Reset Password"
 * and trips currentStage → Launched. In reality the meeting often happens
 * first (HS ticket → Active) and the customer never bothers signing in
 * through LP — so they stay stuck at "Prepare for Onboarding" forever.
 *
 * This helper is fired from the HS ticket-stage webhook on stage → Active.
 * If the customer is at the terminal pre-launch stage AND has been issued
 * credentials, we treat HS Active as authoritative: complete the residual
 * client tasks and flip currentStage to Launched. Bypasses
 * handleTaskCompleted (which would push HS backward to "Onboarding
 * Scheduled" — HS is already past that).
 *
 * Idempotent: re-runs after Launched are race-guarded by the conditional
 * UPDATE on currentStage = 'Prepare for Onboarding'.
 */

export type AdvanceResult =
  | { kind: 'advanced'; completedTaskIds: string[] }
  | { kind: 'skipped'; reason: string };

const TERMINAL_CLIENT_TASKS = [
  'Sign In & Reset Password',
  'Watch Setup Video',
];

export async function advanceToLaunchedFromHsActive(
  customerId: string,
  source: 'hs-webhook' | 'backfill',
): Promise<AdvanceResult> {
  const customer = await db.query.customers.findFirst({
    where: eq(schema.customers.id, customerId),
    columns: {
      id: true,
      currentStage: true,
      accountCreated: true,
      workflowKey: true,
    },
  });

  if (!customer) return { kind: 'skipped', reason: 'customer not found' };
  if (customer.currentStage === 'Launched') return { kind: 'skipped', reason: 'already Launched' };
  if (customer.currentStage !== 'Prepare for Onboarding') {
    return { kind: 'skipped', reason: `currentStage="${customer.currentStage}" — only advance from "Prepare for Onboarding"` };
  }
  if (!customer.accountCreated) {
    return { kind: 'skipped', reason: 'accountCreated=false — credentials not issued, refusing to auto-launch' };
  }

  const completedTaskIds: string[] = [];

  await db.transaction(async (tx) => {
    const completed = await tx
      .update(schema.tasks)
      .set({ status: 'Completed', completedAt: new Date() })
      .where(and(
        eq(schema.tasks.customerId, customerId),
        eq(schema.tasks.status, 'Active'),
        eq(schema.tasks.visibleToClient, true),
        inArray(schema.tasks.taskName, TERMINAL_CLIENT_TASKS),
      ))
      .returning({ id: schema.tasks.id, taskName: schema.tasks.taskName });

    for (const t of completed) {
      completedTaskIds.push(t.id);
      await tx.insert(schema.events).values({
        customerId,
        eventType: 'Task Completed',
        actorType: 'System',
        details: `Task "${t.taskName}" auto-completed via HS stage → Active (${source}).`,
        relatedTaskId: t.id,
      });
    }

    const advanced = await tx
      .update(schema.customers)
      .set({ currentStage: 'Launched', stageEnteredAt: new Date() })
      .where(and(
        eq(schema.customers.id, customerId),
        eq(schema.customers.currentStage, 'Prepare for Onboarding'),
      ))
      .returning({ id: schema.customers.id });

    if (advanced.length > 0) {
      await tx.insert(schema.events).values({
        customerId,
        eventType: 'Stage Changed',
        actorType: 'System',
        details: `[Core] Advanced from "Prepare for Onboarding" to "Launched" via HS stage → Active (${source}).`,
      });
    }
  });

  return { kind: 'advanced', completedTaskIds };
}
