import { NextRequest } from 'next/server';
import { put } from '@vercel/blob';
import { getRecord, updateRecord } from '@/lib/airtable-client';

const ALLOWED_FIELDS = ['Agent Photo', 'Business Logo', 'Other Assets'];
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

  if (!ALLOWED_FIELDS.includes(fieldName)) {
    return Response.json(
      { error: `Invalid fieldName. Must be one of: ${ALLOWED_FIELDS.join(', ')}` },
      { status: 400 },
    );
  }

  if (file.size > MAX_FILE_SIZE) {
    return Response.json(
      { error: `File too large (${(file.size / 1_000_000).toFixed(1)}MB). Maximum is 3.5MB. Please use the share link option for larger files.` },
      { status: 413 },
    );
  }

  // Upload to Vercel Blob
  const blob = await put(file.name, file, { access: 'public' });

  // Build the attachment value for Airtable
  const newAttachment = { url: blob.url, filename: file.name };

  let attachmentArray;

  if (fieldName === 'Other Assets') {
    // Multi-file field — read existing attachments and append
    const record = await getRecord('Customers', customerId);
    const existing = record.fields[fieldName];
    if (Array.isArray(existing) && existing.length > 0) {
      // Keep existing attachments (Airtable returns {id, url, filename, ...})
      // When writing back, Airtable accepts [{url}] — existing ones with {id} are preserved
      attachmentArray = [...existing, newAttachment];
    } else {
      attachmentArray = [newAttachment];
    }
  } else {
    // Single-file field — replace
    attachmentArray = [newAttachment];
  }

  // Write to Airtable attachment field
  await updateRecord('Customers', customerId, {
    [fieldName]: attachmentArray,
  });

  return Response.json({
    url: blob.url,
    filename: file.name,
    field: fieldName,
  });
}
