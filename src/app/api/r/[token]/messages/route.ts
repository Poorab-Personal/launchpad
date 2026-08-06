/**
 * POST /api/r/[token]/messages
 * body: { body?: string, attachments?: InternalNoteAttachment[] }
 *
 * Customer posts a reply into the design conversation. Token-authorized (the
 * accessToken in the URL resolves the customer; customerId is never trusted
 * from the client). Thin dispatcher → handleCustomerDesignMessage.
 *
 * Team-initiates guard: a customer can only reply once the team has started the
 * thread (there is at least one designer note). Belt-and-suspenders — the
 * portal only shows the composer once a conversation exists.
 */
import { getCustomerByToken } from '@/lib/db';
import { handleCustomerDesignMessage } from '@/lib/automations/design-message';
import type { InternalNoteAttachment } from '@/types';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  const customer = await getCustomerByToken(token);
  if (!customer) {
    return Response.json({ error: 'Invalid portal link.' }, { status: 404 });
  }

  const raw = (await request.json().catch(() => null)) as {
    body?: string;
    attachments?: InternalNoteAttachment[];
  } | null;

  const body = (raw?.body ?? '').trim();
  const attachments = Array.isArray(raw?.attachments) ? raw!.attachments : [];

  if (body.length === 0 && attachments.length === 0) {
    return Response.json(
      { error: 'Message must have text or at least one attachment.' },
      { status: 400 },
    );
  }
  if (body.length > 5000) {
    return Response.json({ error: 'Message too long (5000 char max).' }, { status: 400 });
  }

  // Team-initiates guard: the customer can only reply once the team has sent
  // them something — a designer note or a proof to review. Prevents opening a
  // thread out of nowhere.
  const initiated =
    (customer.designNotes ?? []).some((n) => n.from === 'designer') ||
    (customer.designProof ?? []).length > 0;
  if (!initiated) {
    return Response.json(
      { error: 'No conversation started yet.' },
      { status: 409 },
    );
  }

  await handleCustomerDesignMessage({ customerId: customer.id, body, attachments });
  return Response.json({ ok: true });
}
