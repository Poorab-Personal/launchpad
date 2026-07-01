import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { brokerages } from './brokerages';
import { channels } from './channels';
import {
  atRiskReasonEnum,
  atRiskSourceEnum,
  billingRelationshipEnum,
  customerTypeEnum,
  designApprovalEnum,
  paymentStatusEnum,
  productTierEnum,
  subscriptionStatusEnum,
} from './enums';
import { roster } from './roster';
import { teamMembers } from './teamMembers';

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
    // Review sources the agent collects reviews on (Rejig auto-pulls these).
    // text[] (matches `environment`); Google rides on gmb_name, Zillow on
    // zillow_profile, Testimonial Tree needs only array membership.
    reviewSources: text('review_sources').array(),
    zillowProfile: text('zillow_profile'),

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

    // HubSpot integration cross-system anchors — populated by /api/webhooks/hubspot on closedwon
    hubspotContactId: text('hubspot_contact_id'),                                  // 1:1 — UNIQUE indexed (see below)
    hubspotTicketId: text('hubspot_ticket_id'),                                    // the current Customer Journey ticket
    salesRepEmail: text('sales_rep_email'),                                        // deal owner's email at closedwon time; CC'd on welcome

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

    // Enterprise (B2B)
    brokerageId: uuid('brokerage_id').references(() => brokerages.id, { onDelete: 'set null' }),
    rosterRecordId: uuid('roster_record_id').references(() => roster.id, { onDelete: 'set null' }),

    // Assignment
    csmTeamMemberId: uuid('csm_team_member_id').references(() => teamMembers.id, { onDelete: 'set null' }),

    // Design workflow (D2C)
    designApproval: designApprovalEnum('design_approval'),
    // Round-by-round note trail between designer and customer. Append-only.
    // Each entry: { from: 'designer'|'customer', note, uploadTask, at }.
    // Replaces the legacy single-value design_feedback column. The column
    // itself is dropped in migration 0019; we already stopped reading from
    // it here so schema and DB diverge harmlessly until that lands.
    designNotes: jsonb('design_notes').default(sql`'[]'::jsonb`),
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

    // Post-launch HubSpot ticket pipeline-stage mirror (Phase 2 schema —
    // populated by Phase 3 bi-directional sync, read by Phase 4 BI cron).
    // NULL while customer is pre-launch; takes values like 'Pre-Onboarding',
    // 'Onboarding Scheduled', 'Active', 'Watch', 'At-Risk', 'Critical',
    // 'On Hold', 'Churned' once they pass through Launched.
    // currentStage and onboardingState never share a value — different state
    // machines (pre-launch vs post-launch). See docs/plans/post-launch-migration.md
    // scrutiny point 7.
    onboardingState: text('onboarding_state'),
    // The "why" behind a Watch/At-Risk/Critical state. Set by BI rules
    // (Phase 4) or HubSpot Workflows. Examples: 'engagement_drop_30d',
    // 'payment_failed', 'pre_onboarding_no_card_7d'.
    attentionReason: text('attention_reason'),
    // When the current attentionReason was set — drives staleness filtering
    // ("attention reasons set >14d ago are likely stale, surface for CSM review").
    attentionSetAt: timestamp('attention_set_at', { withTimezone: true }),

    // Provenance: how this LP customer record got created. Drives behavior
    // forks in trigger-email.ts (suppress Welcome on 'backfill') and
    // generate-tasks.ts (skip task generation on 'backfill'). The default
    // 'organic' covers any pre-Phase-2 customer (no migration backfill needed).
    //   organic       — created via /admin Add Customer or future landing page
    //   closedwon     — created via the HubSpot Deal closedwon webhook
    //   b2b_landing   — (future) created via /keyes /bw brokerage landing
    //   backfill      — created retroactively from HS / Rejig via a script;
    //                   no welcome email, no LP task pipeline
    //   admin         — created by admin tooling outside the normal flow
    createdVia: text('created_via').notNull().default('organic'),

    accountCreated: boolean('account_created').notNull().default(false),
    credentialsSent: boolean('credentials_sent').notNull().default(false),
    callBooked: boolean('call_booked').notNull().default(false),
    callCompleted: boolean('call_completed').notNull().default(false),
    callDate: timestamp('call_date', { withTimezone: true }),                      // denormalized for portal backwards-compat; written by Calendly webhook
    noShowCount: integer('no_show_count').notNull().default(0),
    otherEmails: text('other_emails'),

    // Onboarding feedback (collected at the "Provide Onboarding Feedback"
    // task — last step of Review & Grow stage)
    feedbackRating: integer('feedback_rating'),                                    // 1–5
    feedbackComments: text('feedback_comments'),

    // System
    environment: text('environment').array(),                                      // test/prod isolation
    rejigUserId: text('rejig_user_id'),                                            // Rejig Mongo _id — cross-system identity anchor
    billingRelationship: billingRelationshipEnum('billing_relationship').default('paying'), // paying / comped / internal_demo

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastModified: timestamp('last_modified', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    accessTokenUnique: uniqueIndex('customers_access_token_unique').on(table.accessToken),
    // Email lookups (portal sign-in, B2B roster match, /api/email/send) are
    // high-traffic. Non-unique because historical Airtable data may have dupes
    // — dedup + UNIQUE migration is a separate ticket. Auditor 2026-05-11.
    platformEmailIdx: index('customers_platform_email_idx').on(table.platformEmail),
    contactEmailIdx: index('customers_contact_email_idx').on(table.contactEmail),
    // HubSpot cross-system anchors. hubspot_ticket_id is indexed for
    // ticket-driven webhook routing. hubspot_contact_id was UNIQUE until
    // migration 0021 — that constraint blocked /test (all test customers
    // share the same HS contact poorab@rejig.ai) and re-onboarding cases.
    // The 1:1 invariant is enforced by HubSpot itself (Contact is keyed
    // by email).
    hubspotTicketIdIdx: index('customers_hubspot_ticket_id_idx').on(table.hubspotTicketId),
    // Rejig cross-system anchor. Partial unique — backfilled customers all have
    // rejig_user_id; organically-onboarded customers (D2C closedwon path) may
    // have NULL until the Rejig account is provisioned.
    rejigUserIdUnique: uniqueIndex('customers_rejig_user_id_unique')
      .on(table.rejigUserId)
      .where(sql`${table.rejigUserId} IS NOT NULL`),
    // Drives "all customers on workflow X" queries and per-stage filters.
    workflowKeyIdx: index('customers_workflow_key_idx').on(table.workflowKey),
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
