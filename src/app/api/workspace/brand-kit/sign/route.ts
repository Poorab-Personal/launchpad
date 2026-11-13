/**
 * POST /api/workspace/brand-kit/sign
 *
 * Client token for uploading brand-kit logos straight to Vercel Blob.
 * Modelled on notes/sign: scoped to a customer, not a task, because the
 * Brand Kit card is editable at any point (D2C revisions change logos after
 * Create Designs completes). Deliberately NOT design-proof/sign — that one
 * needs an assigned Active task, accepts PDFs, and its finalize sibling
 * appends drafts and completes the task.
 *
 * Persistence happens afterwards in saveBrandKitLogoAction, which re-checks
 * the role and that the URL is ours. Rejig copies these files when the
 * account is created. Plan: docs/plans/rejig-account-sync.md.
 */
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { hasLiveRole, requireSession } from '@/lib/auth/dal';
import { getCustomerById } from '@/lib/db';
import { BRAND_KIT_EDITOR_ROLES } from '@/lib/brand-kit';

const MAX_FILE_SIZE = 10_000_000;
// PNG / JPEG / WebP only until Rejig confirms it can copy SVG.
const ALLOWED_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

export async function POST(request: Request): Promise<Response> {
  const session = await requireSession();
  const body = (await request.json()) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayloadRaw) => {
        if (!(await hasLiveRole(session, BRAND_KIT_EDITOR_ROLES))) {
          throw new Error('Only designers and account creators can upload brand-kit logos.');
        }
        let customerId = '';
        try {
          customerId = (JSON.parse(clientPayloadRaw ?? '{}') as { customerId?: string }).customerId ?? '';
        } catch {
          throw new Error('clientPayload is not valid JSON.');
        }
        if (!customerId) throw new Error('clientPayload requires customerId.');
        if (!(await getCustomerById(customerId))) {
          throw new Error(`Customer ${customerId} not found.`);
        }
        if (!pathname.startsWith(`brand-kit/${customerId}/`)) {
          throw new Error('Upload path must be brand-kit/{customerId}/…');
        }
        return {
          allowedContentTypes: ALLOWED_CONTENT_TYPES,
          maximumSizeInBytes: MAX_FILE_SIZE,
          addRandomSuffix: true,
          tokenPayload: clientPayloadRaw,
        };
      },
      onUploadCompleted: async () => {
        // Persisted by saveBrandKitLogoAction. A logo picked then abandoned
        // leaves an orphan blob — same accepted debt as notes/design-proof.
      },
    });
    return Response.json(jsonResponse);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Sign token failed';
    console.error('[brand-kit sign] failed:', msg);
    return Response.json({ error: msg }, { status: 400 });
  }
}
