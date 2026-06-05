/**
 * Auto 2 — Task Completed → Activate Dependents + Advance Stage.
 *
 * Dependencies are read from the `task_dependencies` junction table
 * (real FKs), not comma-separated text.
 *
 * Invoked from db.updateTaskStatus / db.updateTaskFields whenever a task
 * transitions to Completed. No route-level changes needed.
 */
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from '@/db';
import * as schema from '@/db/schema';
import { triggerCustomerEmail } from '@/lib/automations/trigger-email';
import { notifyTaskAssigned } from '@/lib/automations/notify-assignee';
import { runHubspotIntakePushWithAudit } from '@/lib/integrations/hubspot/intake-handler';

const REVIEW_BRAND_KIT_TASK = 'Review & Approve Your Brand Kit';

// Commitment-moment trigger per workflow: when this task completes for a
// self-serve customer, create the HubSpot Pre-Onboarding ticket. The post-
// schedule chain at line 259 then pushes it to "Onboarding Scheduled" when the
// customer books. D2C-Standard is intentionally absent (admin path creates the
// ticket; self-serve D2C does not exist). Keyes/BW are out of scope for now.
/**
 * Exported so the admin POST /api/customers can check whether a workflow's
 * HS push is gated behind a commitment-task. Workflows in this map skip the
 * immediate-HS-push admin behavior — they wait for the trigger task to
 * complete, which fires the push via this same Auto 2 hook. D2C-Standard
 * stays unconditional-immediate (no trigger task; admin is the canonical
 * D2C creation path alongside closedwon-handler).
 */
export const INTAKE_PUSH_TRIGGER_TASK: Record<string, string> = {
  'B2B-IPRE': 'Capture Payment Method',
  'B2B-Keyes': 'Capture Payment Method',
  'B2B-BW': 'Confirm Your Information',
};

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
  const t0 = Date.now();
  const tt = (label: string, prev: number) => {
    const now = Date.now();
    if (now - prev > 30) console.log(`[Auto 2] ${label}: ${now - prev}ms`);
    return now;
  };
  let cursor = t0;

  const completedTask = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
  });
  cursor = tt('lookup completed task', cursor);
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
  cursor = tt('fetch product tasks', cursor);

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
  cursor = tt('fetch task dependencies', cursor);
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
    // assigneeNotifiedAt is stamped in the SAME update so the losing concurrent
    // call sees it set and the notify helper short-circuits — see
    // docs/plans/internal-task-assignee-notifications.md.
    const activationUpdate: Partial<typeof schema.tasks.$inferInsert> = {
      status: 'Active',
      activatedAt: new Date(),
    };
    if (draft.assignedToTeamMemberId) {
      activationUpdate.assigneeNotifiedAt = new Date();
    }
    const result = await db
      .update(schema.tasks)
      .set(activationUpdate)
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
      // Auto 6: Design Ready email when the customer-facing review task
      // becomes Active. Best-effort fire-and-forget.
      if (draft.taskName === REVIEW_BRAND_KIT_TASK) {
        void triggerCustomerEmail('design-ready', customerId);
      }
      if (draft.assignedToTeamMemberId) {
        void notifyTaskAssigned(draft.id);
      }
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

    // Bridge to Auto 8: marking the task complete is the canonical CSM
    // signal that the onboarding call is done. Cascade the same signal to
    // the corresponding Calls record's status — updateCall() will then fire
    // handleCallCompleted, which creates the Stripe subscription for
    // setup-intent-at-intake workflows (B2B-Keyes). Without this bridge,
    // CSMs marking the task would never start the trial.
    const openOnboardingCall = await db.query.calls.findFirst({
      where: and(
        eq(schema.calls.customerId, customerId),
        eq(schema.calls.type, 'Onboarding'),
        ne(schema.calls.status, 'Completed'),
      ),
      orderBy: [desc(schema.calls.scheduledDate)],
    });
    if (openOnboardingCall) {
      const { updateCall } = await import('@/lib/db');
      await updateCall(openOnboardingCall.id, { status: 'Completed' });
    }
  }

  cursor = tt('section 1+2 (activate + flags)', cursor);

  // ── 3. Log Task Completed event ────────────────────────────────────
  await db.insert(schema.events).values({
    customerId,
    eventType: 'Task Completed',
    actorType: 'System',
    details: `Task "${completedTask.taskName}" [${product}] completed.`,
    relatedTaskId: completedTask.id,
  });
  cursor = tt('log Task Completed event', cursor);

  // ── 3b. HS ticket creation on the commitment-moment task ───────────
  // Positioned BEFORE the stage-advancement early-return at section 4.
  // The commitment task (e.g. BW "Confirm Your Information", IPRE/Keyes
  // "Capture Payment Method") doesn't itself complete the whole stage —
  // Schedule + Create Designs are still pending — so the stage-advancement
  // check below would otherwise return early and skip the HS push entirely
  // (B2B-BW had no HS ticket ever created before this fix, since BW has
  // no separate confirm-route belt; IPRE/Keyes were saved by the confirm
  // route's parallel push).
  //
  // Idempotent via intake-handler's hubspotTicketId-already-set short-circuit.
  // Awaited (best-effort; matches admin path — voiding risks dropped
  // promises per the 2026-05-14 incident). Failures audit-logged + emailed
  // to ALERTS_EMAIL but never thrown.
  const triggerCust = await db.query.customers.findFirst({
    where: eq(schema.customers.id, customerId),
    columns: { workflowKey: true, name: true },
  });
  const triggerTaskName = triggerCust
    ? INTAKE_PUSH_TRIGGER_TASK[triggerCust.workflowKey]
    : undefined;
  if (triggerCust && triggerTaskName && completedTask.taskName === triggerTaskName) {
    await runHubspotIntakePushWithAudit(customerId, triggerCust.name);
  }

  // ── 4. Stage advancement check ─────────────────────────────────────
  // Re-fetch product tasks to see fresh statuses after activations.
  const fresh = await db
    .select()
    .from(schema.tasks)
    .where(and(eq(schema.tasks.customerId, customerId), eq(schema.tasks.product, product)));
  cursor = tt('re-fetch fresh tasks', cursor);
  const stageTasks = fresh.filter((t) => t.stage === completedTaskStage);
  const allStageComplete =
    stageTasks.length > 0 && stageTasks.every((t) => t.status === 'Completed');

  if (!allStageComplete) {
    console.log(`[Auto 2] TOTAL (no stage advance): ${Date.now() - t0}ms`);
    return;
  }

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
    // Final stage — flip the product's stage field to its terminal value.
    //   Core:  'Launched' — post-launch lifecycle now lives in HubSpot
    //          (per docs/plans/post-launch-migration.md, Phase 1).
    //   Voice / Avatar: 'Done' — add-on workflows stay LP-scoped.
    const terminalValue = product === 'Core' ? 'Launched' : 'Done';

    const updated = await db
      .update(schema.customers)
      .set({ [config.stageField]: terminalValue })
      .where(
        and(
          eq(schema.customers.id, customerId),
          eq(schema.customers[config.stageField], completedTaskStage),               // conditional: only if no concurrent advance already happened
        ),
      )
      .returning({ id: schema.customers.id, hubspotTicketId: schema.customers.hubspotTicketId });

    // Hand off the HubSpot ticket: Pre-Onboarding → Onboarding Scheduled.
    // The customer has credentials + signed in but the actual onboarding
    // meeting hasn't happened yet, so 'Active' would be wrong. HS Workflow F
    // takes over from here based on Meeting outcomes (Completed, No-show, etc).
    // Best-effort: log + swallow. LP-side 'Launched' is canonical; the HS push
    // is for CSM kanban visibility only and we don't want a HubSpot outage to
    // block customer onboarding completion.
    if (product === 'Core' && updated.length > 0 && updated[0].hubspotTicketId) {
      try {
        const { pushTicketStage } = await import('@/lib/integrations/hubspot/client');
        await pushTicketStage(updated[0].hubspotTicketId, 'Onboarding Scheduled');
      } catch (err) {
        console.warn(`[Auto 2] HS ticket stage push to "Onboarding Scheduled" failed for customer ${customerId} (non-blocking)`, err);
      }
    }
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

    const newStageUpdate: Partial<typeof schema.tasks.$inferInsert> = {
      status: 'Active',
      activatedAt: new Date(),
    };
    if (t.assignedToTeamMemberId) {
      newStageUpdate.assigneeNotifiedAt = new Date();
    }
    const result = await db
      .update(schema.tasks)
      .set(newStageUpdate)
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
      // Auto 6 also fires from the new-stage activation path (the review
      // task can become Active when the stage advances to Review Your Designs).
      if (t.taskName === REVIEW_BRAND_KIT_TASK) {
        void triggerCustomerEmail('design-ready', customerId);
      }
      if (t.assignedToTeamMemberId) {
        void notifyTaskAssigned(t.id);
      }
    }
  }

  // HS ticket trigger moved up to §3b (before the stage-advancement early
  // return) — see comment block above.
}
