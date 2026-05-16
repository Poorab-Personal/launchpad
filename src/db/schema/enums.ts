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

export const teamRoleEnum = pgEnum('team_role', [
  'Designer',
  'Senior Designer',
  'CSM',
  'Senior CSM',
  'Account Creator',
  'Sales',
  'Admin',
]);

export const onboardingStatusEnum = pgEnum('onboarding_status', [
  'Not Started',
  'In Progress',
  'Completed',
]);

export const actorTypeEnum = pgEnum('actor_type', [
  'Customer',
  'Team Member',
  'System',
]);

export const taskStatusEnum = pgEnum('task_status', [
  'Draft',
  'Active',
  'In Review',
  'Completed',
  'Rejected',
]);

export const taskTypeEnum = pgEnum('task_type', ['Client', 'Team']);

export const attachmentTypeEnum = pgEnum('attachment_type', [
  'None',
  'Form',
  'File Upload',
  'Embed',
  'Proof',
  'Payment Setup',
]);

export const productEnum = pgEnum('product', ['Core', 'Voice', 'Avatar']);

// Payment source for a customer subscription row.
// 'stripe' — Stripe Subscription drives billing (Keyes, D2C, historical D2C-canceled).
// 'invoice' — direct invoice (B&W master agreement; future enterprise customers).
// NULL — unknown / demo (no payment arrangement).
export const paymentSourceEnum = pgEnum('payment_source_enum', ['stripe', 'invoice']);

// Billing relationship — distinguishes:
//   'paying'         — normal customer billed via Stripe or invoice
//   'comped'         — real user, billing waived (sponsor exec, brokerage comp,
//                      UniqueCollective, IPRE, Tristan, VP Group, NEXT, etc.)
//   'internal_demo'  — Rejig-internal account (sales demos, dev testing, showcase).
//                      BI cron skips these entirely.
//
// Default: 'paying' (set via column default). New customers created via the
// D2C closedwon webhook, /api/customers, or LP brokerage intake automatically
// land as 'paying' because they have a Stripe customer at creation. LP admin
// can manually override to 'comped' or 'internal_demo'.
export const billingRelationshipEnum = pgEnum('billing_relationship_enum', [
  'paying',
  'comped',
  'internal_demo',
]);

export const paymentModeEnum = pgEnum('payment_mode', [
  'pre-paid',
  'setup-intent-at-intake',
  'invoice',
  'none',
]);

export const callTypeEnum = pgEnum('call_type', [
  'Onboarding',
  'Check-In 1',
  'Check-In 2',
  'Ad-hoc',
]);

export const callStatusEnum = pgEnum('call_status', [
  'Scheduled',
  'Completed',
  'No Show',
  'Rescheduled',
  'Canceled',
]);
