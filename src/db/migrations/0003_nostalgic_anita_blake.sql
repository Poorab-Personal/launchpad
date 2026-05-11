CREATE INDEX "customers_platform_email_idx" ON "customers" USING btree ("platform_email");--> statement-breakpoint
CREATE INDEX "customers_contact_email_idx" ON "customers" USING btree ("contact_email");--> statement-breakpoint
CREATE INDEX "customers_workflow_key_idx" ON "customers" USING btree ("workflow_key");--> statement-breakpoint
CREATE INDEX "roster_email_idx" ON "roster" USING btree ("email");--> statement-breakpoint
CREATE INDEX "tasks_customer_stage_order_idx" ON "tasks" USING btree ("customer_id","stage_order","task_order");--> statement-breakpoint
CREATE INDEX "tasks_assigned_to_idx" ON "tasks" USING btree ("assigned_to_team_member_id");--> statement-breakpoint
CREATE INDEX "tasks_active_status_idx" ON "tasks" USING btree ("customer_id") WHERE status IN ('Active', 'In Review');--> statement-breakpoint
CREATE INDEX "workflow_templates_lookup_idx" ON "workflow_templates" USING btree ("workflow_key","stage_order","task_order");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_event_number_unique" UNIQUE("event_number");