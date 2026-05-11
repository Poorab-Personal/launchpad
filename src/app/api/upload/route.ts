import { NextRequest } from 'next/server';
import { put } from '@vercel/blob';
import { getCustomerById, updateCustomerFields } from '@/lib/db';

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
  const customer = await getCustomerById(customerId);
  if (!customer) {
    return Response.json({ error: `Customer ${customerId} not found` }, { status: 404 });
  }

  // The mapper in db.ts hydrates jsonb rows into AirtableAttachment shape
  // ({id, url, filename}) for the Customer type, but the underlying jsonb
  // also carries size/contentType for downloads. Read the legacy-typed
  // attachments and round-trip them as the richer jsonb shape on write.
  const existing = (customer[column] ?? []) as unknown as Array<Record<string, unknown>>;
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
