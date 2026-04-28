import { NextRequest } from 'next/server';
import { updateRecord } from '@/lib/airtable-client';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await params;
  const body = await request.json();
  const { status, notes } = body as { status: string; notes?: string };

  if (!status) {
    return Response.json({ error: 'Missing required field: status' }, { status: 400 });
  }

  // Update status + optional notes (used for share links on upload tasks)
  const updatedFields: Record<string, unknown> = { Status: status };
  if (status === 'Completed') {
    updatedFields['Completed At'] = new Date().toISOString();
  }
  if (notes !== undefined) {
    updatedFields['Notes'] = notes;
  }

  const record = await updateRecord('Tasks', taskId, updatedFields);

  return Response.json({
    id: record.id,
    status,
  });
}
