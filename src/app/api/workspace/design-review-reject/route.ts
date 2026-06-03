import { NextRequest } from 'next/server';
import { requireSession } from '@/lib/auth/dal';
import {
  createEvent,
  createTask,
  getTaskById,
  getTasksForCustomer,
  updateTaskFields,
} from '@/lib/db';
import { notifyTaskAssigned } from '@/lib/automations/notify-assignee';

const REVISE_INTERNAL_PATTERN = /^Revise Design \(Internal Round (\d+)\)$/;

/**
 * POST /api/workspace/design-review-reject
 * body: { taskId, customerId, feedback }
 *
 * Senior Designer flow when reviewing the junior's Create Designs work:
 *  - Park the Review Designs task (Status=Draft + feedback in Notes) so the
 *    downstream "Upload Proof to Customer" task stays gated.
 *  - Spin up a new Revise Design (Internal Round N+1) task assigned to the
 *    designer who did the previous round (Create Designs assignee, or the
 *    last internal-round designer if we've looped before). Feedback goes
 *    into Instructions so it's surfaced in the action panel.
 *
 * When the designer marks the Revise task complete, the workspace
 * markTaskComplete server action re-activates Review Designs (with a fresh
 * Activated At) so the senior gets it back in their queue.
 */
export async function POST(request: NextRequest) {
  const session = await requireSession();

  const body = await request.json().catch(() => null);
  const taskId = body?.taskId as string | undefined;
  const customerId = body?.customerId as string | undefined;
  const feedback = (body?.feedback as string | undefined)?.trim();

  if (!taskId || !customerId || !feedback) {
    return Response.json(
      { error: 'Missing required fields: taskId, customerId, feedback' },
      { status: 400 },
    );
  }

  // Auth + ownership: must be assigned to this Review Designs task (or admin).
  const reviewTask = await getTaskById(taskId);
  if (!reviewTask) {
    return Response.json({ error: 'Task not found.' }, { status: 404 });
  }
  if (reviewTask.taskName !== 'Review Designs') {
    return Response.json(
      { error: `Reject flow only applies to "Review Designs" tasks (got "${reviewTask.taskName}")` },
      { status: 400 },
    );
  }
  if (reviewTask.customer[0] !== customerId) {
    return Response.json({ error: 'Task does not belong to this customer.' }, { status: 400 });
  }
  if (session.role !== 'Admin' && !reviewTask.assignedTo.includes(session.memberId)) {
    return Response.json({ error: 'Not assigned to you.' }, { status: 403 });
  }

  const customerTasks = await getTasksForCustomer(customerId);

  // Source designer = whoever was on the latest Revise Design (Internal Round N),
  // else the original Create Designs assignee.
  const reviseTasksSorted = customerTasks
    .filter((t) => REVISE_INTERNAL_PATTERN.test(t.taskName))
    .sort((a, b) => {
      const an = Number(a.taskName.match(REVISE_INTERNAL_PATTERN)?.[1] ?? 0);
      const bn = Number(b.taskName.match(REVISE_INTERNAL_PATTERN)?.[1] ?? 0);
      return bn - an;
    });
  const previousDesignerTask =
    reviseTasksSorted[0] ??
    customerTasks.find((t) => t.taskName === 'Create Designs');

  if (!previousDesignerTask) {
    return Response.json(
      { error: 'Could not find an existing Create Designs task to inherit assignee from.' },
      { status: 422 },
    );
  }
  const designerId = previousDesignerTask.assignedTo[0];
  if (!designerId) {
    return Response.json(
      { error: 'Previous designer task has no Assigned To — cannot route the revision.' },
      { status: 422 },
    );
  }

  const nextRound = reviseTasksSorted.length + 1;
  const newTaskName = `Revise Design (Internal Round ${nextRound})`;

  // Park Review Designs (Draft + notes) so Upload Proof stays gated.
  await updateTaskFields(taskId, {
    status: 'Draft',
    notes: feedback,
  });

  // Build the new Revise task. Inherit Stage + Stage Order from Review Designs,
  // push Task Order out so it sorts after the review.
  // Stamp assigneeNotifiedAt at insert so the notify helper's dedupe is
  // armed even before the post-commit fire — see plan §dedupe.
  const now = new Date();
  const created = await createTask({
    taskName: newTaskName,
    customerId,
    stage: reviewTask.stage,
    stageOrder: reviewTask.stageOrder,
    taskOrder: reviewTask.taskOrder + nextRound,
    taskType: 'Team',
    status: 'Active',
    visibleToClient: false,
    hasTeamReview: false,
    attachmentType: 'None',
    instructions: feedback,
    assignedToTeamMemberId: designerId,
    activatedAt: now,
    assigneeNotifiedAt: now,
    product: 'Core',
  });

  void notifyTaskAssigned(created.id);

  try {
    await createEvent(
      customerId,
      'Task Rejected',
      'Team Member',
      `Senior designer requested changes (round ${nextRound}). Feedback: ${feedback.slice(0, 200)}`,
      taskId,
      session.memberId,
    );
  } catch (err) {
    console.warn('Event log failed (non-fatal):', err);
  }

  return Response.json({
    ok: true,
    reviewTaskId: taskId,
    reviseTaskId: created.id,
    round: nextRound,
    designerId,
  });
}
