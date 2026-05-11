import {
  boolean,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { teamRoleEnum } from './enums';

// Mirrors TeamMember interface in src/types/index.ts.
// `roles` is an array because TeamRole was a multi-select in Airtable
// (per memory: internal_workspace.md — multi-role enabled).

export const teamMembers = pgTable(
  'team_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    slackHandle: text('slack_handle'),
    calendlyUrl: text('calendly_url'),
    roles: teamRoleEnum('roles').array().notNull(),
    active: boolean('active').notNull().default(true),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    emailUnique: uniqueIndex('team_members_email_unique').on(table.email),
  }),
);

export type TeamMember = typeof teamMembers.$inferSelect;
export type NewTeamMember = typeof teamMembers.$inferInsert;
