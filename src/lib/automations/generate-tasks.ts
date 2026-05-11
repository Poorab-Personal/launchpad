/**
 * Auto 1 port — generate tasks from Workflow Templates on Customer create.
 *
 * Mirrors scripts/airtable-automations/auto1-generate-tasks.js. Runs inline
 * inside the customer-create transaction so a Customer + its Tasks land
 * atomically (architect's Phase 3 atomicity win).
 *
 * Phase 3.1 scope simplifications vs. the legacy script:
 *  - HubSpot Deal URL is NOT synthesized (no column on customers).
 *  - Customer.Environment "Production" link skipped (Settings is now
 *    key-value, not row-per-env).
 *  - Onboarding Calendly URL fallback: brokerage's default only. Settings-
 *    key fallback (`default_onboarding_calendly_url`) deferred until needed.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { resolveDefaultTeamMemberForRole } from '@/lib/db';

type Tx = Parameters<Parameters<typeof import('@/db').db.transaction>[0]>[0];

export interface GenerateTasksArgs {
  customerId: string;
  type: 'D2C' | 'B2B';
  channel: string;                                                       // code (Standard | Keyes | BW)
  brokerageId: string | null;
  hasVoice: boolean;
  hasAvatar: boolean;
}

export interface GenerateTasksResult {
  totalCount: number;
  coreCount: number;
  voiceCount: number;
  avatarCount: number;
  firstStage: string;
}

const SCHEDULE_ONBOARDING_TASK = 'Schedule Your Onboarding Call';

export async function generateTasksFromTemplate(
  tx: Tx,
  args: GenerateTasksArgs,
): Promise<GenerateTasksResult> {
  const workflowKey = `${args.type}-${args.channel}`;

  // ── 1. Resolve Calendly URL (brokerage default → '') ────────────────
  let onboardingCalendlyUrl = '';
  if (args.brokerageId) {
    const brokerage = await tx.query.brokerages.findFirst({
      where: eq(schema.brokerages.id, args.brokerageId),
      columns: { defaultCalendlyUrl: true },
    });
    onboardingCalendlyUrl = brokerage?.defaultCalendlyUrl ?? '';
  }

  // ── 2. Insert Core tasks for the workflow ──────────────────────────
  const coreTemplates = await tx
    .select()
    .from(schema.workflowTemplates)
    .where(eq(schema.workflowTemplates.workflowKey, workflowKey))
    .orderBy(
      asc(schema.workflowTemplates.stageOrder),
      asc(schema.workflowTemplates.taskOrder),
    );

  if (coreTemplates.length === 0) {
    throw new Error(`No workflow templates found for key "${workflowKey}"`);
  }

  const coreCreated = await createTasksFromTemplates(
    tx,
    args.customerId,
    coreTemplates,
    'Core',
    onboardingCalendlyUrl,
  );

  // ── 3. Add-on tasks (Voice / Avatar — Avatar supersedes Voice) ─────
  let voiceCreated: TaskInsert[] = [];
  let avatarCreated: TaskInsert[] = [];
  let voiceFirstStage = '';
  let avatarFirstStage = '';

  if (args.hasAvatar) {
    const avatarTemplates = await tx
      .select()
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.workflowKey, 'Addon-Avatar'))
      .orderBy(
        asc(schema.workflowTemplates.stageOrder),
        asc(schema.workflowTemplates.taskOrder),
      );
    if (avatarTemplates.length > 0) {
      avatarCreated = await createTasksFromTemplates(
        tx,
        args.customerId,
        avatarTemplates,
        'Avatar',
        onboardingCalendlyUrl,
      );
      avatarFirstStage = avatarTemplates[0].stage;
    }
  } else if (args.hasVoice) {
    const voiceTemplates = await tx
      .select()
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.workflowKey, 'Addon-Voice'))
      .orderBy(
        asc(schema.workflowTemplates.stageOrder),
        asc(schema.workflowTemplates.taskOrder),
      );
    if (voiceTemplates.length > 0) {
      voiceCreated = await createTasksFromTemplates(
        tx,
        args.customerId,
        voiceTemplates,
        'Voice',
        onboardingCalendlyUrl,
      );
      voiceFirstStage = voiceTemplates[0].stage;
    }
  }

  // ── 4. Resolve task_dependencies junction rows ─────────────────────
  // Templates have comma-separated `depends_on` task names. After inserting,
  // we have real ids — look them up in a per-product name→id map and insert.
  await wireDependencies(tx, coreCreated, coreTemplates);
  if (avatarCreated.length > 0) {
    const tpls = await tx
      .select()
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.workflowKey, 'Addon-Avatar'));
    await wireDependencies(tx, avatarCreated, tpls);
  }
  if (voiceCreated.length > 0) {
    const tpls = await tx
      .select()
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.workflowKey, 'Addon-Voice'));
    await wireDependencies(tx, voiceCreated, tpls);
  }

  // ── 5. Update Customer stage + log event ───────────────────────────
  const firstStage = coreTemplates[0].stage;
  const stageUpdate: Partial<typeof schema.customers.$inferInsert> = {
    currentStage: firstStage,
    stageEnteredAt: new Date(),
  };
  if (avatarFirstStage) stageUpdate.avatarStage = avatarFirstStage;
  if (voiceFirstStage) stageUpdate.voiceStage = voiceFirstStage;
  await tx
    .update(schema.customers)
    .set(stageUpdate)
    .where(eq(schema.customers.id, args.customerId));

  const coreCount = coreCreated.length;
  const voiceCount = voiceCreated.length;
  const avatarCount = avatarCreated.length;
  const totalCount = coreCount + voiceCount + avatarCount;
  const addOnParts = [];
  if (voiceCount > 0) addOnParts.push(`${voiceCount} Voice`);
  if (avatarCount > 0) addOnParts.push(`${avatarCount} Avatar`);
  const addOnSuffix = addOnParts.length > 0 ? ` + ${addOnParts.join(' + ')} add-on tasks` : '';

  await tx.insert(schema.events).values({
    customerId: args.customerId,
    eventType: 'Customer Created',
    actorType: 'System',
    details: `${args.type} customer created via ${args.channel}. ${coreCount} Core tasks generated from ${workflowKey} workflow${addOnSuffix}.`,
  });

  return { totalCount, coreCount, voiceCount, avatarCount, firstStage };
}

// ─── Internal helpers ──────────────────────────────────────────────────

type TemplateRow = typeof schema.workflowTemplates.$inferSelect;
type TaskInsert = typeof schema.tasks.$inferSelect;

async function createTasksFromTemplates(
  tx: Tx,
  customerId: string,
  templates: TemplateRow[],
  product: 'Core' | 'Voice' | 'Avatar',
  onboardingCalendlyUrl: string,
): Promise<TaskInsert[]> {
  const now = new Date();
  const rolesNeeded = new Set(templates.map((t) => t.assignedRole).filter(Boolean) as string[]);

  // Resolve all needed roles once — same role used for many tasks (e.g.
  // Designer for ~5 templates in D2C-Standard).
  const roleAssignments = new Map<string, string | null>();
  for (const role of rolesNeeded) {
    const member = await resolveDefaultTeamMemberForRole(role);
    roleAssignments.set(role, member?.id ?? null);
  }

  const values = templates.map((t) => {
    const isActive = t.initialStatus === 'Active';
    const embedUrl =
      t.taskTitle === SCHEDULE_ONBOARDING_TASK && onboardingCalendlyUrl
        ? onboardingCalendlyUrl
        : t.embedUrl ?? null;

    return {
      customerId,
      taskName: t.taskTitle,
      taskType: t.taskType,
      stage: t.stage,
      stageOrder: t.stageOrder,
      taskOrder: t.taskOrder,
      status: t.initialStatus,
      assignedToTeamMemberId: t.assignedRole ? roleAssignments.get(t.assignedRole) ?? null : null,
      visibleToClient: t.visibleToClient,
      hasTeamReview: t.hasTeamReview,
      attachmentType: t.attachmentType,
      embedUrl,
      instructions: t.instructions ?? null,
      activatedAt: isActive ? now : null,
      product,
    } satisfies typeof schema.tasks.$inferInsert;
  });

  return await tx.insert(schema.tasks).values(values).returning();
}

async function wireDependencies(
  tx: Tx,
  createdTasks: TaskInsert[],
  templates: TemplateRow[],
): Promise<void> {
  const nameToId = new Map(createdTasks.map((t) => [t.taskName, t.id]));
  // Match templates to created tasks by taskTitle order (templates were the
  // input; createdTasks preserve insertion order, which matched template
  // order). For each template that has depends_on, look up the source by name.
  const links: { taskId: string; dependsOnTaskId: string }[] = [];
  for (const t of templates) {
    if (!t.dependsOn) continue;
    const targetId = nameToId.get(t.taskTitle);
    if (!targetId) continue;
    const sourceNames = t.dependsOn.split(',').map((s) => s.trim()).filter(Boolean);
    for (const sourceName of sourceNames) {
      const sourceId = nameToId.get(sourceName);
      if (sourceId) links.push({ taskId: targetId, dependsOnTaskId: sourceId });
    }
  }
  if (links.length > 0) {
    await tx.insert(schema.taskDependencies).values(links);
  }
}
