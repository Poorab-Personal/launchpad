import { NextRequest } from 'next/server';
import { updateRecord } from '@/lib/airtable-client';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await params;
  const body = await request.json();
  const { status } = body as { status: string };

  if (!status) {
    return Response.json({ error: 'Missing required field: status' }, { status: 400 });
  }

  // Just update the status — Airtable automations handle everything else:
  // Auto 2: dependency activation + stage advancement
  // Auto 3: In Review interception (if re-enabled)
  const updatedFields: Record<string, unknown> = { Status: status };
  if (status === 'Completed') {
    updatedFields['Completed At'] = new Date().toISOString();
  }

  const record = await updateRecord('Tasks', taskId, updatedFields);

  return Response.json({
    id: record.id,
    status,
  });
}
