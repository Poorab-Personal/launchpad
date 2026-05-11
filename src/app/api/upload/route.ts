import { NextRequest } from 'next/server';
import { put } from '@vercel/blob';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { customers } from '@/db/schema';
import { updateCustomerFields } from '@/lib/db';

// Per-field append limits. null = no limit. Fields not in this map are rejected.
// Keys are the request fieldName values; mapped to schema camelCase fields below.
const FIELD_LIMITS: Record<string, number | null> = {
  'Agent Photo': 10,
  'Business Logo': 10,
  'Other Assets': null,
};

const FIELD_NAME_TO_COLUMN: Record<string, 'agentPhoto' | 'businessLogo' | 'otherAssets'> = {
  'Agent Photo': 'agentPhoto',
  'Business Logo': 'businessLogo',
  'Other Assets': 'otherAssets',
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

  const column = FIELD_NAME_TO_COLUMN[fieldName];

  // Read jsonb directly (NOT via the mapper) so we round-trip the storage
  // shape — {url, filename, size, contentType} — without the mapper's
  // synthesized {id, type, width, height} fields polluting the next write.
  // Auditor 2026-05-11.
  const row = await db.query.customers.findFirst({
    where: eq(customers.id, customerId),
    columns: { agentPhoto: true, businessLogo: true, otherAssets: true },
  });
  if (!row) {
    return Response.json({ error: `Customer ${customerId} not found` }, { status: 404 });
  }
  const existing = (row[column] ?? []) as Array<Record<string, unknown>>;
  const limit = FIELD_LIMITS[fieldName];
  if (limit !== null && existing.length >= limit) {
    return Response.json(
      { error: `Maximum of ${limit} files reached for ${fieldName}. Remove some before adding more.` },
      { status: 409 },
    );
  }

  const blob = await put(file.name, file, { access: 'public', addRandomSuffix: true });

  // jsonb shape (matches Drizzle schema notes in customers.ts): an array of
  // { url, filename, size, contentType } objects.
  const newAttachment = {
    url: blob.url,
    filename: file.name,
    size: file.size,
    contentType: file.type,
  };
  const attachmentArray = [...existing, newAttachment];

  await updateCustomerFields(customerId, { [column]: attachmentArray });

  return Response.json({
    url: blob.url,
    filename: file.name,
    field: fieldName,
    count: attachmentArray.length,
  });
}
