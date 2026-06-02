/**
 * Auto 4 / Auto 5 design-approval port.
 *
 * Two entry points called from POST /api/customers/[id]/design-approval:
 *   - handleDesignApproved      — customer approved the brand kit
 *   - handleDesignChangesRequested — customer asked for revisions
 *
 * Approved path:
 *   1. Stamp Customer.designApproval = Approved + Design Feedback
 *   2. Mark "Review & Approve Your Brand Kit" task Completed (this fires
 *      Auto 2 which activates dependents + advances stage if applicable)
 *   3. Auto-complete pending revision tasks across all rounds (Revise
 *      Design / Review Revision / Upload Revised Proof) — they're stale
 *      and would otherwise sit in designers' queues forever
 *   4. Log Design Approved event
 *
 * Changes Requested path:
 *   1. Read current designRevisionCount, compute new round = count + 1
 *   2. Find designer (from Create Designs) + senior (from Review Designs)
 *      to inherit assignments
 *   3. Create 3-task revision chain (Revise → Review Revision → Upload),
 *      task_dependencies wired via the junction table
 *   4. Increment Customer.designRevisionCount, reset designApproval = Pending
 *   5. Log Design Changes Requested event
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db';
import * as schema from '@/db/schema';
import { updateTaskStatus } from '@/lib/db';
import { makeNote } from '@/lib/design-notes';

const REVIEW_TASK = 'Review & Approve Your Brand Kit';
const REVISION_TASK_PATTERN = /^(Revise Design|Review Revision|Upload Revised Proof) \((Internal )?Round /;

export async function handleDesignApproved(
  customerId: string,
  feedback?: string,
): Promise<{ taskCompleted: string | null }> {
  // 1. Stamp approval + append the customer's optional final note to the
  //    designNotes trail (uploadTask = the proof round they're responding to).
  const customerUpdate: Partial<typeof schema.customers.$inferInsert> = {
    designApproval: 'Approved',
  };
  if (feedback) {
    const cust = await db.query.customers.findFirst({
      where: eq(schema.customers.id, customerId),
      columns: { designRevisionCount: true },
    });
    const count = cust?.designRevisionCount ?? 0;
    const respondingTo = count === 0 ? 'Upload Proof to Customer' : `Upload Revised Proof (Round ${count})`;
    const note = makeNote('customer', feedback, respondingTo);
    customerUpdate.designNotes = sql`COALESCE(${schema.customers.designNotes}, '[]'::jsonb) || ${JSON.stringify([note])}::jsonb`;
  }
  await db.update(schema.customers).set(customerUpdate).where(eq(schema.customers.id, customerId));

  // 2. Find "Review & Approve Your Brand Kit" task, mark Completed.
  //    updateTaskStatus internally fires Auto 2 (activate dependents +
  //    advance stage) so we don't need to duplicate that logic here.
  const reviewTask = await db.query.tasks.findFirst({
    where: and(
      eq(schema.tasks.customerId, customerId),
      eq(schema.tasks.taskName, REVIEW_TASK),
    ),
  });
  let taskCompleted: string | null = null;
  if (reviewTask && reviewTask.status !== 'Completed') {
    await updateTaskStatus(reviewTask.id, 'Completed');
    taskCompleted = reviewTask.id;
  }

  // 3. Auto-complete pending revision tasks. Once the customer has approved
  //    the final design, revision tasks across all rounds are stale.
  //    Each updateTaskStatus call fires its own Auto 2 pass — by design,
  //    so the dependent-activation cascade works through the chain.
  const allCustomerTasks = await db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.customerId, customerId));
  const pendingRevisions = allCustomerTasks.filter(
    (t) => REVISION_TASK_PATTERN.test(t.taskName) && t.status !== 'Completed',
  );
  for (const t of pendingRevisions) {
    const existingNotes = t.notes ?? '';
    const note = '[Auto-completed: customer approved final design]';
    await db
      .update(schema.tasks)
      .set({
        notes: existingNotes ? `${existingNotes}\n${note}` : note,
      })
      .where(eq(schema.tasks.id, t.id));
    await updateTaskStatus(t.id, 'Completed');
  }

  // 4. Log Design Approved event
  await db.insert(schema.events).values({
    customerId,
    eventType: 'Design Approved',
    actorType: 'Customer',
    details: 'Customer approved their brand kit design.',
    relatedTaskId: reviewTask?.id ?? null,
  });

  return { taskCompleted };
}

export async function handleDesignChangesRequested(
  customerId: string,
  feedback?: string,
): Promise<{
  round: number;
  reviseTaskId: string;
  reviewTaskId: string;
  uploadTaskId: string;
  taskNames: { revise: string; review: string; upload: string };
}> {
  // 1. Read current revision count
  const customer = await db.query.customers.findFirst({
    where: eq(schema.customers.id, customerId),
    columns: { designRevisionCount: true },
  });
  if (!customer) throw new Error(`Customer ${customerId} not found`);
  const round = (customer.designRevisionCount ?? 0) + 1;

  // 2. Find designer + senior assignments to inherit
  const existingTasks = await db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.customerId, customerId));
  const createDesigns = existingTasks.find((t) => t.taskName === 'Create Designs');
  const reviewDesigns = existingTasks.find((t) => t.taskName === 'Review Designs');
  const designerId = createDesigns?.assignedToTeamMemberId ?? null;
  const seniorId = reviewDesigns?.assignedToTeamMemberId ?? null;

  // 3. Create the 3-task revision chain. Wire task_dependencies via the
  //    junction table directly so we get proper FKs (instead of the legacy
  //    comma-separated text field).
  const reviseTaskName = `Revise Design (Round ${round})`;
  const reviewTaskName = `Review Revision (Round ${round})`;
  const uploadTaskName = `Upload Revised Proof (Round ${round})`;
  const stage = 'Review Your Designs';
  const stageOrder = 2;
  const now = new Date();

  const result = await db.transaction(async (tx) => {
    const [reviseTask] = await tx
      .insert(schema.tasks)
      .values({
        taskName: reviseTaskName,
        customerId,
        taskType: 'Team',
        stage,
        stageOrder,
        taskOrder: 10 + round,
        status: 'Active',
        activatedAt: now,
        visibleToClient: false,
        hasTeamReview: false,
        attachmentType: 'None',
        product: 'Core',
        instructions: `Revise the design based on customer feedback (Round ${round}).`,
        notes: feedback ?? null,
        assignedToTeamMemberId: designerId,
      })
      .returning();

    const [reviewTask] = await tx
      .insert(schema.tasks)
      .values({
        taskName: reviewTaskName,
        customerId,
        taskType: 'Team',
        stage,
        stageOrder,
        taskOrder: 11 + round,
        status: 'Draft',
        visibleToClient: false,
        hasTeamReview: false,
        attachmentType: 'None',
        product: 'Core',
        instructions: `Review the revised design (Round ${round}). Approve or send back.`,
        assignedToTeamMemberId: seniorId,
      })
      .returning();

    const [uploadTask] = await tx
      .insert(schema.tasks)
      .values({
        taskName: uploadTaskName,
        customerId,
        taskType: 'Team',
        stage,
        stageOrder,
        taskOrder: 12 + round,
        status: 'Draft',
        visibleToClient: false,
        hasTeamReview: false,
        attachmentType: 'None',
        product: 'Core',
        instructions: `Upload the revised proof for customer review (Round ${round}).`,
        assignedToTeamMemberId: designerId,
      })
      .returning();

    // task_dependencies: review depends on revise; upload depends on review.
    await tx.insert(schema.taskDependencies).values([
      { taskId: reviewTask.id, dependsOnTaskId: reviseTask.id },
      { taskId: uploadTask.id, dependsOnTaskId: reviewTask.id },
    ]);

    // 4. Increment revision count, reset approval, append the customer's
    //    feedback to the designNotes trail (uploadTask = the proof they're
    //    responding to, which is the round BEFORE this new one).
    const customerSet: Partial<typeof schema.customers.$inferInsert> = {
      designApproval: 'Pending',
      designRevisionCount: round,
    };
    if (feedback) {
      const respondingTo = round === 1 ? 'Upload Proof to Customer' : `Upload Revised Proof (Round ${round - 1})`;
      const note = makeNote('customer', feedback, respondingTo);
      customerSet.designNotes = sql`COALESCE(${schema.customers.designNotes}, '[]'::jsonb) || ${JSON.stringify([note])}::jsonb`;
    }
    await tx
      .update(schema.customers)
      .set(customerSet)
      .where(eq(schema.customers.id, customerId));

    return { reviseTask, reviewTask, uploadTask };
  });

  // 5. Log event (outside the tx — best-effort audit)
  await db.insert(schema.events).values({
    customerId,
    eventType: 'Design Changes Requested',
    actorType: 'Customer',
    details: `Customer requested design changes (Round ${round}).${feedback ? ` Feedback: ${feedback}` : ''}`,
    relatedTaskId: result.reviseTask.id,
  });

  return {
    round,
    reviseTaskId: result.reviseTask.id,
    reviewTaskId: result.reviewTask.id,
    uploadTaskId: result.uploadTask.id,
    taskNames: { revise: reviseTaskName, review: reviewTaskName, upload: uploadTaskName },
  };
}
