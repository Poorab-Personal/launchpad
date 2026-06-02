/**
 * Synchronous asset import — download a B2B agent's roster photo + the
 * brokerage's master logo to Vercel Blob and write the attachment metadata
 * onto the freshly-created customer row.
 *
 * Called with `await` from POST /api/agent-lookup BEFORE the redirect is
 * returned, so assets are guaranteed persisted by the time the agent loads
 * /r/[token]. Was previously fire-and-forget; changed 2026-06-02 because the
 * portal form captured an empty file state at first render and never
 * re-hydrated when the background import finished — see
 * docs/integrations/dmg-roster-plan.md §4.2 + agent_photo_strategy note.
 *
 * Source URLs (DMG photo CDN, brokerage master logo) are not durable, so we
 * copy them to Blob and serve the stable Blob URL in the portal. Result shape
 * matches the existing Blob attachment shape used everywhere else:
 *   [{ url, filename, size, contentType }]
 *
 * Failure mode: log + continue. A failed download leaves the slot blank; the
 * agent uploads manually on the intake form via the existing FileUploadTask.
 * Never throws to the caller — verification already succeeded.
 */
import { put } from '@vercel/blob';
import { updateCustomerFields } from '@/lib/db';

interface BlobAttachment {
  url: string;
  filename: string;
  size: number;
  contentType: string;
}

const ALLOWED_IMAGE_PREFIX = 'image/';
const MAX_ASSET_SIZE = 10_000_000; // 10MB — generous ceiling for a headshot/logo

function extensionForContentType(contentType: string): string {
  const base = contentType.split(';')[0].trim().toLowerCase();
  switch (base) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/svg+xml':
      return 'svg';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    default:
      return base.split('/')[1]?.split('+')[0] ?? 'bin';
  }
}

/**
 * Download a single remote URL → Vercel Blob. Returns the attachment metadata
 * or null on any failure (network, non-OK, non-image, oversize).
 */
async function downloadToBlob(
  sourceUrl: string,
  filenameHint: string,
): Promise<BlobAttachment | null> {
  try {
    const res = await fetch(sourceUrl);
    if (!res.ok) {
      console.warn(
        `[roster import-assets] fetch ${filenameHint} HTTP ${res.status} ${res.statusText} (${sourceUrl})`,
      );
      return null;
    }

    const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
    if (!contentType.startsWith(ALLOWED_IMAGE_PREFIX)) {
      console.warn(
        `[roster import-assets] ${filenameHint} not an image (content-type: ${contentType}) — skipping`,
      );
      return null;
    }

    const data = await res.arrayBuffer();
    if (data.byteLength === 0 || data.byteLength > MAX_ASSET_SIZE) {
      console.warn(
        `[roster import-assets] ${filenameHint} size ${data.byteLength} out of range — skipping`,
      );
      return null;
    }

    // Derive a sensible extension from the content type. Special-case the
    // structured-suffix variants (image/svg+xml → svg) so we don't end up
    // with filenames like "business-logo.svg+xml" (the + URL-encodes to %2B
    // and confuses extension-based content-type sniffing downstream).
    const ext = extensionForContentType(contentType);
    const filename = `${filenameHint}.${ext}`;

    const blob = await put(filename, Buffer.from(data), {
      access: 'public',
      addRandomSuffix: true,
      contentType,
    });

    return {
      url: blob.url,
      filename,
      size: data.byteLength,
      contentType,
    };
  } catch (err) {
    console.error(`[roster import-assets] ${filenameHint} download failed`, err);
    return null;
  }
}

/**
 * Fire-and-forget: import the agent photo + brokerage logo for a newly-created
 * roster customer. Each download is independent — one failing does not block
 * the other. Writes only the slots that succeeded.
 */
export async function importRosterCustomerAssets(args: {
  customerId: string;
  photoUrl: string | null;
  masterLogoUrl: string | null;
}): Promise<void> {
  const { customerId, photoUrl, masterLogoUrl } = args;

  const [photo, logo] = await Promise.all([
    photoUrl ? downloadToBlob(photoUrl, 'agent-photo') : Promise.resolve(null),
    masterLogoUrl ? downloadToBlob(masterLogoUrl, 'business-logo') : Promise.resolve(null),
  ]);

  const fields: { agentPhoto?: BlobAttachment[]; businessLogo?: BlobAttachment[] } = {};
  if (photo) fields.agentPhoto = [photo];
  if (logo) fields.businessLogo = [logo];

  if (Object.keys(fields).length === 0) {
    console.warn(
      `[roster import-assets] no assets imported for customer ${customerId} (photo=${Boolean(photoUrl)}, logo=${Boolean(masterLogoUrl)})`,
    );
    return;
  }

  try {
    await updateCustomerFields(customerId, fields);
  } catch (err) {
    console.error(
      `[roster import-assets] failed to persist assets for customer ${customerId}`,
      err,
    );
  }
}
