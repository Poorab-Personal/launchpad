'use server';

import { revalidatePath } from 'next/cache';
import { requireSession } from '@/lib/auth/dal';
import {
  createCall,
  updateCall,
  createEvent,
  getCallById,
  getCustomerById,
} from '@/lib/db';
import type { CallType, CallStatus, Call } from '@/types';

const CSM_ROLES = new Set(['CSM', 'Senior CSM', 'Admin']);

const VALID_TYPES: CallType[] = ['Onboarding', 'Check-In 1', 'Check-In 2', 'Ad-hoc'];
const VALID_STATUSES: CallStatus[] = [
  'Scheduled',
  'Completed',
  'No Show',
  'Rescheduled',
  'Canceled',
];

/**
 * Verify the call exists and the linked customer matches `expectedCustomerId`.
 * Returns the call's customer ID on success, throws on mismatch.
 */
async function assertCallBelongsToCustomer(
  callId: string,
  expectedCustomerId?: string,
): Promise<string> {
  const call = await getCallById(callId);
  if (!call) throw new Error('Call not found.');
  const customerId = call.customer[0];
  if (!customerId) throw new Error('Call has no linked customer.');
  if (expectedCustomerId && customerId !== expectedCustomerId) {
    throw new Error('Call does not belong to this customer.');
  }
  return customerId;
}

/**
 * Log an ad-hoc call (or any call type) from the customer detail page.
 * Gated to CSM / Senior CSM / Admin.
 *
 * Form fields:
 *   customerId (hidden, required)
 *   type, scheduledDate, status, csmId (optional), notes, recordingUrl
 */
export async function logCall(formData: FormData) {
  const session = await requireSession();
  if (!CSM_ROLES.has(session.role)) {
    return { ok: false as const, error: 'Forbidden.' };
  }

  const customerId = String(formData.get('customerId') ?? '').trim();
  if (!customerId) {
    return { ok: false as const, error: 'Missing customer ID.' };
  }

  // Verify customer exists
  const customer = await getCustomerById(customerId);
  if (!customer) {
    return { ok: false as const, error: 'Customer not found.' };
  }

  const typeRaw = String(formData.get('type') ?? 'Ad-hoc');
  const type: CallType = (VALID_TYPES as string[]).includes(typeRaw)
    ? (typeRaw as CallType)
    : 'Ad-hoc';

  const statusRaw = String(formData.get('status') ?? '');
  let status: CallStatus;
  if ((VALID_STATUSES as string[]).includes(statusRaw)) {
    status = statusRaw as CallStatus;
  } else {
    status = type === 'Ad-hoc' ? 'Completed' : 'Scheduled';
  }

  const scheduledDateRaw = String(formData.get('scheduledDate') ?? '').trim();
  let scheduledDate = '';
  if (scheduledDateRaw) {
    const d = new Date(scheduledDateRaw);
    if (!Number.isNaN(d.getTime())) {
      scheduledDate = d.toISOString();
    }
  }
  if (!scheduledDate) {
    scheduledDate = new Date().toISOString();
  }

  const csmIdRaw = String(formData.get('csmId') ?? '').trim();
  const csmId =
    csmIdRaw && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(csmIdRaw)
      ? csmIdRaw
      : session.memberId;

  const notes = String(formData.get('notes') ?? '').trim();
  const recordingUrl = String(formData.get('recordingUrl') ?? '').trim();

  const fields: Partial<Call> = {
    title: `${type} — ${customer.name}`.trim(),
    customer: [customerId],
    type,
    status,
    scheduledDate,
    csm: [csmId],
  };
  if (notes) fields.notes = notes;
  if (recordingUrl) fields.recordingUrl = recordingUrl;

  let created: Call;
  try {
    created = await createCall(fields);
  } catch (err) {
    return {
      ok: false as const,
      error: err instanceof Error ? err.message : 'Failed to create call.',
    };
  }

  // Non-fatal audit event. "Call Logged" may not exist as a select option;
  // fall back to "Task Completed" if it doesn't, swallow on error.
  try {
    await createEvent(
      customerId,
      'Call Logged',
      'Team Member',
      `Logged ${type} call (${status}) on ${scheduledDate}.`,
      undefined,
      session.memberId,
    );
  } catch {
    try {
      await createEvent(
        customerId,
        'Task Completed',
        'Team Member',
        `Logged ${type} call (${status}) on ${scheduledDate}.`,
        undefined,
        session.memberId,
      );
    } catch {
      // ignore — audit logging is non-fatal
    }
  }

  revalidatePath(`/workspace/customers/${customerId}`);
  revalidatePath('/workspace/book');
  return { ok: true as const, callId: created.id };
}

/**
 * Update the Notes field on a Call. Gated to CSM/Admin/Senior CSM.
 * Verifies the call belongs to a real customer the session can act on.
 */
export async function updateCallNotes(
  callId: string,
  notes: string,
  customerId?: string,
) {
  const session = await requireSession();
  if (!CSM_ROLES.has(session.role)) {
    return { ok: false as const, error: 'Forbidden.' };
  }

  if (!callId || typeof callId !== 'string') {
    return { ok: false as const, error: 'Missing call ID.' };
  }

  let resolvedCustomerId: string;
  try {
    resolvedCustomerId = await assertCallBelongsToCustomer(callId, customerId);
  } catch (err) {
    return {
      ok: false as const,
      error: err instanceof Error ? err.message : 'Call validation failed.',
    };
  }

  try {
    await updateCall(callId, { notes: notes ?? '' });
  } catch (err) {
    return {
      ok: false as const,
      error: err instanceof Error ? err.message : 'Failed to update call.',
    };
  }

  revalidatePath(`/workspace/customers/${resolvedCustomerId}`);
  return { ok: true as const };
}

/**
 * Update the Recording URL on a Call. Gated to CSM/Admin/Senior CSM.
 */
export async function updateCallRecording(
  callId: string,
  url: string,
  customerId?: string,
) {
  const session = await requireSession();
  if (!CSM_ROLES.has(session.role)) {
    return { ok: false as const, error: 'Forbidden.' };
  }

  if (!callId || typeof callId !== 'string') {
    return { ok: false as const, error: 'Missing call ID.' };
  }

  // Light URL validation — allow empty (clear) or a recognizable URL.
  const trimmed = (url ?? '').trim();
  if (trimmed && !/^https?:\/\//i.test(trimmed)) {
    return { ok: false as const, error: 'Recording URL must start with http(s)://' };
  }

  let resolvedCustomerId: string;
  try {
    resolvedCustomerId = await assertCallBelongsToCustomer(callId, customerId);
  } catch (err) {
    return {
      ok: false as const,
      error: err instanceof Error ? err.message : 'Call validation failed.',
    };
  }

  try {
    await updateCall(callId, { recordingUrl: trimmed });
  } catch (err) {
    return {
      ok: false as const,
      error: err instanceof Error ? err.message : 'Failed to update call.',
    };
  }

  revalidatePath(`/workspace/customers/${resolvedCustomerId}`);
  return { ok: true as const };
}
