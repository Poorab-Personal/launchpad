'use server';

import { revalidatePath } from 'next/cache';
import { requireSession } from '@/lib/auth/dal';
import {
  createEvent,
  getTaskById,
  updateCustomerFields,
  updateTaskFields,
} from '@/lib/db';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isAuthorized(role: string, assignedIds: string[], memberId: string): boolean {
  if (role === 'Admin') return true;
  if (role !== 'Account Creator') return false;
  return assignedIds.includes(memberId);
}

/**
 * Mark the "Create Customer Account" task complete and stamp the platform
 * email + flag onto the Customer record. Auto 2 (Phase 3) picks up the task
 * status change and activates dependent tasks (e.g. Send Credentials).
 */
export async function markAccountCreated(
  taskId: string,
  customerId: string,
  platformEmail: string,
) {
  const session = await requireSession();

  const trimmed = platformEmail.trim();
  if (!EMAIL_RE.test(trimmed)) {
    return { ok: false as const, error: 'Invalid email address.' };
  }

  const task = await getTaskById(taskId);
  if (!task) {
    return { ok: false as const, error: 'Task not found.' };
  }

  if (!isAuthorized(session.role, task.assignedTo, session.memberId)) {
    return { ok: false as const, error: 'Not assigned to you.' };
  }

  if (task.customer[0] !== customerId) {
    return { ok: false as const, error: 'Task does not belong to this customer.' };
  }

  // Write Customer first so the platform email is visible if the task update
  // races with someone reading the customer record.
  await updateCustomerFields(customerId, {
    platformEmail: trimmed,
    accountCreated: true,
  });

  await updateTaskFields(taskId, {
    status: 'Completed',
    completedAt: new Date(),
  });

  // Non-fatal audit event — don't block on logging.
  try {
    await createEvent(
      customerId,
      'Task Completed',
      'Team Member',
      `Account created with platform email ${trimmed}.`,
      taskId,
      session.memberId,
    );
  } catch (err) {
    console.warn('Event log failed (non-fatal):', err);
  }

  revalidatePath(`/workspace/customers/${customerId}`);
  revalidatePath('/workspace/account-queue');
  return { ok: true as const };
}
