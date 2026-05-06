'use server';

import { revalidatePath } from 'next/cache';
import { requireSession } from '@/lib/auth/dal';
import { getRecord, updateRecord } from '@/lib/airtable-client';
import { createEvent } from '@/lib/airtable';

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

  revalidatePath(`/workspace/customers/${customerId}`);
  revalidatePath('/workspace/queue');
  return { ok: true as const };
}
