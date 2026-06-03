import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { customers } from './customers';
import { attachmentTypeEnum, productEnum, taskStatusEnum, taskTypeEnum } from './enums';
import { teamMembers } from './teamMembers';

// Mirrors Task interface in src/types/index.ts.
//
// The Airtable Depends On text field (CLAUDE.md: "Do NOT use multi-record
// Depends On links") becomes the proper task_dependencies junction table
// below — the architectural win the plan called out.
//
// `daysActive` was an Airtable formula. Postgres forbids it as a stored
// generated column (NOW() is not immutable). Compute in queries instead:
//   SELECT EXTRACT(DAY FROM (COALESCE(completed_at, NOW()) - activated_at))::int AS days_active
// Or expose via a view or a Drizzle helper in src/lib/db.ts.

export const tasks = pgTable(
  'tasks',
  {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  taskName: text('task_name').notNull(),
  taskType: taskTypeEnum('task_type').notNull(),
  stage: text('stage').notNull(),
  stageOrder: integer('stage_order').notNull(),
  taskOrder: integer('task_order').notNull(),
  status: taskStatusEnum('status').notNull().default('Draft'),
  assignedToTeamMemberId: uuid('assigned_to_team_member_id').references(() => teamMembers.id, { onDelete: 'set null' }),
  visibleToClient: boolean('visible_to_client').notNull().default(true),
  hasTeamReview: boolean('has_team_review').notNull().default(false),
  attachmentType: attachmentTypeEnum('attachment_type').notNull().default('None'),
  embedUrl: text('embed_url'),                                            // copied per-template at creation
  instructions: text('instructions'),
  tags: text('tags').array(),                                             // Design Change | Dev Request | Priority | Follow Up — used for triage
  notes: text('notes'),
  dueDate: date('due_date'),
  product: productEnum('product').notNull().default('Core'),
  // days_active is computed in queries (see header comment) — not a column
  lastReminderAt: timestamp('last_reminder_at', { withTimezone: true }),
  assigneeNotifiedAt: timestamp('assignee_notified_at', { withTimezone: true }),
  activatedAt: timestamp('activated_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Stage-grouped task list rendering: WHERE customer_id = ? ORDER BY
    // stage_order, task_order. Highest-traffic read path. Auditor 2026-05-11.
    customerStageOrderIdx: index('tasks_customer_stage_order_idx').on(
      table.customerId,
      table.stageOrder,
      table.taskOrder,
    ),
    // Designer/CSM queue views: tasks WHERE assigned_to_team_member_id = ?
    assignedToIdx: index('tasks_assigned_to_idx').on(table.assignedToTeamMemberId),
    // Active-work dashboards filter on these statuses; partial keeps the index small.
    activeStatusIdx: index('tasks_active_status_idx')
      .on(table.customerId)
      .where(sql`status IN ('Active', 'In Review')`),
  }),
);

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;

// Junction table replacing Airtable's comma-separated `Depends On` text field.
// Per CLAUDE.md anti-pattern and architect 2026-05-11: real FKs both ways.

export const taskDependencies = pgTable(
  'task_dependencies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
    dependsOnTaskId: uuid('depends_on_task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  },
  (table) => ({
    pairUnique: uniqueIndex('task_dependencies_pair_unique').on(table.taskId, table.dependsOnTaskId),
  }),
);

export type TaskDependency = typeof taskDependencies.$inferSelect;
export type NewTaskDependency = typeof taskDependencies.$inferInsert;
