'use server';

import { revalidatePath } from 'next/cache';
import { requireSession } from '@/lib/auth/dal';
import { createInternalNote, getCustomerById } from '@/lib/db';
import type { InternalNoteAttachment } from '@/types';

/**
 * Create an internal note on a customer. Customer-scoped, append-only.
 * Author = real session user (not the view-as ctx, so impersonating an
 * Admin still leaves the actual author trail intact). Visible inside
 * /workspace only; never to customers.
 */
export async function createInternalNoteAction(args: {
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
      error: 'Note must have a body or at least one attachment.',
    };
  }
  if (body.length > 5000) {
    return { ok: false as const, error: 'Note body too long (5000 char max).' };
  }

  const customer = await getCustomerById(args.customerId);
  if (!customer) {
    return { ok: false as const, error: 'Customer not found.' };
  }

  await createInternalNote({
    customerId: args.customerId,
    authorId: session.memberId,
    body,
    attachments,
  });

  revalidatePath(`/workspace/customers/${args.customerId}`);
  return { ok: true as const };
}
