/**
 * POST /api/workspace/design-proof/sign
 *
 * Issues a short-lived client token so the browser can upload directly to
 * Vercel Blob without routing the file bytes through our serverless function
 * (which has a 4.5MB request body cap — fatal for batch uploads of >5MB).
 *
 * Flow:
 *   1. Client calls @vercel/blob/client `upload(filename, file, {
 *        access: 'public',
 *        handleUploadUrl: '/api/workspace/design-proof/sign',
 *        clientPayload: JSON.stringify({ taskId, customerId }),
 *      })`
 *   2. Vercel's `upload()` POSTs to this route with `{ type: 'blob.generate-client-token', payload: { pathname, clientPayload, ... } }`
 *   3. We validate session + task ownership (the assignee or an Admin),
 *      then return a token with per-file size + content-type constraints.
 *   4. Browser uploads each file directly to Blob using that token.
 *   5. Client then POSTs the list of resulting URLs to `/api/workspace/design-proof` to finalize.
 *
 * Vercel ALSO calls back here with `{ type: 'blob.upload-completed' }` after
 * upload finishes. We don't rely on that for persistence (it would lose the
 * task-complete + email-trigger logic if a single file failed) — finalize is
 * an explicit step the client triggers. The completion callback is a no-op.
 *
 * Per docs/integrations/notes — bypasses 4.5MB function payload limit for
 * Kaushal's design uploads (33-file batch failed 2026-05-22).
 */
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { requireSession } from '@/lib/auth/dal';
import { getTaskById } from '@/lib/db';

const MAX_FILE_SIZE = 3_500_000; // 3.5MB — keep parity with prior server-route guard
const ALLOWED_CONTENT_TYPES = ['image/*', 'application/pdf'];

type ClientPayload = {
  taskId: string;
  customerId: string;
};

export async function POST(request: Request): Promise<Response> {
  const session = await requireSession();
  const body = (await request.json()) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (_pathname, clientPayloadRaw) => {
        if (!clientPayloadRaw) {
          throw new Error('Missing clientPayload (need taskId + customerId).');
        }
        let payload: ClientPayload;
        try {
          payload = JSON.parse(clientPayloadRaw) as ClientPayload;
        } catch {
          throw new Error('clientPayload is not valid JSON.');
        }
        if (!payload.taskId || !payload.customerId) {
          throw new Error('clientPayload requires taskId + customerId.');
        }

        // Validate the task exists, belongs to the customer, and the
        // caller is assigned (or an Admin).
        const task = await getTaskById(payload.taskId);
        if (!task) throw new Error(`Task ${payload.taskId} not found.`);
        if (task.customer[0] !== payload.customerId) {
          throw new Error('Task does not belong to this customer.');
        }
        if (session.role !== 'Admin' && !task.assignedTo.includes(session.memberId)) {
          throw new Error('Not assigned to you.');
        }

        return {
          allowedContentTypes: ALLOWED_CONTENT_TYPES,
          maximumSizeInBytes: MAX_FILE_SIZE,
          // Echo the payload back so the finalize step (and the upload-completed
          // callback below) can attribute the upload — though we don't actually
          // act on the callback today.
          tokenPayload: clientPayloadRaw,
        };
      },
      onUploadCompleted: async () => {
        // Persistence happens in the explicit finalize POST from the client
        // (POST /api/workspace/design-proof). Keeping this callback empty
        // avoids partial-batch races where 4-of-5 callbacks land but the
        // 5th file failed client-side. The client's finalize is the
        // single source of truth for "all files are in, mark task complete."
      },
    });
    return Response.json(jsonResponse);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Sign token failed';
    console.error('[design-proof sign] failed:', msg);
    return Response.json({ error: msg }, { status: 400 });
  }
}
