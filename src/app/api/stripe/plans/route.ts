import { NextRequest } from 'next/server';
import {
  getStripePlansByWorkflow,
  getCustomerById,
  getBrokerageById,
  getBrokerageByDefaultWorkflowKey,
  getWorkflowTemplates,
} from '@/lib/db';
import type { StripePlan } from '@/types';

/**
 * GET /api/stripe/plans?customerId=recXXX
 *
 * Returns the full pricing-page payload for a customer's payment-setup task:
 * brokerage name, tagline (with `{Name}` substituted), feature bullets,
 * trial days, and active Stripe plans (sorted by Display Order).
 *
 * The customer's workflow + brokerage are derived server-side. Brokerage
 * resolution: `Customer.Brokerage[0]` if present (B2B), else
 * `getBrokerageByDefaultWorkflowKey(workflowKey)` as a fallback. If neither
 * resolves (e.g. D2C with no brokerage row), we return generic Rejig defaults
 * so the UI still renders.
 */
export async function GET(request: NextRequest) {
  const customerId = request.nextUrl.searchParams.get('customerId');
  if (!customerId) {
    return Response.json({ error: 'customerId query param is required' }, { status: 400 });
  }

  const customer = await getCustomerById(customerId);
  if (!customer) {
    return Response.json({ error: 'Customer not found' }, { status: 404 });
  }
  const workflowKey = customer.workflowKey;
  if (!workflowKey) {
    return Response.json({ error: 'Customer has no Workflow Key' }, { status: 400 });
  }

  const [plans, templates, brokerage] = await Promise.all([
    getStripePlansByWorkflow(workflowKey),
    getWorkflowTemplates(workflowKey),
    resolveBrokerage(customer.brokerage[0], workflowKey),
  ]);

  const trialDays = templates[0]?.trialDays ?? 0;
  const features = parseFeatures(templates[0]?.planFeatures ?? '');

  const brokerageName = brokerage?.name ?? 'Rejig.ai';
  const taglineTemplate =
    brokerage?.pricingTagline ??
    'Your AI social media assistant, exclusively for {Name} agents.';
  const tagline = taglineTemplate.replace(/\{Name\}/g, brokerageName);

  return Response.json({
    brokerageName,
    tagline,
    features,
    trialDays,
    plans: plans.map(serializePlan),
  });
}

async function resolveBrokerage(
  customerBrokerageId: string | undefined,
  workflowKey: string,
) {
  if (customerBrokerageId) {
    const b = await getBrokerageById(customerBrokerageId);
    if (b) return b;
  }
  return getBrokerageByDefaultWorkflowKey(workflowKey);
}

function parseFeatures(raw: string): string[] {
  return raw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function serializePlan(p: StripePlan) {
  return {
    id: p.id,
    stripePriceId: p.stripePriceId,
    planName: p.planName,
    priceDisplay: p.priceDisplay,
    pricePeriod: p.pricePeriod,
    billingDetail: p.billingDetail,
    footnote: p.footnote,
    highlight: p.highlight,
  };
}
