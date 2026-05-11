import { NextRequest } from 'next/server';
import {
  handleDesignApproved,
  handleDesignChangesRequested,
} from '@/lib/automations/design-approval';

/**
 * POST /api/customers/[id]/design-approval
 * body: { approval: 'Approved' | 'Changes Requested', feedback?: string }
 *
 * Thin dispatcher. Business logic lives in src/lib/automations/design-approval.ts.
 * Post-Phase-3 refactor — this route was the last @/lib/airtable-client
 * consumer (12 calls); now uses db.ts + new automation modules exclusively.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: customerId } = await params;
  const body = await request.json();
  const { approval, feedback } = body as {
    approval: 'Approved' | 'Changes Requested';
    feedback?: string;
  };

  if (!approval || !['Approved', 'Changes Requested'].includes(approval)) {
    return Response.json(
      { error: 'approval must be "Approved" or "Changes Requested"' },
      { status: 400 },
    );
  }

  if (approval === 'Approved') {
    const result = await handleDesignApproved(customerId, feedback);
    return Response.json({
      customerId,
      approval: 'Approved',
      taskCompleted: result.taskCompleted,
    });
  }

  const result = await handleDesignChangesRequested(customerId, feedback);
  return Response.json({
    customerId,
    approval: 'Changes Requested',
    round: result.round,
    tasksCreated: [result.taskNames.revise, result.taskNames.review, result.taskNames.upload],
  });
}
