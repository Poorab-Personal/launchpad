# Rejig Onboarding System — Context & Architecture Brief

> **SUPERSEDED (2026-05-12).** Pre-build planning doc. The business framing (D2C + B2B onboarding pain) is still accurate, but the implementation choices (Airtable, Zapier, etc.) have all been replaced by Postgres + inline Next.js automations. Retained for historical context only.
> Current source of truth: `CLAUDE.md`, `docs/architecture.md`, `docs/schema/production-schema.md`.

## The Business

Rejig.ai is a B2B SaaS platform for real estate agents and brokerages. Customers pay for the platform, go through an onboarding process (which includes design work, account setup, and training), and then use the product ongoing at app.rejig.ai.

## The Problem

The current onboarding process is fragmented across 8+ disconnected tools:

- **Sales** manages deals in HubSpot
- **Payment** happens via Stripe (payment links sent by sales)
- **Customer intake** is a Google Form that feeds a Google Sheet
- **Design tickets** are created in Shortcut via Zapier, with status tracked in a separate Google Sheet
- **Design approval** happens over email threads
- **Call booking** is via Calendly, with email notifications to internal teams
- **Account creation** is manual, triggered by email
- **Ongoing check-ins** are tracked in HubSpot
- **Support** is via Intercom, disconnected from everything else
- **Internal communication** about customers happens in Slack

There is no single system of record. No centralized view of where each customer is. No automated follow-ups. Customers who stall at any stage go unnoticed until someone manually checks. Internally, the team spends hours stitching together information from multiple tools. Customers experience a fragmented journey — pay here, fill a form there, approve designs over email, book a call somewhere else.

## Two Customer Types

### D2C (Direct to Consumer / SMB)
- Sales closes a deal in HubSpot
- Customer pays via Stripe
- Customer submits intake form with business info, logos, photos, bio, service areas
- Design team creates a brand kit (junior designer creates, senior reviews)
- Customer approves designs (or requests changes)
- Team creates their app.rejig.ai account and sends credentials
- Customer books onboarding call via Calendly
- Customer prepares (watches setup video, signs in, connects service areas)
- Onboarding call happens
- Post-onboarding: feedback survey, check-in calls
- Products: Premium or Luxury (same workflow, different price). Optional add-ons: AI Voice, AI Avatar (add extra intake tasks)

### Enterprise (Keyes, Baird & Warner)
- Brokerage has a master deal — individual agents don't pay
- Agents "raise their hand" to onboard — they visit a broker-specific page and enter their email
- Email is validated against a broker roster (we have API access to the roster)
- Agent info (name, license, service areas, photo, logo, bio, etc.) is pre-populated from the roster
- No design approval process — designs are standardized at the broker level
- Agent books onboarding call, watches setup video, gets account created
- Same post-onboarding flow (feedback, check-ins)
- Keyes agents also start a trial; B&W agents do not

### Identity Challenge
- D2C customers may use different emails for payment (personal Gmail), communication (business email), and platform login (team email). The system uses HubSpot Deal ID as the primary key, not email.
- Enterprise agents are identified by their roster email, validated against the broker's roster database.

## What We're Building

A unified onboarding system with three layers:

### Layer 1: Data & Workflow Engine (Airtable)
- Central database: Customers, Tasks, Roster, Events
- Workflow Templates table that defines what stages and tasks exist per customer type
- When a new customer is created, the system reads the template for their type and generates all their tasks automatically
- Automations handle: task activation when dependencies complete, stage advancement when all stage tasks complete, reminder emails for stalled customers, Slack notifications for the team
- Airtable IS the system of record and the internal team's daily workspace

### Layer 2: Integrations (Zapier)
- HubSpot deal closes → Zapier → creates customer record in Airtable (D2C)
- Calendly booking → Zapier → updates task status in Airtable
- Airtable stage changes → Zapier → Slack notifications
- Roster API → Zapier → syncs to Roster table in Airtable (Enterprise)

### Layer 3: Customer-Facing Portal (Custom Frontend — Phase 2)
- Lightweight Next.js app at onboarding.rejig.ai
- Reads/writes to Airtable via API
- Shows customer their progress, active tasks, intake forms, design approvals, embedded Calendly/video
- Enterprise agents: email validation against Roster table → direct access to portal with pre-populated data
- D2C customers: receive tokenized link via email after deal closes
- The frontend is "dumb" — all business logic lives in Airtable automations
- Admin dashboard for internal team may also be built here, or team continues using Airtable directly

## Key Architectural Decisions

1. **Fixed workflows, not a template engine.** Each customer type (D2C Standard, Keyes, B&W, etc.) has a predefined set of stages and tasks stored in the Workflow Templates table. Adding a new customer type means adding rows to this table — not building new automation logic.

2. **Task dependency model.** Each task can optionally specify a "Depends On" field (another task's title). The task stays in Draft until its dependency completes. This creates sequential chains (e.g., Move to Prod → Create Account → Send Credentials) without hardcoding each transition.

3. **Stage advancement is automatic.** When all tasks in a stage are completed, the system advances to the next stage (determined by Stage Order in the template). No manual stage management.

4. **Design approval is a special flow.** Only D2C customers go through design approval. It uses a field on the Customer record (Design Approval: Pending/Approved/Changes Requested) rather than just task completion, because the approval/rejection loop can repeat multiple times.

5. **Enterprise pre-population.** When an enterprise customer is created from roster data, their intake form fields are already filled. The "Confirm Your Information" task lets them review and correct, not re-enter.

6. **Reminders are scheduled.** A cron-style automation runs periodically, finds customers with stalled active tasks, and sends reminder emails. Max 3 reminders before escalating to CSM.

7. **Events table is an audit log.** Every state change is logged. This powers timeline views in the admin dashboard and future reporting (onboarding time, bottleneck analysis, CSM performance).

## What Success Looks Like

- One place to see every customer and their exact stage
- Zero customers lost between stages
- All follow-ups automated
- Design workflow tracked internally without Shortcut or Sheets
- Customer experiences a guided, linear path — always knows what to do next
- New enterprise brokers can be added by adding rows to a table, not rebuilding systems
- CSM accountability: every customer assigned, every check-in tracked

## Current Phase

We are building Layer 1 (Airtable) first to prove the engine works before investing in the frontend. The schema document defines all tables, fields, and workflow template data. Automations will be built manually in Airtable's UI after the schema is validated and tables are created via API.
