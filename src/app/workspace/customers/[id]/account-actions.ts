'use server';

import { revalidatePath } from 'next/cache';
import { requireSession } from '@/lib/auth/dal';
import { getRecord, updateRecord } from '@/lib/airtable-client';
import { createEvent } from '@/lib/airtable';
import { render } from '@react-email/render';
import * as React from 'react';
import CredentialsSentEmail from '@/lib/email/templates/credentials-sent';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function linkedId(field: unknown): string | null {
  if (!Array.isArray(field) || field.length === 0) return null;
  const first = field[0];
  return typeof first === 'string' ? first : (first as { id: string })?.id ?? null;
}

function assignedIdsOf(field: unknown): string[] {
  if (!Array.isArray(field)) return [];
  return field.map((a) => (typeof a === 'string' ? a : (a as { id: string }).id));
}

function isAuthorized(role: string, assignedIds: string[], memberId: string): boolean {
  // Admin or Account Creator (and assigned)
  if (role === 'Admin') return true;
  if (role !== 'Account Creator') return false;
  return assignedIds.includes(memberId);
}

/**
 * Mark the "Create Customer Account" task complete and stamp the platform
 * email + flag onto the Customer record. Auto 2 picks up the task status
 * change and activates dependent tasks (e.g. Send Credentials).
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

  const task = await getRecord('Tasks', taskId);
  const assignedIds = assignedIdsOf(task.fields['Assigned To']);

  if (!isAuthorized(session.role, assignedIds, session.memberId)) {
    return { ok: false as const, error: 'Not assigned to you.' };
  }

  if (linkedId(task.fields['Customer']) !== customerId) {
    return { ok: false as const, error: 'Task does not belong to this customer.' };
  }

  // Write Customer first so the platform email is visible if the task update
  // races with someone reading the customer record.
  await updateRecord('Customers', customerId, {
    'Platform Email': trimmed,
    'Account Created': true,
  });

  await updateRecord('Tasks', taskId, {
    Status: 'Completed',
    'Completed At': new Date().toISOString(),
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

/**
 * Render the credentials-sent email template to HTML server-side.
 * Used by the SendCredentialsAction component to show a live preview
 * before sending. Returns HTML string for `dangerouslySetInnerHTML`.
 */
export async function renderCredentialsPreview(args: {
  firstName: string;
  portalUrl: string;
  platformEmail: string;
  password: string;
}): Promise<string> {
  // Gate to authenticated workspace users — the action is exposed via the
  // browser otherwise (Next.js server actions are POST-able from anywhere).
  await requireSession();
  return render(
    React.createElement(CredentialsSentEmail, {
      firstName: args.firstName,
      portalUrl: args.portalUrl,
      platformEmail: args.platformEmail,
      password: args.password,
    }),
  );
}
