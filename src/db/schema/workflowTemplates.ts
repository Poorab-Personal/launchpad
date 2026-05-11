import {
  boolean,
  integer,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  attachmentTypeEnum,
  paymentModeEnum,
  productEnum,
  taskStatusEnum,
  taskTypeEnum,
  teamRoleEnum,
} from './enums';

// Mirrors WorkflowTemplate interface in src/types/index.ts.
//
// `dependsOn` stays as comma-separated names — these reference OTHER rows in
// the same template set (seed-data), not real task records. Auto 1's port
// resolves these names to real task_dependencies FK rows at customer creation.
//
// Per-plan pricing lives in a separate `stripe_plans` table (payment-mode
// Phase 1.2 shipped this way). Trial days are workflow-level and stay here.

export const workflowTemplates = pgTable('workflow_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  workflowKey: text('workflow_key').notNull(),                            // D2C-Standard | B2B-Keyes | B2B-BW
  stage: text('stage').notNull(),
  stageOrder: integer('stage_order').notNull(),
  taskOrder: integer('task_order').notNull(),
  taskTitle: text('task_title').notNull(),
  taskType: taskTypeEnum('task_type').notNull(),
  assignedRole: teamRoleEnum('assigned_role'),
  initialStatus: taskStatusEnum('initial_status').notNull().default('Draft'),
  dependsOn: text('depends_on'),                                          // comma-separated task names within same template set
  hasTeamReview: boolean('has_team_review').notNull().default(false),
  attachmentType: attachmentTypeEnum('attachment_type').notNull().default('None'),
  embedUrl: text('embed_url'),                                            // copied per-template at task creation
  visibleToClient: boolean('visible_to_client').notNull().default(true),
  product: productEnum('product').notNull().default('Core'),
  instructions: text('instructions'),
  dueDaysAfterActivation: integer('due_days_after_activation'),
  planFeatures: text('plan_features'),                                    // newline-separated bullets; denormalized per workflow_key

  // From payment-mode plan (header-level — denormalized onto every row
  // sharing a workflow_key)
  paymentMode: paymentModeEnum('payment_mode'),
  trialDays: integer('trial_days'),
});

export type WorkflowTemplate = typeof workflowTemplates.$inferSelect;
export type NewWorkflowTemplate = typeof workflowTemplates.$inferInsert;
