import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// Idempotency dedup table for inbound HubSpot webhooks.
//
// /api/webhooks/hubspot does: INSERT ... ON CONFLICT (hubspot_event_id) DO NOTHING
// then proceeds only if the insert succeeded. Prevents duplicate customer
// creation on HubSpot retries (up to 24h backoff) and stage-flapping
// (closedwon → other → closedwon) which would otherwise fire the same logic
// twice.
//
// `hubspot_event_id` is stored as text (HubSpot's eventId is a bigint; we
// don't do arithmetic on it, just equality).

export const hubspotInboundEvents = pgTable(
  'hubspot_inbound_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    hubspotEventId: text('hubspot_event_id').notNull(),                           // the event.id from the webhook payload
    subscriptionType: text('subscription_type').notNull(),                        // e.g. 'object.propertyChange'
    objectType: text('object_type').notNull(),                                    // e.g. 'deal' / 'ticket' / 'contact'
    objectId: text('object_id').notNull(),                                        // the HubSpot object ID this event is about
    propertyName: text('property_name'),                                          // for propertyChange events
    propertyValue: text('property_value'),
    changeSource: text('change_source'),                                          // CRM_UI / API_CHANGE — loop-prevention signal
    sourceId: text('source_id'),                                                  // 'userId:N' for CRM_UI changes
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    rawPayload: jsonb('raw_payload').notNull(),                                   // full event JSON for replay/debug

    processingStatus: text('processing_status').notNull().default('pending'),     // 'pending' | 'processed' | 'error' | 'ignored'
    processingError: text('processing_error'),
    processedAt: timestamp('processed_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    eventIdUnique: uniqueIndex('hubspot_inbound_events_event_id_unique').on(table.hubspotEventId),
    objectIdx: index('hubspot_inbound_events_object_idx').on(table.objectType, table.objectId),
    statusIdx: index('hubspot_inbound_events_status_idx').on(table.processingStatus),
  }),
);

export type HubspotInboundEvent = typeof hubspotInboundEvents.$inferSelect;
export type NewHubspotInboundEvent = typeof hubspotInboundEvents.$inferInsert;
