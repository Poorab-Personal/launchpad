import { NextRequest } from 'next/server';
import { getCustomerById, updateCustomerFields, updateTaskStatus } from '@/lib/db';

/**
 * POST /api/customers/[id]/payment-setup/confirm
 * body: { stripePriceId: string, planName: string, taskId: string }
 *
 * Called from PaymentSetupTask AFTER the client-side Stripe Elements
 * confirmSetup() succeeds. Records the customer's plan choice + marks
 * the Capture Payment Method task complete.
 *
 * Phase 1.7's Stripe webhook will do this same work server-side as a
 * safety net (idempotent — no-op if task is already Completed).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json();
  const { stripePriceId, planName, taskId } = body as {
    stripePriceId?: string;
    planName?: string;
    taskId?: string;
  };

  if (!stripePriceId || !planName || !taskId) {
    return Response.json(
      { error: 'stripePriceId, planName, and taskId are required' },
      { status: 400 },
    );
  }

  const customer = await getCustomerById(id);
  if (!customer) {
    return Response.json({ error: 'Customer not found' }, { status: 404 });
  }

  // Idempotent: if already saved, return success
  if (customer.selectedStripePriceId === stripePriceId) {
    return Response.json({ ok: true, alreadyRecorded: true });
  }

  await updateCustomerFields(id, {
    selectedStripePriceId: stripePriceId,
    selectedPlanName: planName,
  });

  // Mark the task Completed (Auto 2 will then unblock dependents — Phase 3)
  await updateTaskStatus(taskId, 'Completed');

  return Response.json({ ok: true });
}
