'use server';

import { revalidatePath } from 'next/cache';
import { requireSession } from '@/lib/auth/dal';
import {
  createEvent,
  getTaskById,
  getTasksForCustomer,
  updateTaskFields,
} from '@/lib/db';

const REVISE_INTERNAL_PATTERN = /^Revise Design \(Internal Round \d+\)$/;

/**
 * Mark a task complete from the workspace. Verifies the task is assigned
 * to the current session user before allowing the write.
 *
 * Status write will trigger Auto 2 (Phase 3) for dependency activation and
 * stage advancement — no logic duplicated here.
 */
export async function markTaskComplete(taskId: string, customerId: string) {
  const session = await requireSession();

  const task = await getTaskById(taskId);
  if (!task) {
    return { ok: false as const, error: 'Task not found.' };
  }

  // Admin can complete any task; others must be assigned to it
  if (session.role !== 'Admin' && !task.assignedTo.includes(session.memberId)) {
    return { ok: false as const, error: 'Not assigned to you.' };
  }

  if (task.customer[0] !== customerId) {
    return { ok: false as const, error: 'Task does not belong to this customer.' };
  }

  await updateTaskFields(taskId, {
    status: 'Completed',
    completedAt: new Date(),
  });

  try {
    await createEvent(
      customerId,
      'Task Completed',
      'Team Member',
      `Task "${task.taskName}" completed via workspace.`,
      taskId,
      session.memberId,
    );
  } catch (err) {
    console.warn('Event log failed (non-fatal):', err);
  }

  // Internal revision loop: completing "Revise Design (Internal Round N)"
  // re-activates the parked Review Designs task back into the senior's queue.
  if (REVISE_INTERNAL_PATTERN.test(task.taskName)) {
    try {
      await reactivateReviewDesigns(customerId);
    } catch (err) {
      console.warn('Failed to re-activate Review Designs (non-fatal):', err);
    }
  }

  revalidatePath(`/workspace/customers/${customerId}`);
  revalidatePath('/workspace/queue');
  return { ok: true as const };
}

async function reactivateReviewDesigns(customerId: string) {
  const tasks = await getTasksForCustomer(customerId);
  const reviewTask = tasks.find((t) => t.taskName === 'Review Designs');
  if (!reviewTask) return;
  await updateTaskFields(reviewTask.id, {
    status: 'Active',
    activatedAt: new Date(),
  });
}
