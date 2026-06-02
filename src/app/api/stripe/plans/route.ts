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
  // Short name for agent-facing copy. Falls back to brokerageName when not set
  // — so D2C / unconfigured brokerages still get a sensible value in templated
  // strings rather than an empty token.
  const brokerageShortName =
    brokerage?.shortName && brokerage.shortName.length > 0
      ? brokerage.shortName
      : brokerageName;

  // Templating: substitute {Name} and {shortName} tokens in EVERY brokerage-
  // facing string we ship — tagline, features, plan_name, billing_detail,
  // footnote, highlight. One row in workflow_templates / stripe_plans now
  // works for every brokerage; new brokerages need only their `brokerages`
  // record (with shortName + name) — the per-brokerage payment page renders
  // correctly without copy duplication.
  const subst = (s: string) =>
    s.replace(/\{shortName\}/g, brokerageShortName).replace(/\{Name\}/g, brokerageName);
  const substMaybe = (s: string | null | undefined) => (s ? subst(s) : s);
  const taglineTemplate =
    brokerage?.pricingTagline ??
    'Your AI social media assistant, exclusively for {Name} agents.';
  const tagline = subst(taglineTemplate);
  const substitutedFeatures = features.map(subst);
  const serializedPlans = plans.map(serializePlan).map((p) => ({
    ...p,
    planName: subst(p.planName),
    billingDetail: substMaybe(p.billingDetail),
    footnote: substMaybe(p.footnote),
    highlight: substMaybe(p.highlight),
  }));

  return Response.json({
    brokerageName,
    brokerageShortName,
    brokerageLogoUrl: brokerage?.masterLogoUrl || null,
    tagline,
    features: substitutedFeatures,
    trialDays,
    plans: serializedPlans,
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
