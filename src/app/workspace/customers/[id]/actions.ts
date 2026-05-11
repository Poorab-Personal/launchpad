'use server';

import { revalidatePath } from 'next/cache';
import { requireSession } from '@/lib/auth/dal';
import { getRecord, getRecords, updateRecord } from '@/lib/airtable-client';
import { createEvent } from '@/lib/airtable';

const REVISE_INTERNAL_PATTERN = /^Revise Design \(Internal Round \d+\)$/;

function linkedId(field: unknown): string | null {
  if (!Array.isArray(field) || field.length === 0) return null;
  const first = field[0];
  return typeof first === 'string' ? first : (first as { id: string })?.id ?? null;
}

/**
 * Mark a task complete from the workspace. Verifies the task is assigned
 * to the current session user before allowing the write.
 *
 * Status write triggers Airtable Auto 2 which handles dependency activation
 * and stage advancement — no logic duplicated here.
 */
export async function markTaskComplete(taskId: string, customerId: string) {
  const session = await requireSession();

  const task = await getRecord('Tasks', taskId);
  const assignedTo = task.fields['Assigned To'];
  const assignedIds = Array.isArray(assignedTo)
    ? assignedTo.map((a) => (typeof a === 'string' ? a : (a as { id: string }).id))
    : [];

  // Admin can complete any task; others must be assigned to it
  if (session.role !== 'Admin' && !assignedIds.includes(session.memberId)) {
    return { ok: false as const, error: 'Not assigned to you.' };
  }

  if (linkedId(task.fields['Customer']) !== customerId) {
    return { ok: false as const, error: 'Task does not belong to this customer.' };
  }

  await updateRecord('Tasks', taskId, {
    Status: 'Completed',
    'Completed At': new Date().toISOString(),
  });

  // Non-fatal audit event — don't block the user if logging fails.
  try {
    await createEvent(
      customerId,
      'Task Completed',
      'Team Member',
      `Task "${task.fields['Task Name']}" completed via workspace.`,
      taskId,
      session.memberId,
    );
  } catch (err) {
    console.warn('Event log failed (non-fatal):', err);
  }

  // Internal revision loop: completing "Revise Design (Internal Round N)"
  // means the designer addressed the senior's feedback. Re-activate the
  // parked Review Designs task so it lands back in the senior's queue.
  // Auto 2 doesn't handle this because Review Designs has no Depends On
  // pointing at the dynamic revise task.
  const taskName = (task.fields['Task Name'] as string) ?? '';
  if (REVISE_INTERNAL_PATTERN.test(taskName)) {
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
  // Find the customer's Review Designs task (regardless of its current status).
  // We expect at most one — it's the canonical gate for Upload Proof to Customer.
  const allTasks = await getRecords('Tasks', {
    filterByFormula: `{Task Name} = 'Review Designs'`,
  });
  const reviewTask = allTasks.find((t) =>
    JSON.stringify(t.fields['Customer'] ?? '').includes(customerId),
  );
  if (!reviewTask) return;
  await updateRecord('Tasks', reviewTask.id, {
    Status: 'Active',
    'Activated At': new Date().toISOString(),
  });
}
