import { NextRequest } from 'next/server';
import { requireSession } from '@/lib/auth/dal';
import { getRecord, getRecords, createRecord, updateRecord } from '@/lib/airtable-client';
import { createEvent } from '@/lib/db';

const REVISE_INTERNAL_PATTERN = /^Revise Design \(Internal Round (\d+)\)$/;

function linkedId(field: unknown): string | null {
  if (!Array.isArray(field) || field.length === 0) return null;
  const first = field[0];
  return typeof first === 'string' ? first : (first as { id: string })?.id ?? null;
}

function linkedIds(field: unknown): string[] {
  if (!Array.isArray(field)) return [];
  return field.map((v) => (typeof v === 'string' ? v : (v as { id: string })?.id)).filter(Boolean);
}

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
  const reviewTask = await getRecord('Tasks', taskId);
  const reviewName = (reviewTask.fields['Task Name'] as string) ?? '';
  if (reviewName !== 'Review Designs') {
    return Response.json(
      { error: `Reject flow only applies to "Review Designs" tasks (got "${reviewName}")` },
      { status: 400 },
    );
  }
  if (linkedId(reviewTask.fields['Customer']) !== customerId) {
    return Response.json({ error: 'Task does not belong to this customer.' }, { status: 400 });
  }
  const reviewAssignedIds = linkedIds(reviewTask.fields['Assigned To']);
  if (session.role !== 'Admin' && !reviewAssignedIds.includes(session.memberId)) {
    return Response.json({ error: 'Not assigned to you.' }, { status: 403 });
  }

  // Find the customer's existing tasks once. We need to: (a) find the most
  // recent designer task to inherit its assignee, (b) count existing internal
  // rounds to determine the next N.
  const allTasks = await getRecords('Tasks');
  const customerTasks = allTasks.filter((t) =>
    JSON.stringify(t.fields['Customer'] ?? '').includes(customerId),
  );

  // Source designer = whoever is/was on the latest Revise Design (Internal Round N),
  // else the original Create Designs assignee.
  const reviseTasksSorted = customerTasks
    .filter((t) => REVISE_INTERNAL_PATTERN.test((t.fields['Task Name'] as string) ?? ''))
    .sort((a, b) => {
      const an = Number(((a.fields['Task Name'] as string).match(REVISE_INTERNAL_PATTERN)?.[1]) ?? 0);
      const bn = Number(((b.fields['Task Name'] as string).match(REVISE_INTERNAL_PATTERN)?.[1]) ?? 0);
      return bn - an;
    });
  const previousDesignerTask =
    reviseTasksSorted[0] ??
    customerTasks.find((t) => (t.fields['Task Name'] as string) === 'Create Designs');

  if (!previousDesignerTask) {
    return Response.json(
      { error: 'Could not find an existing Create Designs task to inherit assignee from.' },
      { status: 422 },
    );
  }
  const designerIds = linkedIds(previousDesignerTask.fields['Assigned To']);
  if (designerIds.length === 0) {
    return Response.json(
      { error: 'Previous designer task has no Assigned To — cannot route the revision.' },
      { status: 422 },
    );
  }

  const nextRound = reviseTasksSorted.length + 1;
  const newTaskName = `Revise Design (Internal Round ${nextRound})`;

  // Park Review Designs (Draft + notes) so Upload Proof stays gated.
  await updateRecord('Tasks', taskId, {
    Status: 'Draft',
    Notes: feedback,
  });

  // Build the new Revise task fields. Inherit Stage + Stage Order from
  // Review Designs, push Task Order out so it sorts after the review.
  const reviewStage = (reviewTask.fields['Stage'] as string) ?? '';
  const reviewStageOrder = Number(reviewTask.fields['Stage Order']) || 0;
  const reviewTaskOrder = Number(reviewTask.fields['Task Order']) || 0;

  const reviseFields: Record<string, unknown> = {
    'Task Name': newTaskName,
    Customer: [customerId],
    Stage: reviewStage,
    'Stage Order': reviewStageOrder,
    'Task Order': reviewTaskOrder + nextRound,
    'Task Type': 'Team',
    Status: 'Active',
    'Visible To Client': false,
    'Has Team Review': false,
    'Attachment Type': 'None',
    Instructions: feedback,
    'Assigned To': designerIds,
    'Activated At': new Date().toISOString(),
    Product: 'Core',
  };
  const created = await createRecord('Tasks', reviseFields);

  // Audit — non-fatal.
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
    designerIds,
  });
}
