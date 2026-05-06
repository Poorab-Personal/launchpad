import { NextRequest } from 'next/server';
import { put } from '@vercel/blob';
import { getRecord, updateRecord } from '@/lib/airtable-client';

// Per-field append limits. null = no limit. Fields not in this map are rejected.
const FIELD_LIMITS: Record<string, number | null> = {
  'Agent Photo': 10,
  'Business Logo': 10,
  'Other Assets': null,
};

const MAX_FILE_SIZE = 3_500_000; // 3.5MB — Vercel body limit is 4.5MB, leave room for multipart overhead

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const file = formData.get('file') as File | null;
  const customerId = formData.get('customerId') as string | null;
  const fieldName = formData.get('fieldName') as string | null;

  if (!file || !customerId || !fieldName) {
    return Response.json(
      { error: 'Missing required fields: file, customerId, fieldName' },
      { status: 400 },
    );
  }

  if (!(fieldName in FIELD_LIMITS)) {
    return Response.json(
      { error: `Invalid fieldName. Must be one of: ${Object.keys(FIELD_LIMITS).join(', ')}` },
      { status: 400 },
    );
  }

  if (file.size > MAX_FILE_SIZE) {
    return Response.json(
      { error: `File too large (${(file.size / 1_000_000).toFixed(1)}MB). Maximum is 3.5MB. Please use the share link option for larger files.` },
      { status: 413 },
    );
  }

  // Read existing attachments and append (preserves existing files)
  const record = await getRecord('Customers', customerId);
  const existingRaw = record.fields[fieldName];
  const existing = Array.isArray(existingRaw) ? existingRaw : [];

  const limit = FIELD_LIMITS[fieldName];
  if (limit !== null && existing.length >= limit) {
    return Response.json(
      { error: `Maximum of ${limit} files reached for ${fieldName}. Remove some before adding more.` },
      { status: 409 },
    );
  }

  // Upload to Vercel Blob with random suffix to avoid collisions on
  // duplicate filenames (now relevant since these fields append).
  const blob = await put(file.name, file, { access: 'public', addRandomSuffix: true });
  const newAttachment = { url: blob.url, filename: file.name };

  // Airtable preserves existing attachments when writing back as long as the
  // {id} fields are kept. The records returned from getRecord include {id},
  // so spreading them is safe.
  const attachmentArray = [...existing, newAttachment];

  await updateRecord('Customers', customerId, {
    [fieldName]: attachmentArray,
  });

  return Response.json({
    url: blob.url,
    filename: file.name,
    field: fieldName,
    count: attachmentArray.length,
  });
}
