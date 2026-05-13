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
export * from './customerSubscriptions';
export * from './hubspotInboundEvents';

// Cross-table FK constraints on customers.brokerage_id, customers.roster_record_id,
// customers.csm_team_member_id, and roster.customer_id were added in migration 0002
// (after migration 0001 created the referenced tables).
