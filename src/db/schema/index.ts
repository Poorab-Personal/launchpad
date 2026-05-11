// Drizzle schema entry point. All tables and enums exported from here.
// drizzle.config.ts points at this file.

export * from './enums';
export * from './channels';
export * from './customers';
export * from './teamMembers';
export * from './brokerages';
export * from './roster';
export * from './calls';
export * from './tasks';
export * from './workflowTemplates';
export * from './stripePlans';
export * from './settings';
export * from './events';

// Cross-table FK constraints on customers.brokerage_id, customers.roster_record_id,
// customers.csm_team_member_id, and roster.customer_id land in migration 0001
// (after this batch's 0001 creates the referenced tables; the FKs become 0002).
// See docs/plans/airtable-to-postgres-migration.md §5.
