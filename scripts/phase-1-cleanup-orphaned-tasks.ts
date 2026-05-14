/**
 * Phase 1 cleanup — auto-complete post-launch tasks on existing customers
 * whose templates were deleted by migration 0006_post_launch_truncate.sql.
 *
 * See docs/plans/post-launch-migration.md (Phase 1.5).
 *
 * What this script does, per-customer (in a single transaction):
 *  1. Find any non-Completed task whose name is in DELETED_TASK_NAMES.
 *  2. Mark each Completed with notes='Auto-completed during post-launch migration ...'.
 *  3. Delete task_dependencies rows referencing those task IDs (both directions).
 *  4. If customer.currentStage IS one of the deleted stages → advance to 'Launched'.
 *  5. If customer is on a setup-intent-at-intake workflow (B2B-Keyes) AND being
 *     advanced to Launched AND no stripeSubscriptionId yet → invoke the trial
 *     subscription creation flow. Idempotent on the Stripe side. This is the
 *     "in-flight customer Stripe rescue" called out in plan Q6.
 *  6. Insert an `events` row summarizing the cleanup for audit.
 *
 * Important:
 *  - Bypasses Auto 2 (raw db.update). The tasks have no dependents to activate
 *    because their templates are gone.
 *  - Only touches Core product tasks (product='Core'). Voice/Avatar add-on tasks
 *    are untouched.
 *  - Idempotent on re-run (skips already-Completed tasks).
 *
 * Usage:
 *   # Dry-run against all matching customers (default):
 *   npx tsx scripts/phase-1-cleanup-orphaned-tasks.ts
 *
 *   # Dry-run against specific customers:
 *   npx tsx scripts/phase-1-cleanup-orphaned-tasks.ts --customer-id=<uuid> --customer-id=<uuid>
 *
 *   # Apply for real:
 *   npx tsx scripts/phase-1-cleanup-orphaned-tasks.ts --apply
 *   npx tsx scripts/phase-1-cleanup-orphaned-tasks.ts --apply --customer-id=<uuid>
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const DELETED_TASK_NAMES = [
  'Mark Onboarding Call Complete',
  'Send Zoom Recording',
  'Send Follow-Up Email',
  'Provide Onboarding Feedback',
  'Schedule Check-In 1',
  'Schedule Check-In 2',
] as const;

const DELETED_STAGES = [
  'Onboarding Call',
  'Post Onboarding',
  'Review & Grow',
] as const;

const NOTES_STAMP = 'Auto-completed during post-launch migration 2026-05-14 (Phase 1)';

type CustomerCleanupPlan = {
  customerId: string;
  customerName: string;
  workflowKey: string;
  currentStage: string;
  hasStripeSubAlready: boolean;
  tasksToComplete: { id: string; name: string; status: string }[];
  taskDependenciesToDelete: number;
  stageAdvance: { from: string; to: 'Launched' } | null;
  trialSubAction: 'create' | 'skip-not-keyes' | 'skip-already-has-sub' | 'skip-not-advancing' | null;
};

function parseArgs() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const customerIds = args
    .filter((a) => a.startsWith('--customer-id='))
    .map((a) => a.replace('--customer-id=', '').trim());
  return { apply, customerIds };
}

async function main() {
  const { apply, customerIds } = parseArgs();

  const { db } = await import('../src/db');
  const { customers } = await import('../src/db/schema/customers');
  const { tasks, taskDependencies } = await import('../src/db/schema/tasks');
  const { events } = await import('../src/db/schema/events');
  const { and, eq, inArray, ne, or, sql } = await import('drizzle-orm');
  const { createTrialSubscriptionForCustomer } = await import('../src/lib/automations/handle-call-completed');

  console.log(`\n${'='.repeat(72)}`);
  console.log(`Phase 1 cleanup — ${apply ? 'APPLY (LIVE WRITE)' : 'DRY RUN'}`);
  console.log(`${'='.repeat(72)}`);
  if (customerIds.length > 0) {
    console.log(`Limited to customer IDs: ${customerIds.join(', ')}`);
  } else {
    console.log('Scope: all customers with non-Completed Core tasks in the deleted set');
  }
  console.log();

  // Find candidate customers: those with at least one non-Completed task
  // whose task_name is in the deleted list, for product='Core'.
  const candidateRows = await db
    .selectDistinct({ customerId: tasks.customerId })
    .from(tasks)
    .where(
      and(
        inArray(tasks.taskName, DELETED_TASK_NAMES as unknown as string[]),
        ne(tasks.status, 'Completed'),
        eq(tasks.product, 'Core'),
      ),
    );

  let candidateIds = candidateRows.map((r) => r.customerId);
  if (customerIds.length > 0) {
    candidateIds = candidateIds.filter((id) => customerIds.includes(id));
  }

  // Also include customers with their current_stage in deleted stages but
  // no remaining tasks (edge case — already manually completed but stage
  // didn't advance because the next stage was deleted).
  const stuckStageRows = await db
    .selectDistinct({ id: customers.id })
    .from(customers)
    .where(inArray(customers.currentStage, DELETED_STAGES as unknown as string[]));
  for (const r of stuckStageRows) {
    if (customerIds.length > 0 && !customerIds.includes(r.id)) continue;
    if (!candidateIds.includes(r.id)) candidateIds.push(r.id);
  }

  if (candidateIds.length === 0) {
    console.log('No customers to clean up.\n');
    return;
  }

  console.log(`Found ${candidateIds.length} customer(s) to process.\n`);

  const plans: CustomerCleanupPlan[] = [];

  for (const customerId of candidateIds) {
    const [customer] = await db
      .select({
        id: customers.id,
        name: customers.name,
        workflowKey: customers.workflowKey,
        currentStage: customers.currentStage,
        stripeSubscriptionId: customers.stripeSubscriptionId,
      })
      .from(customers)
      .where(eq(customers.id, customerId));
    if (!customer) {
      console.warn(`Skipping unknown customer ${customerId}`);
      continue;
    }

    const matchingTasks = await db
      .select({ id: tasks.id, name: tasks.taskName, status: tasks.status })
      .from(tasks)
      .where(
        and(
          eq(tasks.customerId, customerId),
          inArray(tasks.taskName, DELETED_TASK_NAMES as unknown as string[]),
          ne(tasks.status, 'Completed'),
          eq(tasks.product, 'Core'),
        ),
      );

    const taskIds = matchingTasks.map((t) => t.id);

    // Count task_dependencies rows that will be deleted (for the manifest).
    let depCount = 0;
    if (taskIds.length > 0) {
      const depRows = await db
        .select({ id: taskDependencies.id })
        .from(taskDependencies)
        .where(
          or(
            inArray(taskDependencies.taskId, taskIds),
            inArray(taskDependencies.dependsOnTaskId, taskIds),
          ),
        );
      depCount = depRows.length;
    }

    const stageIsDeleted = (DELETED_STAGES as readonly string[]).includes(customer.currentStage);
    const stageAdvance: CustomerCleanupPlan['stageAdvance'] = stageIsDeleted
      ? { from: customer.currentStage, to: 'Launched' }
      : null;

    let trialSubAction: CustomerCleanupPlan['trialSubAction'] = null;
    if (stageAdvance && customer.workflowKey === 'B2B-Keyes') {
      if (customer.stripeSubscriptionId) {
        trialSubAction = 'skip-already-has-sub';
      } else {
        trialSubAction = 'create';
      }
    } else if (customer.workflowKey === 'B2B-Keyes' && !stageAdvance) {
      trialSubAction = 'skip-not-advancing';
    } else if (stageAdvance && customer.workflowKey !== 'B2B-Keyes') {
      trialSubAction = 'skip-not-keyes';
    }

    plans.push({
      customerId,
      customerName: customer.name,
      workflowKey: customer.workflowKey,
      currentStage: customer.currentStage,
      hasStripeSubAlready: Boolean(customer.stripeSubscriptionId),
      tasksToComplete: matchingTasks,
      taskDependenciesToDelete: depCount,
      stageAdvance,
      trialSubAction,
    });
  }

  // Print manifest.
  for (const p of plans) {
    console.log(`─ ${p.customerName}  (${p.customerId})`);
    console.log(`    workflow:        ${p.workflowKey}`);
    console.log(`    currentStage:    ${p.currentStage}`);
    console.log(`    stripeSub set:   ${p.hasStripeSubAlready ? 'yes' : 'no'}`);
    console.log(`    tasks to complete (${p.tasksToComplete.length}):`);
    for (const t of p.tasksToComplete) {
      console.log(`        - [${t.status}] ${t.name}`);
    }
    console.log(`    task_dependencies rows to delete: ${p.taskDependenciesToDelete}`);
    if (p.stageAdvance) {
      console.log(`    stage advance:   ${p.stageAdvance.from} → ${p.stageAdvance.to}`);
    }
    if (p.trialSubAction) {
      console.log(`    trial sub:       ${p.trialSubAction}`);
    }
    console.log();
  }

  // Summary.
  const totalTasks = plans.reduce((n, p) => n + p.tasksToComplete.length, 0);
  const totalDeps = plans.reduce((n, p) => n + p.taskDependenciesToDelete, 0);
  const totalAdvance = plans.filter((p) => p.stageAdvance).length;
  const totalTrialCreate = plans.filter((p) => p.trialSubAction === 'create').length;

  console.log(`${'='.repeat(72)}`);
  console.log(`Summary:`);
  console.log(`    customers affected:           ${plans.length}`);
  console.log(`    tasks to mark Completed:      ${totalTasks}`);
  console.log(`    task_dependencies to delete:  ${totalDeps}`);
  console.log(`    customers to advance to Launched: ${totalAdvance}`);
  console.log(`    B2B-Keyes trial subs to create: ${totalTrialCreate}`);
  console.log(`${'='.repeat(72)}\n`);

  if (!apply) {
    console.log('DRY RUN complete — no writes performed.');
    console.log('Re-run with --apply to execute.\n');
    return;
  }

  console.log('APPLYING...\n');

  for (const p of plans) {
    try {
      await db.transaction(async (tx) => {
        const taskIds = p.tasksToComplete.map((t) => t.id);

        if (taskIds.length > 0) {
          // Mark tasks Completed with the notes stamp appended.
          await tx
            .update(tasks)
            .set({
              status: 'Completed',
              completedAt: new Date(),
              notes: sql`COALESCE(${tasks.notes} || E'\n', '') || ${NOTES_STAMP}`,
            })
            .where(
              and(
                eq(tasks.customerId, p.customerId),
                inArray(tasks.id, taskIds),
                ne(tasks.status, 'Completed'),
              ),
            );

          // Drop dependencies pointing at or from those tasks.
          await tx
            .delete(taskDependencies)
            .where(
              or(
                inArray(taskDependencies.taskId, taskIds),
                inArray(taskDependencies.dependsOnTaskId, taskIds),
              ),
            );
        }

        if (p.stageAdvance) {
          await tx
            .update(customers)
            .set({ currentStage: 'Launched', stageEnteredAt: new Date() })
            .where(eq(customers.id, p.customerId));
        }

        await tx.insert(events).values({
          customerId: p.customerId,
          eventType: 'Phase 1 Cleanup',
          actorType: 'System',
          details: {
            stamp: NOTES_STAMP,
            tasksCompleted: p.tasksToComplete.map((t) => t.name),
            taskDependenciesDeleted: p.taskDependenciesToDelete,
            stageAdvance: p.stageAdvance,
            trialSubAction: p.trialSubAction,
          },
        });
      });

      // After the transaction commits, fire the trial sub creation if
      // applicable (Stripe call lives outside the DB transaction).
      if (p.trialSubAction === 'create') {
        const result = await createTrialSubscriptionForCustomer(p.customerId, 'mark-onboarding-call-complete');
        console.log(`    [${p.customerName}] trial sub result: ${result.kind}${result.kind === 'created' ? ` ${result.subscriptionId}` : ''}`);
      }

      console.log(`✅ ${p.customerName}`);
    } catch (err) {
      console.error(`❌ ${p.customerName}: ${err instanceof Error ? err.message : String(err)}`);
      throw err;  // halt — we want to surface failures rather than silently continue
    }
  }

  console.log(`\nDone. ${plans.length} customer(s) processed.\n`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
