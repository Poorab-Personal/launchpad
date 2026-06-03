/**
 * POST /api/workspace/notes/sign
 *
 * Issues a short-lived client token so the browser can upload internal-note
 * attachments directly to Vercel Blob without routing bytes through our
 * function (4.5MB body cap). Mirrors design-proof/sign but scoped to a
 * customer (not a task) — any signed-in workspace user can attach to a
 * customer's notes thread.
 *
 * Flow:
 *   1. Client calls @vercel/blob/client `upload(filename, file, {
 *        access: 'public',
 *        handleUploadUrl: '/api/workspace/notes/sign',
 *        clientPayload: JSON.stringify({ customerId }),
 *      })`
 *   2. We validate the session + that the customer exists.
 *   3. Browser uploads each file directly to Blob.
 *   4. Client then POSTs the resulting URLs to the note-create endpoint to finalize.
 */
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { requireSession } from '@/lib/auth/dal';
import { getCustomerById } from '@/lib/db';

const MAX_FILE_SIZE = 10_000_000; // 10MB — comfortable for pasted screenshots
const ALLOWED_CONTENT_TYPES = ['image/*', 'application/pdf'];

type ClientPayload = {
  customerId: string;
};

export async function POST(request: Request): Promise<Response> {
  await requireSession();
  const body = (await request.json()) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (_pathname, clientPayloadRaw) => {
        if (!clientPayloadRaw) {
          throw new Error('Missing clientPayload (need customerId).');
        }
        let payload: ClientPayload;
        try {
          payload = JSON.parse(clientPayloadRaw) as ClientPayload;
        } catch {
          throw new Error('clientPayload is not valid JSON.');
        }
        if (!payload.customerId) {
          throw new Error('clientPayload requires customerId.');
        }

        const customer = await getCustomerById(payload.customerId);
        if (!customer) {
          throw new Error(`Customer ${payload.customerId} not found.`);
        }

        return {
          allowedContentTypes: ALLOWED_CONTENT_TYPES,
          maximumSizeInBytes: MAX_FILE_SIZE,
          // Pasted screenshots auto-name as `pasted-{ts}-{i}.png` and
          // collide across notes; user-picked files can collide too if the
          // same filename gets attached twice. Random suffix sidesteps both.
          addRandomSuffix: true,
          tokenPayload: clientPayloadRaw,
        };
      },
      onUploadCompleted: async () => {
        // Persistence happens when the client posts the assembled
        // attachments array to the note-create endpoint. Orphaned blobs
        // (modal closed mid-upload) are accepted as known debt — same
        // posture as the design-proof flow.
      },
    });
    return Response.json(jsonResponse);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Sign token failed';
    console.error('[notes sign] failed:', msg);
    return Response.json({ error: msg }, { status: 400 });
  }
}
