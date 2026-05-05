import { NextRequest } from 'next/server';
import { updateRecord } from '@/lib/airtable-client';

/** Map camelCase field names to Airtable Title Case field names */
const fieldMap: Record<string, string> = {
  name: 'Name',
  contactEmail: 'Contact Email',
  platformEmail: 'Platform Email',
  phone: 'Phone',
  businessName: 'Business Name',
  businessAddress: 'Business Address',
  website: 'Website',
  serviceAreas: 'Service Areas',
  localContentAreas: 'Local Content Areas',
  bio: 'Bio',
  licenseNumber: 'License Number',
  topics: 'Topics',
  hashtags: 'Hashtags',
  gmbName: 'GMB Name',
  mlsIds: 'MLS IDs',
  specialInstructions: 'Special Instructions',
  hubspotDealId: 'HubSpot Deal ID',
  stripePaymentId: 'Stripe Payment ID',
  addOnStripePaymentId: 'Add-On Stripe Payment ID',
  productTier: 'Product Tier',
  paymentStatus: 'Payment Status',
  designApproval: 'Design Approval',
  designFeedback: 'Design Feedback',
  currentStage: 'Current Stage',
  stageEnteredAt: 'Stage Entered At',
  accountCreated: 'Account Created',
  credentialsSent: 'Credentials Sent',
  callBooked: 'Call Booked',
  callCompleted: 'Call Completed',
  callDate: 'Call Date',
  noShowCount: 'No Show Count',
  reminderCount: 'Reminder Count',
  designRevisionCount: 'Design Revision Count',
  otherEmails: 'Other Emails',
  feedbackRating: 'Feedback Rating',
  feedbackComments: 'Feedback Comments',
  hubspotContactUrl: 'HubSpot Contact URL',
  hubspotDealUrl: 'HubSpot Deal URL',
  dealValue: 'Deal Value',
  dealCloseDate: 'Deal Close Date',
  salesRep: 'Sales Rep',
  leadSource: 'Lead Source',
  subscriptionStatus: 'Subscription Status',
  billingCycle: 'Billing Cycle',
  mrr: 'MRR',
  renewalDate: 'Renewal Date',
  hasVoice: 'Has Voice',
  hasAvatar: 'Has Avatar',
  voiceStage: 'Voice Stage',
  avatarStage: 'Avatar Stage',
  voiceStripeId: 'Voice Stripe ID',
  avatarStripeId: 'Avatar Stripe ID',
};

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json();

  if (!body || typeof body !== 'object' || Object.keys(body).length === 0) {
    return Response.json({ error: 'Request body must contain fields to update' }, { status: 400 });
  }

  // Map camelCase keys to Airtable field names
  const airtableFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    const airtableKey = fieldMap[key];
    if (airtableKey) {
      airtableFields[airtableKey] = value;
    }
  }

  if (Object.keys(airtableFields).length === 0) {
    return Response.json({ error: 'No recognized fields to update' }, { status: 400 });
  }

  const record = await updateRecord('Customers', id, airtableFields);

  return Response.json({
    id: record.id,
    updated: Object.keys(airtableFields),
  });
}
