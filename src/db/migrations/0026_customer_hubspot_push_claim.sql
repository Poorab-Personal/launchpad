-- Atomic claim for the HubSpot intake push.
--
-- The push has two legitimate, concurrent entry points: the browser
-- POST /api/customers/[id]/payment-setup/confirm and Stripe's
-- setup_intent.succeeded webhook. Both complete "Capture Payment Method",
-- both reach pushCustomerIntakeToHubSpot, and its only guard was the
-- check-then-act `if (customer.hubspotTicketId) skip` read — a ~1.5s TOCTOU
-- window. Both invocations read null, both created a Contact + Ticket:
-- the loser 400s on HubSpot's contact-email uniqueness (the loud symptom,
-- 10 occurrences since 2026-06) and, when both got past the contact step,
-- the customer ended up with two live HS tickets (the quiet one — stage
-- moves on the orphan ticket are invisible to LP because the webhook
-- resolves customers by customers.hubspot_ticket_id).
--
-- Claimed by a conditional UPDATE ... WHERE hubspot_push_claimed_at IS NULL
-- (or older than the staleness window, so a hard crash mid-push can't wedge
-- the customer permanently). Released back to NULL on every failure path so
-- the Auto 2 backstop and manual re-runs still work.

ALTER TABLE "customers" ADD COLUMN "hubspot_push_claimed_at" timestamp with time zone;
