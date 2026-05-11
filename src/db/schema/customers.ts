import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { channels } from './channels';
import {
  atRiskReasonEnum,
  atRiskSourceEnum,
  customerTypeEnum,
  designApprovalEnum,
  paymentStatusEnum,
  productTierEnum,
  subscriptionStatusEnum,
} from './enums';

// Mirrors Customer interface in src/types/index.ts. Regenerated from that
// source — not the schema doc (per Plan-agent review 2026-05-11, the doc was
// missing ~20 fields the app code actually reads).
//
// Cross-table FKs to brokerages / team_members / roster are plain uuid
// columns in this initial migration; the FK constraints get added in
// subsequent migrations after those tables exist.
//
// Invariant (enforced in src/lib/db.ts, not the schema): `type` and
// `channel_id` should not be mutated after insert. Both feed `workflow_key`,
// which is resolved app-side at insert time. All Customer mutations must go
// through the single `createCustomer` / `updateCustomer` helpers in db.ts;
// channel-swap mid-lifecycle is not a supported flow.

export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accessToken: uuid('access_token').notNull().defaultRandom(),                  // /r/[token]

    // Identity
    name: text('name').notNull(),
    type: customerTypeEnum('type').notNull(),
    channelId: uuid('channel_id').notNull().references(() => channels.id),         // FK — typo-class sealed
    workflowKey: text('workflow_key').notNull(),                                   // resolved at insert from channels.code: `${type}-${code}`
    contactEmail: text('contact_email').notNull(),
    platformEmail: text('platform_email').notNull(),                               // distinct from contact; used for portal sign-in
    phone: text('phone'),

    // Business info
    businessName: text('business_name'),
    businessAddress: text('business_address'),
    website: text('website'),
    serviceAreas: text('service_areas'),
    localContentAreas: text('local_content_areas'),
    bio: text('bio'),
    licenseNumber: text('license_number'),
    topics: text('topics'),
    hashtags: text('hashtags'),
    gmbName: text('gmb_name'),
    mlsIds: text('mls_ids'),
    specialInstructions: text('special_instructions'),

    // Assets — JSONB arrays preserving Airtable attachment metadata
    // shape: [{ url, filename, size, contentType }, ...]
    // Vercel Blob URLs replace Airtable CDN URLs in Phase 4.
    agentPhoto: jsonb('agent_photo'),
    businessLogo: jsonb('business_logo'),
    otherAssets: jsonb('other_assets'),

    // Payment & deal (D2C, pre-existing)
    hubspotDealId: text('hubspot_deal_id'),
    stripePaymentId: text('stripe_payment_id'),
    addOnStripePaymentId: text('add_on_stripe_payment_id'),
    productTier: productTierEnum('product_tier'),
    paymentStatus: paymentStatusEnum('payment_status'),

    // Stripe — written by payment-mode Phase 1 flow + Stripe webhook
    stripeCustomerId: text('stripe_customer_id'),
    stripeSubscriptionId: text('stripe_subscription_id'),
    selectedStripePriceId: text('selected_stripe_price_id'),
    selectedPlanName: text('selected_plan_name'),
    subscriptionStatus: subscriptionStatusEnum('subscription_status'),

    // Pre-existing CRM fields (payment-mode plan: "NOT touched by this plan")
    mrr: numeric('mrr'),
    renewalDate: timestamp('renewal_date', { withTimezone: true }),
    billingCycle: text('billing_cycle'),

    // Drop-off / At Risk surfacing (payment-mode + engagement coord)
    atRisk: boolean('at_risk').notNull().default(false),
    atRiskReason: atRiskReasonEnum('at_risk_reason'),
    atRiskDetail: text('at_risk_detail'),                                          // e.g. "17 days" — displayed under reason, not as reason
    atRiskSource: atRiskSourceEnum('at_risk_source'),                              // who wrote it — coordinates the two crons
    lastEngagementBriefing: text('last_engagement_briefing'),                      // LLM output, engagement plan Phase 3+
    engagementScore: integer('engagement_score'),                                  // engagement plan Phase 3+

    // Enterprise (B2B) — FK constraints added in subsequent migration after
    // brokerages and roster tables exist
    brokerageId: uuid('brokerage_id'),
    rosterRecordId: uuid('roster_record_id'),

    // Assignment — FK constraint added after team_members table exists
    csmTeamMemberId: uuid('csm_team_member_id'),

    // Design workflow (D2C)
    designApproval: designApprovalEnum('design_approval'),
    designFeedback: text('design_feedback'),
    designRevisionCount: integer('design_revision_count').notNull().default(0),
    designProof: jsonb('design_proof'),                                            // customer-facing curated set
    designDrafts: jsonb('design_drafts'),                                          // internal WIP, never customer-visible
    designProofsUpdatedAt: timestamp('design_proofs_updated_at', { withTimezone: true }),

    // Add-ons
    hasVoice: boolean('has_voice').notNull().default(false),
    hasAvatar: boolean('has_avatar').notNull().default(false),
    voiceStage: text('voice_stage'),
    avatarStage: text('avatar_stage'),
    voiceStripeId: text('voice_stripe_id'),
    avatarStripeId: text('avatar_stripe_id'),

    // Status tracking
    currentStage: text('current_stage').notNull(),
    stageEnteredAt: timestamp('stage_entered_at', { withTimezone: true }),
    accountCreated: boolean('account_created').notNull().default(false),
    credentialsSent: boolean('credentials_sent').notNull().default(false),
    callBooked: boolean('call_booked').notNull().default(false),
    callCompleted: boolean('call_completed').notNull().default(false),
    callDate: timestamp('call_date', { withTimezone: true }),                      // denormalized for portal backwards-compat; written by Calendly webhook
    noShowCount: integer('no_show_count').notNull().default(0),
    otherEmails: text('other_emails'),

    // System
    environment: text('environment').array(),                                      // test/prod isolation
    rejigAccountId: text('rejig_account_id'),                                      // engagement-data join target

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastModified: timestamp('last_modified', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    accessTokenUnique: uniqueIndex('customers_access_token_unique').on(table.accessToken),
    // Belt-and-suspenders: even if app-layer resolution glitches, workflow_key
    // must start with a known customer-type prefix. Per architect 2026-05-11.
    workflowKeyFormat: check(
      'customers_workflow_key_format',
      sql`${table.workflowKey} ~ '^(D2C|B2B)-'`,
    ),
  }),
);

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;
