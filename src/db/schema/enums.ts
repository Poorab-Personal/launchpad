import { pgEnum } from 'drizzle-orm/pg-core';

// Shared Postgres enums. One file because (a) several tables reference the
// same values, (b) Drizzle requires the pgEnum to be defined once per name.

export const customerTypeEnum = pgEnum('customer_type', ['D2C', 'B2B']);

export const designApprovalEnum = pgEnum('design_approval', [
  'Pending',
  'Approved',
  'Changes Requested',
]);

export const productTierEnum = pgEnum('product_tier', ['Premium', 'Luxury']);

export const paymentStatusEnum = pgEnum('payment_status', ['Paid', 'Waived']);

export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'Active',
  'Trial',
  'Past Due',
  'Cancelled',
]);

// at_risk_reason — extended closed enum coordinated with two plans.
// Payment-mode owns the first 5 (auto-cleared by Stripe / Calendly /
// approval / form webhooks). Engagement plan owns the last 6 (auto-cleared
// by the auto-recovered cron mechanism or CSM resolve).
// Precedence: 'Churned' > payment-mode reasons > engagement velocity reasons.
// See docs/integrations/engagement-data-plan.md §4.5.
export const atRiskReasonEnum = pgEnum('at_risk_reason', [
  'No CC',
  'No Booking',
  'No Approval',
  'No Form',
  'CSM Flagged',
  'Inactive',
  'Trial Ending',
  'Disengaged',
  'No Listings',
  'Engagement Falling',
  'Churned',
]);

export const atRiskSourceEnum = pgEnum('at_risk_source', [
  'engagement',
  'payment-mode',
  'csm',
]);
