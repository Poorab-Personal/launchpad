import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { customers } from './customers';

/**
 * Append-only log of every customer stage transition.
 *
 * Two state machines feed in:
 *   - LP pre-launch progression (Auto 2 writes when advancing currentStage)
 *   - HubSpot post-launch ticket pipeline (Phase 3 webhook handler writes
 *     when HS Workflows / CSM / BI cron move the ticket)
 *
 * Different table from `events` (which is a general human-readable audit
 * log) because BI queries + dashboards filter on structured fields
 * (change_source, from/to state, attention_reason) and the cardinality is
 * much higher than the narrative events log.
 *
 * Lock the change_source vocabulary now — Phase 3+ writers use these
 * exact strings; new sources will need a code change to add. Kept as text
 * (not pgEnum) so the vocabulary can extend without migrations.
 */
export const CHANGE_SOURCE_VALUES = [
  'hubspot_workflow',           // HS Workflow A/B/C/D etc fired the stage move
  'hubspot_csm_ui',             // CSM dragged the ticket in HubSpot kanban
  'lp_auto2',                   // LaunchPad's Auto 2 (handleTaskCompleted) advanced
  'lp_bi',                      // LaunchPad's BI cron (Phase 4+) applied a rule
  'lp_admin',                   // LaunchPad admin tooling (backfill scripts, manual writes)
  'lp_portal',                  // LaunchPad portal-side transition (onboarding-booked endpoint)
  'stripe_webhook',             // Stripe webhook handler triggered a state move
  'hubspot_api_other',          // HubSpot API change from another integration (catch-all)
] as const;

export type ChangeSource = (typeof CHANGE_SOURCE_VALUES)[number];

export const customerStateTransitions = pgTable(
  'customer_state_transitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    fromState: text('from_state'),                                                 // null on initial set
    toState: text('to_state').notNull(),
    attentionReason: text('attention_reason'),                                     // set together with state when relevant
    changeSource: text('change_source').notNull(),                                 // one of CHANGE_SOURCE_VALUES
    sourceDetail: text('source_detail'),                                           // free-form: BI rule name, HS workflow name, CSM email, etc.
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull(),          // authoritative time of change (HS occurredAt or LP now())
    rawHubspotEventId: text('raw_hubspot_event_id'),                               // FK-ish to hubspot_inbound_events.hubspot_event_id (text)
    payload: jsonb('payload'),                                                     // structured extras: BI rule context, prior attention reason cleared, etc.
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // "Stage history for customer X" — primary read pattern for admin + BI cron eligibility checks
    customerChangedAtIdx: index('cst_customer_changed_at_idx').on(
      table.customerId,
      table.changedAt,
    ),
    // "All transitions by source in last N days" — used by admin dashboards
    // ("how many tickets did CSMs manually move this week?") and BI conflict
    // analysis (Phase 9 conflict-policy design)
    changeSourceChangedAtIdx: index('cst_change_source_changed_at_idx').on(
      table.changeSource,
      table.changedAt,
    ),
  }),
);

export type CustomerStateTransition = typeof customerStateTransitions.$inferSelect;
export type NewCustomerStateTransition = typeof customerStateTransitions.$inferInsert;
