'use server';

import { revalidatePath } from 'next/cache';
import { requireSession } from '@/lib/auth/dal';
import { getCustomerById } from '@/lib/db';
import { handleTeamDesignMessage } from '@/lib/automations/design-message';
import type { InternalNoteAttachment } from '@/types';

/**
 * Team member sends a message to the customer in the design review.
 * Author = real session user (not the view-as ctx, so the trail records who
 * actually wrote it). Appends to designNotes + emails the customer. Does NOT
 * advance the task — a message is not an approval or a proof send.
 */
export async function sendDesignMessageAction(args: {
  customerId: string;
  body: string;
  attachments: InternalNoteAttachment[];
}) {
  const session = await requireSession();

  const body = (args.body ?? '').trim();
  const attachments = Array.isArray(args.attachments) ? args.attachments : [];

  if (body.length === 0 && attachments.length === 0) {
    return {
      ok: false as const,
      error: 'Message must have text or at least one attachment.',
    };
  }
  if (body.length > 5000) {
    return { ok: false as const, error: 'Message too long (5000 char max).' };
  }

  const customer = await getCustomerById(args.customerId);
  if (!customer) {
    return { ok: false as const, error: 'Customer not found.' };
  }

  await handleTeamDesignMessage({
    customerId: args.customerId,
    authorId: session.memberId,
    body,
    attachments,
  });

  revalidatePath(`/workspace/customers/${args.customerId}`);
  return { ok: true as const };
}
