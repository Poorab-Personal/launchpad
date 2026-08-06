/**
 * POST /api/r/[token]/messages/sign
 *
 * Token-authorized client-upload sign for customer-side design-message
 * attachments. Mirrors /api/workspace/notes/sign but authorizes by the portal
 * accessToken in the URL (customers have no session) instead of requireSession.
 * The customer is resolved from the token, never trusted from client input.
 */
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { getCustomerByToken } from '@/lib/db';

const MAX_FILE_SIZE = 10_000_000; // 10MB
const ALLOWED_CONTENT_TYPES = ['image/*', 'application/pdf'];

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  const customer = await getCustomerByToken(token);
  if (!customer) {
    return Response.json({ error: 'Invalid portal link.' }, { status: 404 });
  }

  const body = (await request.json()) as HandleUploadBody;
  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ALLOWED_CONTENT_TYPES,
        maximumSizeInBytes: MAX_FILE_SIZE,
        // Pasted screenshots auto-name identically and collide; random suffix
        // sidesteps it. Same posture as the internal-notes sign route.
        addRandomSuffix: true,
        tokenPayload: JSON.stringify({ customerId: customer.id }),
      }),
      onUploadCompleted: async () => {
        // Persistence happens when the client POSTs the assembled attachments
        // to /api/r/[token]/messages. Orphaned blobs (composer abandoned
        // mid-upload) are accepted debt — same as the notes / design-proof flow.
      },
    });
    return Response.json(jsonResponse);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Sign token failed';
    console.error('[r messages sign] failed:', msg);
    return Response.json({ error: msg }, { status: 400 });
  }
}
