import { NextRequest } from 'next/server';
import { updateCustomerFields } from '@/lib/db';

// Whitelist of customer fields the PATCH endpoint accepts. Anything outside
// this list is silently dropped (prevents accidental writes to system fields
// like access_token, id, created_at). The fieldMap Title-Case translation
// from the airtable.ts era is gone — Drizzle accepts camelCase directly.
const ALLOWED: ReadonlySet<string> = new Set([
  'name',
  'contactEmail',
  'platformEmail',
  'phone',
  'businessName',
  'businessAddress',
  'website',
  'serviceAreas',
  'localContentAreas',
  'bio',
  'licenseNumber',
  'topics',
  'hashtags',
  'gmbName',
  'mlsIds',
  'specialInstructions',
  'hubspotDealId',
  'stripePaymentId',
  'addOnStripePaymentId',
  'productTier',
  'paymentStatus',
  'designApproval',
  'designFeedback',
  'currentStage',
  'stageEnteredAt',
  'accountCreated',
  'credentialsSent',
  'callBooked',
  'callCompleted',
  'callDate',
  'noShowCount',
  'designRevisionCount',
  'otherEmails',
  'subscriptionStatus',
  'billingCycle',
  'mrr',
  'renewalDate',
  'hasVoice',
  'hasAvatar',
  'voiceStage',
  'avatarStage',
  'voiceStripeId',
  'avatarStripeId',
  'stripeCustomerId',
  'stripeSubscriptionId',
  'selectedStripePriceId',
  'selectedPlanName',
  'atRisk',
  'atRiskReason',
  'feedbackRating',
  'feedbackComments',
]);

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json();

  if (!body || typeof body !== 'object' || Object.keys(body).length === 0) {
    return Response.json({ error: 'Request body must contain fields to update' }, { status: 400 });
  }

  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (ALLOWED.has(key)) fields[key] = value;
  }

  if (Object.keys(fields).length === 0) {
    return Response.json({ error: 'No recognized fields to update' }, { status: 400 });
  }

  const customer = await updateCustomerFields(id, fields);

  return Response.json({
    id: customer.id,
    updated: Object.keys(fields),
  });
}
