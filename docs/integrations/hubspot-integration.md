# HubSpot Integration

**Status (2026-05-13):** Architecture locked. Phase 0/1/2 build starting. Each phase + sub-phase gets discussed and aligned with poorab@ before execution — see `memory/feedback_phased_build_alignment.md`.

## What this is

LaunchPad pushes onboarding state and BI signals to HubSpot Sales Hub Pro, where Mario and Luis (CSMs) work daily. HubSpot is the CSM workspace; LaunchPad is the automation engine that feeds it.

Reverses the earlier "build a CSM workspace inside LaunchPad" trajectory. CSMs do not need to open LaunchPad in steady state — they live in HubSpot.

See `memory/hubspot_integration_decision.md` for the full decision rationale.

## What lives where

| Concern | LaunchPad | HubSpot |
|---|---|---|
| Onboarding workflow (stages, tasks, dependencies, design approval) | Source of truth | Mirror via custom properties |
| Customer attributes (name, email, brokerage, payment mode, etc.) | Source of truth | Mirror via Contact custom properties |
| CSM-customer 1:1 emails | n/a | Source of truth (Gmail OAuth integration on each CSM) |
| CSM personal tasks | n/a | Source of truth |
| Tickets (one per customer in Customer Journey Stages pipeline) | Pushed by LaunchPad initially; CSM moves through stages | Source of truth (post-creation lifecycle) |
| Health score | Computed in LaunchPad, pushed | Display + alerting + workflow triggers |
| Sequences (email cadences) | n/a | Source of truth |
| Notes / call summaries | n/a | Source of truth |
| Reports / dashboards | n/a | Source of truth |
| Brokerage rollups (Keyes / B&W) | n/a | Via Deal associations (Sales Pro feature) |

## HubSpot pipeline structure (already deployed)

Pipeline name: **Customer Journey Stages** (`hs_pipeline = "0"`). 547 active tickets at PoC time.

| Stage | Stage ID |
|---|---|
| Intake Pending | 1154519671 |
| Design In Progress | 1154519672 |
| Approval Pending | 1154519673 |
| Onboarding Booked | 1154519674 |
| Onboarded - Partially | 1165504776 |
| Onboarding Completed | 1154519675 |
| Check-in 1 Outreach | 1165493807 |
| Check-in 1 Scheduled | 1154519676 |
| Check-in 1 Completed | 1154519677 |
| Check-in 2 Outreach | 1165495944 |
| Check-in 2 Scheduled | 1154519678 |
| Check-in 2 Completed | 1154519679 |
| Pre-renewal Outreach | 1162370855 |
| Pre-renewal Check-in Scheduled | 1154519680 |
| Pre-renewal Check-in Completed | 1154519681 |
| Healthy | 1154519682 |
| At Risk | 1154519683 |
| Lost - Churned | 1154519684 |
| Lost - Non-Churn | 1154519685 |

Stages 7+ (Check-ins / Pre-renewal / end-states) are CSM-driven in HubSpot — LaunchPad does not auto-move beyond Onboarding Completed.

## Locked v1 stage model — restructured (2026-05-12)

The current 19 stages are being restructured post-onboarding. Decision: post-onboarding stages become **severity levels** driven by BI, not lifecycle phases driven by time.

### v1 stage list (6 stages)

| Stage | Purpose | How tickets move there |
|---|---|---|
| Intake Pending → Onboarding Completed (6 LaunchPad-driven stages, unchanged) | Onboarding lifecycle | LaunchPad pushes as stage advances |
| **Active** | Default post-onboarding; healthy, no concerns | LaunchPad moves on Onboarding Completed |
| **Watch** (yellow) | Mild concern; monitor only | BI rules move customer in |
| **At Risk** (orange) | Action needed this week | BI rules move customer in |
| **Critical** (red) | Action needed today | BI rules move customer in |
| **Churned** | Terminal | Stripe `subscription.deleted` webhook → LaunchPad → auto-move |
| **On Hold** | Customer pause (vacation, business sale, broker transfer) | Manual (admin) for v1; return-to-previous on resume |

This removes the 9-stage Check-in / Pre-renewal triplets (currently Stages 7-15 in the existing pipeline). Their job is now done by **BI moving the ticket into Watch/At-Risk/Critical with a reason code**, not by CSM manually moving through Outreach → Scheduled → Completed.

### Reason code property: `rejig_attention_reason`

Set whenever a ticket is in Watch/At-Risk/Critical. Drives CSM action.

Enum (initial v1 set; extensible):
- `payment_failed`
- `payment_past_due`
- `no_show_2x`
- `stuck_in_onboarding`
- `engagement_drop_30d` (v2 — needs BI)
- `month_3_check_in_due` (time-triggered)
- `month_6_check_in_due` (time-triggered)
- `renewal_approaching_6w`
- `renewal_approaching_2w`
- `intercom_negative_sentiment` (v2 — needs LLM)
- `multiple_intercom_chats_30d` (v2 — needs Intercom signal)

### CSM kanban experience

HubSpot ticket board view (kanban) shows configurable card fields per pipeline. CSMs see on each card:
- Subject (customer name + brokerage)
- Owner (Mario / Luis)
- `rejig_attention_reason` (the why)
- `rejig_attention_set_at` (how long the issue has existed)
- Last activity date

CSM glances at Critical column → reads reasons → handles. No clicking required to see what to do.

### No auto-tasks in v1

Decision (2026-05-12): Drop LaunchPad-driven auto-task creation. The severity-stage kanban + reason code surface is the actionable signal. The ticket IS the work item.

- CSM workflow = look at non-Active columns on kanban, work them
- Time-triggered "Check-in due" prompts handled by BI moving ticket to Watch with reason `month_3_check_in_due` or similar
- CSMs can still create personal HubSpot tasks manually (native UI) — no automation

**What this saves:** task creation cron, deduplication logic, task lifecycle management, ~3-4 days build.

### No CSM override in v1

Decision (2026-05-12): CSMs **cannot** manually move ticket stages in v1. BI is authoritative.

- Forces BI to earn trust by being good (not by being overridable)
- CSMs frustrated by false positives → feedback to admin → BI rules refined
- **Admin (Poorab) override** via direct DB or admin UI = escape hatch
- v2: add CSM override with tracking IF data shows it's needed

**What this saves:** `ticket_state_overrides` table, expiry logic, reason-capture UX, manager dashboards for override patterns. Defer all of it.

### BI engine — rules-first, LLM-enriched (v2)

**v1 BI: deterministic rules only.**
- Payment status from Stripe (failed, past_due)
- Stuck-in-stage (current stage entered > N days ago)
- No-show count from `onboarding_no_show_count`
- Time triggers (3mo, 6mo, renewal-6w, renewal-2w)

These are unambiguous, computable from existing data, no ML needed. Ship in v1.

**v2 BI: LLM-enriched analysis.**

Intercom is the load-bearing signal source we under-counted. Intercom already syncs to HubSpot natively; LaunchPad can also pull directly from Intercom API for richer transcript data. Signals include:
- Customer initiates a chat (engagement signal)
- Chat volume / frequency (over/under-engagement)
- Chat ratings (direct satisfaction)
- Conversation topics ("how do I cancel" ≠ "how do I add a teammate")
- Sentiment in transcripts (LLM-derived)
- Reopened conversations (unresolved issue signal)

**v2 architecture sketch:**
```
Nightly cron in LaunchPad:
  For each active customer:
    Pull signals: Intercom + Rejig product engagement + HubSpot CSM activity + Stripe
    Aggregate context
    LLM call: compute health_score, top_risk_reason, suggested_action
    Apply BI rules (deterministic) for hard signals — override LLM if hard signal fires
    Set ticket stage + reason_code via LaunchPad orchestrator push to HubSpot
```

Rules-based handles hard binary signals. LLM handles fuzzy multi-source patterns. Together: deterministic where it matters, intelligent where it adds value.

### Migration of existing 547 tickets

Existing tickets in old stages (Check-in 1 Outreach, Check-in 1 Scheduled, etc.) get bulk-migrated at cutover:
- Active (most): customers who are healthy post-onboarding
- Watch / At-Risk: customers with rules-detectable issues
- Churned: customers whose Stripe sub is already cancelled

One-time migration script during Phase 1 cutover. Run on dry-run first; report what would move where; CSM review; then live migration.

The 9 old check-in/pre-renewal stages get **archived** (HubSpot doesn't allow stage deletion if tickets reference them; archive after migration completes).

## LaunchPad stage → HubSpot stage mapping (v1)

| LaunchPad state | HubSpot stage |
|---|---|
| Customer created (Stage 1: Getting Started) | Intake Pending |
| Design In Progress (designer working) | Design In Progress |
| Proof uploaded, awaiting customer approval | Approval Pending |
| Customer approved + call booked | Onboarding Booked |
| Onboarding call completed | Onboarded - Partially |
| Stage 5 done (zoom + follow-up sent) | Onboarding Completed |
| Post-onboarding healthy | Active (default) |
| BI-flagged issue, low urgency | Watch (yellow) |
| BI-flagged issue, action this week | At Risk (orange) |
| BI-flagged issue, action today | Critical (red) |
| Stripe subscription cancelled | Churned |
| Manual pause (admin only) | On Hold |

## Owners

CSMs:
- Mario Giron — `hubspot_owner_id: 88849280` — 121 tickets at PoC time
- Luis Véliz — `hubspot_owner_id: 91301752` — 30 tickets at PoC time

## Enterprise Deals (brokerage associations)

- Keyes Brokerage — deal ID `43014118454`, $22k, closedwon — 48 tickets associated
- Baird & Warner Enterprise Deal — deal ID `45663908436`, $85k — 193 tickets associated

B2B agents are pushed as Contacts and the resulting Ticket is associated with the enterprise Deal. This gives CSMs brokerage-level rollups out of the box.

## Repository artifacts

- `/launchpad-integration/` — HubSpot Developer Platform project (file-based config, deployed via `hs project upload`). Contains app + webhook subscriptions.
- `/scripts/hubspot-poc/test-pushes.ts` — PoC validation script. Kept as historical/reference; not for production use.
- npm script: `npm run hubspot:poc`

## PoC findings (2026-05-12)

See `memory/hubspot_poc_findings.md` for the full payload shape and the critical `changeSource` loop-prevention detail.

**Headline:** all push operations work (read, update stage, update property, create note, create ticket). Webhook delivery validated end-to-end. The architecture is feasible.

## Decisions locked (2026-05-12)

The following architectural decisions are locked. Implementation work can proceed.

1. ✅ **Stay on Sales Hub Pro.** 1 ticket pipeline cap is fine — we use stages + reason code property + filtered views. Service Hub Pro upgrade (+$180/mo) deferred until CSMs hit real friction.
2. ✅ **Post-onboarding stages = severity levels.** Active / Watch / At-Risk / Critical / Churned, plus On Hold. Replaces the 9-stage Check-in / Pre-renewal triplets.
3. ✅ **BI is authoritative; no CSM override in v1.** Admin (Poorab) can override; CSMs cannot.
4. ✅ **No auto-tasks in v1.** Severity-stage kanban + reason code IS the actionable surface.
5. ✅ **Time-triggered moves** (3mo / 6mo / renewal) handled by BI moving ticket to Watch with appropriate reason code — not by separate scheduled tasks.
6. ✅ **HubSpot Meetings replaces Calendly** for onboarding + check-ins, embedded in LaunchPad portal.
7. ✅ **Drop Zapier.** D2C entry uses HubSpot webhook on `deal.propertyChange:dealstage` directly.
8. ✅ **Use Stripe Data Sync app: NO.** LaunchPad orchestrates Stripe→HubSpot pushes directly. Stripe metadata holds cross-system breadcrumbs.
9. ✅ **Sales rep enters `stripe_subscription_id` on Deal before closedwon** (required field via HubSpot Deal stage gate).
10. ✅ **Brokerage = Company AND Deal in HubSpot.** Create Companies for Keyes + B&W; associate Contacts to both Company and existing enterprise Deal.

## Open questions still to resolve (smaller — not blockers for design lock)

1. **Intercom direct integration** for v2 BI — pull conversation transcripts directly from Intercom API vs through HubSpot's native Intercom sync. Probably direct API for richer data, but decide when building v2.
2. **Webhook receiver URL** — currently webhook.site placeholder in `launchpad-integration/`. Update to `/api/webhooks/hubspot` route on Vercel before Phase 3.
3. **Migration script for 547 existing tickets** — bulk-classify into Active / Watch / At-Risk / Churned based on rules; CSM review before live migration. Phase 1 task.
4. **Custom Timeline Events** — OAuth-only on HubSpot. Defer indefinitely; reconsider only if CSMs ask for inline LaunchPad event log on Contact timeline.
5. **Reason code enum** — initial v1 set defined; refine after Mario/Luis review the kanban experience with sample data.

## Naming convention for custom properties

There are two categories of properties with different naming rules:

**System ownership IDs** — named for the system that *generates and owns* the ID:
- `launchpad_customer_id` — LaunchPad UUID (cross-system anchor; LaunchPad generates it on customer creation)
- `stripe_customer_id`, `stripe_subscription_id` — Stripe-native IDs
- `rejig_user_id` — Rejig app user account ID (populated after account-creation task)
- `hubspot_contact_id`, `hubspot_deal_id`, `hubspot_ticket_id` — HubSpot-native (native fields on objects, not custom properties)

**Conceptual properties** — named for the *source domain* of the concept:
- `rejig_*` for properties about the customer's engagement with the **Rejig platform** (the product). Examples: `rejig_engagement_score`, `rejig_health_score`, `rejig_last_login`, `rejig_attention_reason`, `rejig_brokerage_channel`.
- `onboarding_*` for properties specific to the **onboarding workflow**. Example (the only one we kept): `onboarding_no_show_count`. (`onboarding_stage`, `onboarding_completion_state`, `onboarding_portal_url` were proposed under this naming but dropped by the audit — see the drops table below.)

**The rule that does NOT change:** never put `launchpad_*` on conceptual properties. Engagement, health, attention, etc. are NOT LaunchPad concepts — LaunchPad just happens to compute them. Use `rejig_*` or `onboarding_*` based on the source domain.

## 4-system ID presence matrix

| ID | LaunchPad (Postgres) | HubSpot Contact | HubSpot Deal | HubSpot Ticket | Stripe metadata | Rejig (app) |
|---|---|---|---|---|---|---|
| `launchpad_customer_id` | ✅ `customers.id` (PK) | ✅ property | ✅ property | ✅ property | ✅ metadata key | ❌ |
| `stripe_customer_id` | ✅ column | ✅ property | ✅ property | — | ✅ (native) | ❌ |
| `stripe_subscription_id` | ✅ via `customer_subscriptions` | ✅ property (current) | ✅ property (required to close-won) | — | ✅ (native) | ❌ |
| `hubspot_contact_id` | ✅ column | ✅ (native) | — | — | ✅ metadata key | ❌ |
| `hubspot_deal_id` | ✅ via `customer_subscriptions` | — | ✅ (native) | — | ✅ metadata key | ❌ |
| `hubspot_ticket_id` | ✅ column | — | — | ✅ (native) | — | ❌ |
| `rejig_user_id` | ✅ column (populated post-account-creation) | ✅ property (populated post-account-creation) | — | — | optional metadata | ✅ (native) |

LaunchPad knows everything (orchestrator). HubSpot mirrors via custom properties. Stripe mirrors via metadata. Rejig stays as a leaf — only knows its own user ID.

## Locked Phase 0b property list (12 properties, post-audit + discovery)

Architect audit 2026-05-13 trimmed the property list from 16 → 10 by dropping 6 properties that violated the "simple but not overly so; IDs + BI syncs only" principle. Subsequent discovery of 3 existing Deal properties (`stripe_payment_id`, `voice_stripe_payment_id`, `avatar_stripe_payment_id`) that already store Stripe Subscription IDs raised the count back up to 12 — and **solved the multi-product subscription modeling problem** by surfacing the existing 1-Deal-with-3-sub-fields pattern Rejig already uses.

### Property group assignment

All Phase 0b custom properties go in the **default group** for each object (no custom groups for now):

| Object | Group | Custom properties |
|---|---|---|
| Contact | `Contact information` | `launchpad_customer_id`, `stripe_customer_id`, `rejig_user_id`, `rejig_brokerage_channel` |
| Ticket | `Ticket information` | `onboarding_no_show_count`, `rejig_attention_reason`, `rejig_attention_set_at` |
| Deal | `Deal information` | `launchpad_customer_id` (new), `stripe_payment_id` (existing — relabel), `voice_stripe_payment_id` (existing — relabel), `avatar_stripe_payment_id` (existing — relabel) |
| Company | `Company information` | `launchpad_brokerage_id` |

**Reasoning:** properties have clear prefixes (`launchpad_`, `rejig_`, `onboarding_`) so they're identifiable without a custom group wrapper. Reduces config overhead. Can re-group into a custom "LaunchPad Integration" group later if the default group gets cluttered (>20+ custom properties per object).

### CONTACT properties (durable, cross-ticket) — 4

| Property | Type | Purpose | Writer |
|---|---|---|---|
| `launchpad_customer_id` | Text (UUID) | LaunchPad UUID — cross-system anchor | LaunchPad on upsert |
| `stripe_customer_id` | Text | Stripe customer ID — for CSM cross-linking to Stripe dashboard | LaunchPad after Stripe lookup |
| `rejig_user_id` | Text | Rejig app user account ID (post-account-creation) | LaunchPad after account-create task |
| `rejig_brokerage_channel` | Enum: `D2C` / `B2B - Keyes` / `B2B - B&W` (extensible) | Customer type + brokerage in one field for filtering/reports. **Mapping:** LaunchPad's `channels` table uses internal codes (`Standard`, `Keyes`, `BW`); a `channels.hubspot_label` column (added in Phase 0c) holds the HubSpot-display value. LaunchPad push reads `channels.hubspot_label` when setting this. | LaunchPad on upsert |

### TICKET properties (current ticket state) — 3

| Property | Type | Purpose | Writer |
|---|---|---|---|
| `onboarding_no_show_count` | Number (int, default 0) | No-show counter; input to BI rules | HubSpot Workflow (meeting outcome) |
| `rejig_attention_reason` | Enum (10 values, see below) | The "why" behind Watch/At-Risk/Critical severity | HubSpot Workflow + LaunchPad BI |
| `rejig_attention_set_at` | Datetime | When the attention state started; drives staleness filtering | Same |

**`rejig_attention_reason` enum (v1):**
- `no_show_no_rebook` (HubSpot Workflow — 7d after no-show)
- `no_show_pattern` (HubSpot Workflow — 2nd no-show in window)
- `customer_cancelled_onboarding` (HubSpot Workflow — immediate)
- `partial_no_completion` (HubSpot Workflow — 7d after partial)
- `payment_failed` (LaunchPad BI — Stripe invoice.payment_failed)
- `payment_past_due` (LaunchPad BI — Stripe subscription past_due)
- `stuck_in_onboarding` (LaunchPad BI — v2)
- `engagement_drop_30d` (LaunchPad BI — v2)
- `renewal_approaching_6w` (LaunchPad BI — time trigger)
- `renewal_approaching_2w` (LaunchPad BI — time trigger)

### DEAL properties — 4

| Internal name | Label (in HubSpot UI) | Type | Required | Writer |
|---|---|---|---|---|
| `launchpad_customer_id` | LaunchPad Customer ID | Text (UUID) | No | LaunchPad after closedwon |
| `stripe_payment_id` ⚠️ existing | Stripe Subscription ID — Core | Text | **YES — stage gate at close-won** | Sales rep manually |
| `voice_stripe_payment_id` ⚠️ existing | Stripe Subscription ID — Voice | Text | No (optional Voice add-on) | Sales rep manually |
| `avatar_stripe_payment_id` ⚠️ existing | Stripe Subscription ID — Avatar | Text | No (optional Avatar add-on) | Sales rep manually |

**Important — internal name vs label mismatch:** the three `*_payment_id` properties were created when Rejig had a different payment model. They actually store **Subscription IDs** (`sub_*`), not Payment IDs. We've updated the LABELS in HubSpot UI to reflect this; INTERNAL NAMES stay as `*_payment_id` to preserve existing Deal data. LaunchPad integration code reads from the legacy internal names.

**Multi-product pattern:** one Deal per customer; multiple Subscription IDs nested as separate properties. This is how Rejig sales reps work today. At close-won, LaunchPad reads all 3 fields, calls Stripe for each non-null value, creates one `customer_subscriptions` row per subscription (product enum: Core / Voice / Avatar).

### COMPANY properties (brokerages — Keyes, B&W, etc.) — 1

| Property | Type | Purpose | Writer |
|---|---|---|---|
| `launchpad_brokerage_id` | Text (UUID) | LaunchPad brokerage UUID — cross-system anchor | Admin one-time |

### Audit drops (from architect audit 2026-05-13)

These properties were originally proposed but dropped during the audit. Each had a real reason for failing the principle:

| Property | Why dropped |
|---|---|
| `onboarding_stage` (Ticket) | Duplicated state captured by the Ticket's `hs_pipeline_stage` (the kanban stage). Granular LaunchPad workflow detail stays in LaunchPad; not mirrored. |
| `launchpad_customer_id` (Ticket) | Available via Contact association — one extra GET per webhook event is acceptable cost vs. maintaining a duplicated property. |
| `onboarding_completion_state` (Ticket) | Meeting record's native `hs_meeting_outcome` already holds this. Two writers (HubSpot Workflow + the Ticket property) = drift risk. |
| `onboarding_portal_url` (Ticket) | Pure derivation from `access_token` — compute or put in a one-time Note instead of maintaining as a property. |
| `stripe_customer_id` (Deal) | Derivable from `stripe_subscription_id` via Stripe API call, or read from associated Contact. Sales-rep-readability convenience didn't justify the property. |
| `rejig_brokerage_channel` (Company) | Each Company IS one channel (Keyes Company → B2B - Keyes). Property restated Company identity. The Contact-level version stays (D2C agents have no Company, so they need a flat property). |
| `rejig_default_csm_id` (Company) | HubSpot's native Company owner field handles this. Custom property duplicated native functionality. |

### Anti-patterns to watch for (from the audit)

1. **One writer per property.** Two writers = drift.
2. **Don't denormalize for "fewer clicks."** A property exists only when actively displayed on a kanban card or filtered in a workflow.
3. **HubSpot is not a backup database.** Properties = ID anchors or BI signals only.
4. **Don't mirror native fields.** Meeting outcome lives on the Meeting object; never copy to Ticket or Contact.
5. **HubSpot's native owner field** handles brokerage-level CSM ownership; don't duplicate.
6. **The CSM kanban + ticket stage** carry lifecycle position; granular sub-stages stay in LaunchPad.

### What's intentionally NOT in v1

- `rejig_engagement_score`, `rejig_health_score`, `rejig_last_login` → v2 (BI not built; will surface to CSM when BI computes them)
- `onboarding_design_approval` on Contact → captured in ticket stage history + notes
- `rejig_at_risk` boolean on Contact → ticket stage tells us this; no duplication
- `onboarding_call_date` on Contact → associated Meeting record has it natively
- Custom Timeline Event templates → requires OAuth; deferred
- **`rejig_payment_status` on Contact** → still deferred. Per-subscription payment status lives on `customer_subscriptions` rows in LaunchPad. May add a rolled-up Contact flag (`any_subscription_past_due` boolean) later if CSM filtering needs justify it. Note: the multi-product modeling problem is now SOLVED at the Deal level (3 sub IDs per Deal), but a Contact-level rolled-up indicator is a separate ask.

### Phase 0c follow-ups derived from Phase 0b decisions

- Add `hubspot_label` column to `channels` table — data-driven mapping for brokerage channel display values (`Standard → D2C`, `Keyes → B2B - Keyes`, etc.). Adding a new brokerage = one row insert, no code change.
- **Design `customer_subscriptions` table with `product` enum from day 1.** Discovery of the 3-sub-IDs-per-Deal pattern un-defers multi-product modeling. Table shape:
  - `customer_id` (FK to customers)
  - `product` (enum: `Core`, `Voice`, `Avatar` — extensible; matches the existing LaunchPad `product` pgEnum)
  - `stripe_subscription_id` (text)
  - `hubspot_deal_id` (text — same Deal across all subs for one customer)
  - `status` (enum mirroring Stripe sub status)
  - `started_at`, `ended_at`, `mrr`
  - Unique constraint on `(customer_id, product)` — one row per product per customer
- LaunchPad webhook handler on closedwon needs to: read all 3 `*_payment_id` properties from Deal → loop → create one `customer_subscriptions` row per non-null sub ID → write Stripe metadata.

### Creation method (Phase 0b execution)

One-time manual creation in HubSpot UI (Settings → Properties). ~20 properties; one afternoon's work. Document every property's purpose + enum values in this doc as we go.

## Workflow gaps surfaced from CSM audit (2026-05-12)

- **"Onboarded - Partially" definition (clarified):** This is a true partial — used when the customer shows up late, social media profile connection issues, or runs out of time during the onboarding call. Customer needs more time / follow-up. Distinct from "Onboarding Completed" (fully done) and should trigger a follow-up task chain.
- **No-show chasing gap:** Currently no automation. CSM has to manually track no-shows and chase customers down. **High-priority workflow to build via HubSpot automation** — when a Meeting is marked no-show, auto-create a Task + send a templated outreach (HubSpot Sequences) + increment `onboarding_no_show_count`. After 3 no-shows, escalate.
- **At-Risk has no process today.** 0 tickets in "At Risk" pipeline stage — not because nobody is at risk, but because the manual workflow doesn't get done. BI-driven auto-flagging (deferred, but planned) fills this once we build the engagement layer.

## Calendar: HubSpot Meetings (decided)

**Decision (2026-05-12):** use HubSpot Meetings for onboarding calls + check-ins, embedded in the LaunchPad customer portal. Calendly stays in place for existing bookings; sunset over time.

Reasoning:
- HubSpot Meetings has its own embed widget — drop-in iframe replacement for Calendly in `/r/[token]` portal pages
- Native Contact association (no email-based matching)
- Reschedule/cancel/no-show events fire HubSpot webhooks naturally — same subscription pattern we already use
- No branding requirement (CSMs don't need a polished Calendly-style branded page)
- One fewer tool in the stack, one fewer integration

Reschedule design:
- Customer reschedules → date updates on Meeting record, Ticket stage stays at "Onboarding Booked"
- Customer cancels (no rebook) → Ticket moves back to "Approval Pending", auto-task: "Customer cancelled — outreach for rebooking"
- No-show → CSM marks in HubSpot, auto-task: "Customer no-show — schedule rebook"
- 3rd no-show → auto-flag at risk, escalate

## Locked-in architectural pattern: LaunchPad as orchestrator

**LaunchPad is the orchestrator.** It reads from Stripe (canonical billing source) and writes to both its own DB AND HubSpot. We do **NOT** use the native HubSpot Stripe Data Sync app — LaunchPad pushes Stripe state to HubSpot directly via the integration. Stripe metadata holds the cross-system breadcrumbs (`launchpad_customer_id`, `hubspot_contact_id`, `hubspot_deal_id`).

This avoids the email-mismatch brittleness of the native sync app and gives us a single source of truth for cross-system identity.

### Cross-system identity table

| ID | Lives in | Set by |
|---|---|---|
| `launchpad_customer_id` (UUID) | LaunchPad.customers.id, Stripe metadata, HubSpot Contact/Deal/Ticket properties | LaunchPad |
| `stripe_customer_id` (cus_XXX) | Stripe, LaunchPad, HubSpot Contact/Deal | Stripe; surfaced by LaunchPad |
| `stripe_subscription_id` (sub_XXX) | Stripe, LaunchPad, HubSpot Deal/Contact | Sales rep (D2C, via HubSpot Deal stage gate) or LaunchPad (B2B) |
| `hubspot_contact_id` | HubSpot, Stripe metadata, LaunchPad | HubSpot |
| `hubspot_deal_id` | HubSpot, Stripe metadata, LaunchPad | HubSpot / sales rep |
| `hubspot_ticket_id` | HubSpot, LaunchPad | LaunchPad (creates the ticket) |

### D2C entry: HubSpot deal closes → LaunchPad customer

No Zapier. Webhook subscription on `deal.propertyChange:dealstage`. Sales rep must enter `stripe_subscription_id` on the Deal before moving to closedwon (HubSpot Deal stage gate enforces "required for stage" — Sales Hub Pro feature).

Handler reads Deal → fetches Stripe data → creates LaunchPad customer → pushes back to HubSpot → updates Stripe metadata.

### B2B entry: agent self-onboards via /keyes or /bw

LaunchPad creates Stripe Customer + SetupIntent → pushes to HubSpot (associates Contact to brokerage Company + enterprise Deal, creates Ticket in CJ pipeline). On Onboarding Call Complete → LaunchPad creates Stripe Subscription → pushes to HubSpot.

### Ongoing Stripe events

LaunchPad's existing `/api/webhooks/stripe` uses Stripe metadata to find LaunchPad + HubSpot IDs, updates both. Payment failures create a Ticket in Payment Issues *stage* of the CJ pipeline (not a separate pipeline — Sales Hub Pro caps at 1).

---

## Review deltas — must land BEFORE building on top

Architecture review (2026-05-12) surfaced six structural issues that need to be in the schema/design before any build work. These are blockers for Phase 1.

### Phase 0 — Cleanup (do FIRST)

**Rename `airtable_customer_id` everywhere.** Decided 2026-05-12: not in production yet, no real customer data, so do a clean rename rather than a backwards-compat write-both.

- Rename `airtableCustomerId` → `customerId` in all function signatures (`src/lib/stripe.ts`, all callers)
- Rename Stripe metadata key `airtable_customer_id` → `launchpad_customer_id`
- Rename idempotency key prefixes (`cust_create_<id>` stays; just remove the misleading parameter name)
- Update comments referencing Airtable that no longer apply
- Affected files: `src/lib/stripe.ts`, `src/app/api/customers/route.ts`, `src/lib/automations/handle-call-completed.ts`, `src/app/api/customers/[id]/payment-setup/route.ts`, comments in `src/lib/db.ts` + automations

### Phase 1 — Six structural deltas

1. **1:N customer ↔ subscription/deal modeling.** Add `customer_subscriptions` table: one row per Stripe sub / HubSpot deal pair, with start_at, ended_at, status, mrr, hubspot_deal_id, stripe_subscription_id. The `customers` row remains "the human"; subscriptions become events on it. Migrate the current `customers.stripe_subscription_id` + `customers.hubspot_deal_id` columns to be "current" pointers into the new table. Without this, year-2 renewals corrupt the data model.

2. **Webhook idempotency layer.** Two new tables: `hubspot_inbound_events` and `stripe_inbound_events`, both unique on the source `event.id`. Webhook handlers do `INSERT … ON CONFLICT DO NOTHING; if conflict → return 200`. Prevents duplicate customer creation on HubSpot retries (up to 24h backoff) and stage-flapping (closedwon → other → closedwon).

3. **Outbound queue is the only path for external mutations.** Webhook handlers do DB tx + enqueue only, return 200 in <100ms. Cron worker (every 60s) flushes the queue with row-locking (`UPDATE ... SET status='processing' WHERE status='pending' LIMIT 40 RETURNING *`), retries with exponential backoff, dead-letters after N attempts. No synchronous HubSpot/Stripe writes in the inbound webhook path. Vercel function 10s timeout + HubSpot's 5s webhook timeout make this mandatory.

4. **Explicit stage-authority rules.** Per-stage matrix of "who wins on conflict":
   - Stages 1-6 (Intake Pending through Onboarding Completed) → LaunchPad authoritative. CSM edits get reverted with a Note on the Ticket.
   - Stages 7+ (Check-in 1 Outreach through Lost - Non-Churn) → HubSpot/CSM authoritative.
   - LaunchPad never auto-moves a Ticket past Onboarding Completed.

5. **Stripe subscription validation gate at closedwon.** Three checks before creating LaunchPad customer:
   - Subscription exists in Stripe (404 → post Note on Deal: "LaunchPad: cannot find Stripe subscription sub_XYZ", do not advance)
   - Status ∈ {`trialing`, `active`} (else: post Note, queue retry, do not advance)
   - Stripe Customer email matches HubSpot Deal primary Contact email (else: post Note flagging mismatch, do not advance)
   - Plus a format check on `stripe_subscription_id` (`/^sub_[A-Za-z0-9]+$/`) before calling Stripe.

6. **Backfill plan.** Since we're not live yet (Phase 0 cleanup makes this trivial — no real production data to migrate), this becomes: dry-run script to confirm no `airtable_customer_id` references remain in test data, then a one-time pass to add `launchpad_customer_id` metadata to any existing Stripe sandbox customers. For HubSpot's 547 existing tickets — they were created manually by CSMs and don't have the new metadata properties. Backfill plan: add unique indexes (`customers.hubspot_deal_id`, `customers.stripe_customer_id`), then a reconciliation script that matches existing tickets to LaunchPad customers by email and populates the cross-refs.

### Phase 2 — Other quality items (not blockers but ship with v1)

- HubSpot webhook signature verification (HMAC-SHA256, `X-HubSpot-Signature-v3`, 5-min timestamp tolerance)
- Email-format check on stripe_subscription_id input
- D2C race: `stripe_inbound_events` captures Stripe webhooks that arrive before LaunchPad has a customer; replay-after-closedwon
- B2B duplicate enrollment: email-based "resume existing flow" branch in `/api/customers` (currently no uniqueness check; B2B agent re-entering `/keyes` would create dupes)
- Replace `getCustomers()` full-table-scan in `src/app/api/webhooks/stripe/route.ts` with indexed direct lookup
- Token rotation procedure for HubSpot static auth (env var pair pattern for hot rotation)
- HubSpot Companies for Keyes + B&W (decide and create — recommended yes for CSM brokerage rollups)
- Subscribe to `ticket.propertyChange:hubspot_owner_id` (CSM ownership transfers)

### Explicit deferrals (named so they don't sneak in)

- **Service Hub Pro upgrade** — not needed. Sales Pro caps at 1 ticket pipeline but we use stages + properties for Payment Issues / At-Risk. Revisit only on CSM complaint.
- **Custom Timeline Events** — requires OAuth, not static auth. Defer indefinitely.
- **CSM Gmail OAuth** — out of scope. Handled by HubSpot's native Gmail integration that each CSM installs on their own seat.
- **Refund / chargeback flow** — `charge.refunded`, `charge.dispute.created`. Log to Ticket Note for now; design proper handling later.
- **Roster data fields → HubSpot Contact properties** — defer unless a specific CSM use case emerges.

---

## Production rollout phases

1. **Phase 0** (~half day) — rename `airtable_customer_id` cleanup
2. **Phase 1** (~1 week) — schema deltas: `customer_subscriptions`, `hubspot_inbound_events`, `stripe_inbound_events`, `hubspot_outbound_events`, HubSpot ref columns on `customers`/`brokerages`
3. **Phase 2** (~3-4 days) — HubSpot client wrapper, outbound queue worker, push event emitters wired to LaunchPad automations
4. **Phase 3** (~3-4 days) — webhook receiver `/api/webhooks/hubspot` with signature verification, `changeSource` filter, idempotency on event_id
5. **Phase 4** (~2-3 days) — stage authority + validation gates (subscription validation at closedwon, stage-authority enforcement)
6. **Phase 5** (~half day) — backfill / sandbox cleanup
7. **Phase 6** (~2-3 days) — end-to-end test with sandbox Stripe + test contact + real HubSpot UI workflow

Realistic scope: **~3 weeks of focused build** for v1.
