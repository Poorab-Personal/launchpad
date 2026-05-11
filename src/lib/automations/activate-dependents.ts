/**
 * Auto 2 port — Task Completed → Activate Dependents + Advance Stage.
 *
 * Mirrors scripts/airtable-automations/auto2-activate-dependents.js. The
 * big architectural change vs. the legacy script: dependencies are read
 * from the task_dependencies junction table (real FKs) instead of a
 * comma-separated text field. CLAUDE.md's "Do NOT use multi-record
 * Depends On links" warning is no longer relevant.
 *
 * Invoked from db.updateTaskStatus / db.updateTaskFields whenever a task
 * transitions to Completed. No route-level changes needed.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db';
import * as schema from '@/db/schema';

const NEXT_STAGE_BY_PRODUCT: Record<'Core' | 'Voice' | 'Avatar', { stageField: 'currentStage' | 'voiceStage' | 'avatarStage'; workflowKeyForCustomer: (custType: 'D2C' | 'B2B', channel: string) => string }> = {
  Core: {
    stageField: 'currentStage',
    workflowKeyForCustomer: (t, c) => `${t}-${c}`,
  },
  Voice: { stageField: 'voiceStage', workflowKeyForCustomer: () => 'Addon-Voice' },
  Avatar: { stageField: 'avatarStage', workflowKeyForCustomer: () => 'Addon-Avatar' },
};

/**
 * Fire Auto 2 for a just-completed task. Safe to call multiple times for
 * the same task — internal idempotency via the WHERE status='Draft' guard
 * and conditional stage advancement.
 */
export async function handleTaskCompleted(taskId: string): Promise<void> {
  const completedTask = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
  });
  if (!completedTask) return;
  if (completedTask.status !== 'Completed') return;

  const product = (completedTask.product ?? 'Core') as 'Core' | 'Voice' | 'Avatar';
  const customerId = completedTask.customerId;
  const completedTaskStage = completedTask.stage;

  // ── 1. Activate dependents within the same Product ──────────────────
  const productTasks = await db
    .select()
    .from(schema.tasks)
    .where(and(eq(schema.tasks.customerId, customerId), eq(schema.tasks.product, product)));

  const completedTaskIds = new Set(
    productTasks.filter((t) => t.status === 'Completed').map((t) => t.id),
  );

  // Fetch all dependencies for this customer's tasks in one go.
  const taskIdsHere = productTasks.map((t) => t.id);
  const allDeps = taskIdsHere.length
    ? await db
        .select()
        .from(schema.taskDependencies)
        .where(inArray(schema.taskDependencies.taskId, taskIdsHere))
    : [];
  const depsByTask = new Map<string, string[]>();
  for (const d of allDeps) {
    const arr = depsByTask.get(d.taskId) ?? [];
    arr.push(d.dependsOnTaskId);
    depsByTask.set(d.taskId, arr);
  }

  for (const draft of productTasks) {
    if (draft.status !== 'Draft') continue;
    const depIds = depsByTask.get(draft.id) ?? [];
    if (depIds.length === 0) continue;
    const allMet = depIds.every((sourceId) => completedTaskIds.has(sourceId));
    if (!allMet) continue;

    // Race guard: only activate if still Draft. Returns 0 rows when another
    // concurrent Auto 2 already activated this one — silent no-op.
    const result = await db
      .update(schema.tasks)
      .set({ status: 'Active', activatedAt: new Date() })
      .where(and(eq(schema.tasks.id, draft.id), eq(schema.tasks.status, 'Draft')))
      .returning({ id: schema.tasks.id });

    if (result.length > 0) {
      await db.insert(schema.events).values({
        customerId,
        eventType: 'Task Activated',
        actorType: 'System',
        details: `Task "${draft.taskName}" [${product}] activated.`,
        relatedTaskId: draft.id,
      });
    }
  }

  // ── 2. Specific-name Customer flag updates ──────────────────────────
  if (completedTask.taskName === 'Create Customer Account') {
    await db
      .update(schema.customers)
      .set({ accountCreated: true })
      .where(eq(schema.customers.id, customerId));
  } else if (completedTask.taskName === 'Send Credentials') {
    await db
      .update(schema.customers)
      .set({ credentialsSent: true })
      .where(eq(schema.customers.id, customerId));
  } else if (completedTask.taskName === 'Mark Onboarding Call Complete') {
    // Auto 4 port: the actual CSM (whoever the task was routed to) becomes
    // the Customer's csm_team_member_id. Look up that CSM's calendlyUrl
    // and stamp it onto Check-In 1 and Check-In 2 tasks so the customer
    // books with the right person.
    if (completedTask.assignedToTeamMemberId) {
      await db
        .update(schema.customers)
        .set({ csmTeamMemberId: completedTask.assignedToTeamMemberId })
        .where(eq(schema.customers.id, customerId));

      const csm = await db.query.teamMembers.findFirst({
        where: eq(schema.teamMembers.id, completedTask.assignedToTeamMemberId),
        columns: { calendlyUrl: true },
      });
      if (csm?.calendlyUrl) {
        await db
          .update(schema.tasks)
          .set({ embedUrl: csm.calendlyUrl })
          .where(
            and(
              eq(schema.tasks.customerId, customerId),
              inArray(schema.tasks.taskName, ['Schedule Check-In 1', 'Schedule Check-In 2']),
            ),
          );
      }
    }
  }

  // ── 3. Log Task Completed event ────────────────────────────────────
  await db.insert(schema.events).values({
    customerId,
    eventType: 'Task Completed',
    actorType: 'System',
    details: `Task "${completedTask.taskName}" [${product}] completed.`,
    relatedTaskId: completedTask.id,
  });

  // ── 4. Stage advancement check ─────────────────────────────────────
  // Re-fetch product tasks to see fresh statuses after activations.
  const fresh = await db
    .select()
    .from(schema.tasks)
    .where(and(eq(schema.tasks.customerId, customerId), eq(schema.tasks.product, product)));
  const stageTasks = fresh.filter((t) => t.stage === completedTaskStage);
  const allStageComplete =
    stageTasks.length > 0 && stageTasks.every((t) => t.status === 'Completed');

  if (!allStageComplete) return;

  // Determine workflow_key + stage field
  const config = NEXT_STAGE_BY_PRODUCT[product];
  let workflowKey: string;
  if (product === 'Core') {
    const customer = await db.query.customers.findFirst({
      where: eq(schema.customers.id, customerId),
      columns: { type: true },
    });
    if (!customer) return;
    // Workflow key is stored on customer at insert (Auto 1) — use that
    // (avoids another join to channels)
    const c = await db.query.customers.findFirst({
      where: eq(schema.customers.id, customerId),
      columns: { workflowKey: true },
    });
    workflowKey = c?.workflowKey ?? '';
  } else {
    workflowKey = config.workflowKeyForCustomer('D2C', 'X');                 // ignored, returns hardcoded
  }
  if (!workflowKey) return;

  // Build ordered stage list for this workflow.
  const tpls = await db
    .select({ stage: schema.workflowTemplates.stage, stageOrder: schema.workflowTemplates.stageOrder })
    .from(schema.workflowTemplates)
    .where(eq(schema.workflowTemplates.workflowKey, workflowKey));
  const stageMap = new Map<string, number>();
  for (const t of tpls) {
    if (!stageMap.has(t.stage)) stageMap.set(t.stage, t.stageOrder);
  }
  const stages = [...stageMap.entries()].sort((a, b) => a[1] - b[1]).map(([s]) => s);
  const currentIdx = stages.indexOf(completedTaskStage);
  const nextStage = currentIdx >= 0 && currentIdx < stages.length - 1
    ? stages[currentIdx + 1]
    : null;

  if (!nextStage) {
    // Final stage — flip the product's stage field to 'Done'.
    await db
      .update(schema.customers)
      .set({ [config.stageField]: 'Done' })
      .where(
        and(
          eq(schema.customers.id, customerId),
          eq(schema.customers[config.stageField], completedTaskStage),               // conditional: only if no concurrent advance already happened
        ),
      );
    return;
  }

  // Conditional advance: only if the current stage field still matches
  // (prevents double-advance under concurrent Auto 2).
  const advanceUpdate: Partial<typeof schema.customers.$inferInsert> = {
    [config.stageField]: nextStage,
  };
  if (product === 'Core') advanceUpdate.stageEnteredAt = new Date();

  const advanced = await db
    .update(schema.customers)
    .set(advanceUpdate)
    .where(
      and(
        eq(schema.customers.id, customerId),
        eq(schema.customers[config.stageField], completedTaskStage),
      ),
    )
    .returning({ id: schema.customers.id });

  if (advanced.length === 0) {
    // Another concurrent Auto 2 already advanced. We're done.
    return;
  }

  await db.insert(schema.events).values({
    customerId,
    eventType: 'Stage Changed',
    actorType: 'System',
    details: `[${product}] Advanced from "${completedTaskStage}" to "${nextStage}".`,
  });

  // ── 5. Activate eligible tasks in the new stage ────────────────────
  const allCompletedIds = new Set(
    fresh.filter((t) => t.status === 'Completed').map((t) => t.id),
  );
  const newStageTasks = fresh.filter((t) => t.stage === nextStage && t.status === 'Draft');
  // Refetch deps for the new-stage tasks
  const newStageDepRows = newStageTasks.length
    ? await db
        .select()
        .from(schema.taskDependencies)
        .where(
          inArray(
            schema.taskDependencies.taskId,
            newStageTasks.map((t) => t.id),
          ),
        )
    : [];
  const newStageDepsByTask = new Map<string, string[]>();
  for (const d of newStageDepRows) {
    const arr = newStageDepsByTask.get(d.taskId) ?? [];
    arr.push(d.dependsOnTaskId);
    newStageDepsByTask.set(d.taskId, arr);
  }

  for (const t of newStageTasks) {
    const depIds = newStageDepsByTask.get(t.id) ?? [];
    const canActivate = depIds.length === 0 || depIds.every((id) => allCompletedIds.has(id));
    if (!canActivate) continue;

    const result = await db
      .update(schema.tasks)
      .set({ status: 'Active', activatedAt: new Date() })
      .where(and(eq(schema.tasks.id, t.id), eq(schema.tasks.status, 'Draft')))
      .returning({ id: schema.tasks.id });

    if (result.length > 0) {
      await db.insert(schema.events).values({
        customerId,
        eventType: 'Task Activated',
        actorType: 'System',
        details: `Task "${t.taskName}" [${product}] activated (new stage).`,
        relatedTaskId: t.id,
      });
    }
  }
}
