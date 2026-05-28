/**
 * Async asset import — download a B2B agent's roster photo + the brokerage's
 * master logo to Vercel Blob and write the attachment metadata onto the
 * freshly-created customer row.
 *
 * Fire-and-forget from POST /api/agent-lookup AFTER the redirect response is
 * returned, so the verification round-trip stays fast (see
 * docs/integrations/dmg-roster-plan.md §4.2 + the agent_photo_strategy note).
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

    // Derive a sensible extension from the content type.
    const ext = contentType.split('/')[1]?.split(';')[0] ?? 'bin';
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
