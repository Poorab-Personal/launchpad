import { NextRequest } from 'next/server';
import { getCustomerById, getStripePlanByPriceId, getWorkflowTemplates } from '@/lib/db';
import { createSetupIntent } from '@/lib/stripe';

/**
 * POST /api/customers/[id]/payment-setup
 * body: { stripePriceId: string }
 *
 * Validates that the chosen price ID corresponds to a plan for this
 * customer's workflow, then creates a Stripe SetupIntent and returns
 * the client_secret for Stripe Elements to confirm with.
 *
 * Does NOT yet save the selected plan to the Customer record — that
 * happens in /confirm after Stripe confirms the SetupIntent.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json();
  const { stripePriceId } = body as { stripePriceId?: string };

  if (!stripePriceId) {
    return Response.json({ error: 'stripePriceId is required' }, { status: 400 });
  }

  const customer = await getCustomerById(id);
  if (!customer) {
    return Response.json({ error: 'Customer not found' }, { status: 404 });
  }

  if (!customer.stripeCustomerId) {
    return Response.json(
      {
        error:
          'Customer has no Stripe Customer ID. This is set at customer creation for setup-intent-at-intake workflows. If missing, the customer creation step likely failed silently — see admin tools.',
      },
      { status: 400 },
    );
  }

  // Validate the chosen price ID matches this customer's workflow
  const plan = await getStripePlanByPriceId(stripePriceId);
  if (!plan || !plan.active) {
    return Response.json({ error: 'Invalid or inactive plan' }, { status: 400 });
  }
  if (plan.workflowKey !== customer.workflowKey) {
    return Response.json(
      { error: `Plan is for workflow ${plan.workflowKey}, customer is on ${customer.workflowKey}` },
      { status: 400 },
    );
  }

  // Validate the workflow is actually setup-intent-at-intake (defense in depth)
  const templates = await getWorkflowTemplates(customer.workflowKey);
  const paymentMode = templates[0]?.paymentMode;
  if (paymentMode !== 'setup-intent-at-intake') {
    return Response.json(
      { error: `Workflow ${customer.workflowKey} payment mode is ${paymentMode}, not setup-intent-at-intake` },
      { status: 400 },
    );
  }

  const setupIntent = await createSetupIntent({
    stripeCustomerId: customer.stripeCustomerId,
    airtableCustomerId: customer.id,
  });

  return Response.json({
    clientSecret: setupIntent.client_secret,
    setupIntentId: setupIntent.id,
    plan: { id: plan.id, name: plan.planName, priceId: plan.stripePriceId },
  });
}
