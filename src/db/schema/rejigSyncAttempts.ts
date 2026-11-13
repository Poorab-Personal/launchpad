import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { customers } from './customers';
import { teamMembers } from './teamMembers';

/**
 * One row per push of a customer to Rejig's onboarding staging endpoint,
 * whatever the result (including timeouts). The sync panel reads the latest
 * row per environment. See docs/plans/rejig-account-sync.md.
 *
 * `outcome` is text + a TS const rather than a pgEnum because it grows with
 * Rejig's error codes. `rejig_customer_id` is Rejig's staging id — never copy
 * it into customers.rejig_user_id (that's the real account id, unique-indexed).
 */
export const REJIG_SYNC_OUTCOMES = [
  'created',
  'updated',
  'locked',
  'domain_exists',
  'validation_error',
  'auth_error',
  'http_error',
  'network_error',
] as const;

export const rejigSyncAttempts = pgTable(
  'rejig_sync_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    environment: text('environment').notNull(),                            // 'dev' | 'prod'
    outcome: text('outcome').notNull(),                                    // REJIG_SYNC_OUTCOMES
    httpStatus: integer('http_status'),                                    // NULL on network error / timeout
    rejigCode: text('rejig_code'),                                         // e.g. CUSTOMER_LOCKED
    rejigCustomerId: text('rejig_customer_id'),
    payload: jsonb('payload').notNull(),
    response: jsonb('response'),                                           // truncated body
    durationMs: integer('duration_ms'),
    actorTeamMemberId: uuid('actor_team_member_id').references(() => teamMembers.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    customerEnvCreatedIdx: index('rsa_customer_env_created_idx').on(
      table.customerId,
      table.environment,
      table.createdAt.desc(),
    ),
    environmentCheck: check(
      'rejig_sync_attempts_environment_check',
      sql`${table.environment} IN ('dev', 'prod')`,
    ),
  }),
);

export type RejigSyncAttempt = typeof rejigSyncAttempts.$inferSelect;
export type NewRejigSyncAttempt = typeof rejigSyncAttempts.$inferInsert;
