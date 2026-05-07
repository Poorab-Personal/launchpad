import { NextRequest } from 'next/server';
import { getStripePlansByWorkflow } from '@/lib/airtable';

/**
 * GET /api/stripe/plans?workflowKey=B2B-Keyes
 *
 * Returns active Stripe Plans for a workflow. Used by the customer portal
 * to render plan options on the Capture Payment Method task.
 */
export async function GET(request: NextRequest) {
  const workflowKey = request.nextUrl.searchParams.get('workflowKey');
  if (!workflowKey) {
    return Response.json({ error: 'workflowKey query param is required' }, { status: 400 });
  }
  const plans = await getStripePlansByWorkflow(workflowKey);
  return Response.json({ plans });
}
