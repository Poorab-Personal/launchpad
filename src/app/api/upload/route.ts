import { NextRequest } from 'next/server';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';

/**
 * File upload endpoint.
 *
 * Local dev: stores files in public/uploads/ and returns local URLs.
 *   - Files are viewable in the portal but NOT written to Airtable attachments
 *     (Airtable can't reach localhost).
 *
 * Production (S3): upload to S3, return public URLs, write to Airtable attachment fields.
 *   - TODO: swap local storage for S3 SDK when deploying.
 */

const UPLOAD_DIR = join(process.cwd(), 'public', 'uploads');
const IS_PROD = process.env.NODE_ENV === 'production';

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const files = formData.getAll('files') as File[];

  if (files.length === 0) {
    return Response.json({ error: 'No files provided' }, { status: 400 });
  }

  await mkdir(UPLOAD_DIR, { recursive: true });

  const uploaded: Array<{ url: string; filename: string }> = [];

  for (const file of files) {
    if (!file.name || file.size === 0) continue;

    const ext = file.name.split('.').pop() || 'bin';
    const uniqueName = `${randomUUID()}.${ext}`;
    const buffer = Buffer.from(await file.arrayBuffer());

    if (IS_PROD) {
      // TODO: Upload to S3 instead of local filesystem
      // const s3Url = await uploadToS3(buffer, uniqueName, file.type);
      // uploaded.push({ url: s3Url, filename: file.name });

      // For now, same as dev
      const filePath = join(UPLOAD_DIR, uniqueName);
      await writeFile(filePath, buffer);
      uploaded.push({ url: `/uploads/${uniqueName}`, filename: file.name });
    } else {
      // Local dev: store in public/uploads/
      const filePath = join(UPLOAD_DIR, uniqueName);
      await writeFile(filePath, buffer);
      uploaded.push({ url: `/uploads/${uniqueName}`, filename: file.name });
    }
  }

  return Response.json({ files: uploaded });
}
