import { NextRequest } from 'next/server';
import { updateTaskFields } from '@/lib/db';
import type { Task } from '@/types';

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

  const fields: Parameters<typeof updateTaskFields>[1] = {
    status: status as Task['status'],
  };
  if (status === 'Completed') {
    fields.completedAt = new Date();
  }
  if (notes !== undefined) {
    fields.notes = notes;
  }

  const task = await updateTaskFields(taskId, fields);

  return Response.json({ id: task.id, status: task.status });
}
