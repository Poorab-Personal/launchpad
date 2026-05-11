import {
  bigserial,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { actorTypeEnum } from './enums';
import { calls } from './calls';
import { customers } from './customers';
import { tasks } from './tasks';
import { teamMembers } from './teamMembers';

// Mirrors Event interface in src/types/index.ts.
// Audit log of every state change. Per architect 2026-05-11, this is the
// primary "per-field history" replacement for Airtable's revision view
// (until an audit_log table is added if needed later).
//
// `details` becomes jsonb (was text in Airtable) so structured details survive
// JSON.parse without ceremony. Existing string payloads can be wrapped in
// `{ text: "..." }` during the data import.

export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventNumber: bigserial('event_number', { mode: 'number' }).notNull().unique(),  // auto-incrementing, replaces Airtable's `eventId` autonumber; unique for external reference stability
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),                              // 'Task Completed', 'Task Activated', 'Stage Changed', etc.
    actorTeamMemberId: uuid('actor_team_member_id').references(() => teamMembers.id, { onDelete: 'set null' }),
    actorType: actorTypeEnum('actor_type').notNull(),
    details: jsonb('details'),                                             // structured payload; nullable for simple events
    relatedTaskId: uuid('related_task_id').references(() => tasks.id, { onDelete: 'set null' }),
    relatedCallId: uuid('related_call_id').references(() => calls.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    customerCreatedIdx: index('events_customer_created_idx').on(table.customerId, table.createdAt),
    eventTypeIdx: index('events_event_type_idx').on(table.eventType),
  }),
);

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
