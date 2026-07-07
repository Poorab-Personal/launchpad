---
name: funnel-audit
description: Audit B2B brokerage onboarding funnels. Reports each customer's furthest milestone (Stage 1 client tasks) plus their subscription state (Trial / Paying / Pending / Missing) with amount and trial-end. Optional CSV export or email delivery (HTML body + CSV attachment) via Resend. Use when the user asks "how many <brokerage> customers in what stages", "where are <brokerage> customers in the funnel", "funnel snapshot for <slug/workflow>", "who's trialing / who's paying", or wants per-customer breakdowns of conversion progress for IPRE / Keyes / BW / future B2B brokerages.
metadata:
  scope: project
  type: audit-report
---

# Funnel Audit (B2B)

Reports each B2B customer's position in the conversion funnel by walking the Stage 1 client-visible tasks of their workflow, then surfaces their Stripe subscription state (pre-sub, Trial, Paying). Milestones auto-derive from `workflow_templates`, so new brokerages work without code changes.

## When to use this skill

Trigger when the user asks any of:
- "How many <brokerage> customers in what stages?"
- "Where are <brokerage> customers in the funnel?"
- "Funnel snapshot for <slug>"
- "Audit IPRE/Keyes/BW customers"
- "Who's trialing? Who's paying?"
- "Show me each customer, where they are, and what they're paying"
- "Email me the IPRE funnel"

Do **not** trigger for D2C funnels — this skill is B2B-only by design (B2B Stage 1 is a clean payment-conversion funnel; D2C lifecycle is stage-based, not milestone-based, and would need a different report shape).

## How to invoke

Run the CLI script. The skill is just documentation around it:

```bash
npx tsx scripts/funnel-audit.ts <workflow_key|brokerage_slug> [flags]
```

### Positional

- `<workflow_key>` — `B2B-IPRE`, `B2B-Keyes`, `B2B-BW` (case-sensitive)
- `<brokerage_slug>` — `ipre`, `keyes`, `bw` (matched against `brokerages.landing_page_slug`; case-insensitive). Resolves to the brokerage's `defaultWorkflowKey`.

### Flags

| Flag | Default | Meaning |
|---|---|---|
| `--csv` | off | Also write CSV to `scripts/data/<workflow>-funnel-<YYYY-MM-DD>.csv`. CSV has 3 split subscription columns and extra IDs not shown in terminal. |
| `--full` | off | Include all stages, not just Stage 1. Use when the user asks about end-to-end progress, not just the conversion funnel. |
| `--customer <q>` | none | Filter to customers whose name or contact/platform email contains `<q>` (case-insensitive). Good for single-customer deep-dives. |
| `--include-test` | off | By default, customers with `'test'` in their `environment` array are excluded. Pass this to include them. |
| `--email <a,b,c>` | none | Comma-separated recipients. Sends HTML body + CSV attachment via Resend (`success@rejig.ai`). |
| `--subject <s>` | auto | Override email subject. Default: `<workflow> funnel — <YYYY-MM-DD> (<n> customers)`. |
| `--stuck-days N` | 3 | Days-stuck threshold for the red flag. Rows in a non-terminal bucket (not Booked / not Onboarded) older than this are highlighted red in terminal + email. Configured globally in `funnel-audit-labels.ts` (`STUCK_DAYS_THRESHOLD`). |

### Examples

```bash
# Default — terminal table only, excludes test customers
npx tsx scripts/funnel-audit.ts B2B-IPRE
npx tsx scripts/funnel-audit.ts ipre

# Same + CSV artifact on disk
npx tsx scripts/funnel-audit.ts ipre --csv

# Email to one or more recipients (CSV attached automatically)
npx tsx scripts/funnel-audit.ts ipre --email poorab@rejig.ai
npx tsx scripts/funnel-audit.ts ipre --email poorab@rejig.ai,matt@rejig.ai --subject "IPRE Tuesday check"

# Full-lifecycle (all stages, not just Stage 1)
npx tsx scripts/funnel-audit.ts ipre --full

# Drill into one customer
npx tsx scripts/funnel-audit.ts ipre --customer poorab@

# Include test-env customers (rare — usually you want them excluded)
npx tsx scripts/funnel-audit.ts B2B-Keyes --include-test
```

## What the report shows

**Top section** — funnel-stage counts, plus a warning banner if any milestone has no friendly label. The `B2B-` prefix is dropped from the header for brevity (e.g. `IPRE funnel`, not `B2B-IPRE funnel`):

```
IPRE funnel — 28 customer(s) (excluding test env)

Funnel stage:
  Started, didn't submit       5
  Submitted, no card           7
  Card saved, didn't book      1
  Booked                       15
  Onboarded                    0
```

**Table** — one row per customer with: Name, Funnel Stage (gap-style label), Call Date (future for Booked / past for Onboarded), Subscription (state + amount + trial end), Email, Phone, Created. Sorted furthest-progress first. Rows stuck ≥`--stuck-days` days in a non-terminal bucket are highlighted red in both terminal and email.

## Bucket semantics

Labels describe **where they're stuck** (what's done, what's missing), not just what they completed — so each label uniquely identifies the bucket:

| Bucket | Meaning |
|---|---|
| `Started, didn't submit` | Customer row exists. Intake form not submitted yet. |
| `Submitted, no card` | Submitted intake info but no payment method on file. |
| `Card saved, didn't book` | Card on file + plan picked, but no onboarding call scheduled. |
| `Booked` | Onboarding call scheduled but the **Onboarded gate** has not fired (see below). |
| `Onboarded` | Onboarding done — gated on workflow-specific signal. |

### The "Onboarded gate"

A customer who finished the Schedule milestone is **Booked** until the gate fires. The gate is per-workflow:

| Workflow | Gate | Why |
|---|---|---|
| `B2B-IPRE`, `B2B-Keyes` | `subscriptionStatus IS NOT NULL` | Stripe trial sub is created when the HubSpot Ticket flips to Active — i.e., post onboarding meeting. The presence of a sub means the meeting really happened. |
| `B2B-BW` | `currentStage` advanced past `Getting Started` | BW has no Stripe trial sub of any kind, so stage advancement is the only signal available. |

This is configured in `scripts/funnel-audit-labels.ts` (`ONBOARDED_RULE`). New B2B workflows default to `'subscription'`; add an override there if a workflow doesn't issue a Stripe trial.

Why it matters: prior to this fix, the report bucketed someone as "Onboarded" the moment `currentStage` advanced (which happens at the end of Stage 1 — right after Schedule). That meant customers with future-dated calls were shown as "Onboarded" even though their meeting hadn't happened yet. The subscription-based gate is the truthful post-meeting signal.

## Subscription column

Combined string in the terminal/email table:

| Customer state | Column shows |
|---|---|
| No plan picked yet (pre-CPM) | `—` |
| Plan picked, no sub yet (Card saved / Booked) | `$199/mo (pending)` |
| Onboarded gate fired, sub status = Trial | `Trial $199/mo · ends 7/9` |
| Onboarded gate fired, sub status = Active | `Paying $199/mo` |
| Sub status = Past Due / Cancelled | `Past Due $199/mo` / `Cancelled $199/mo` |
| Onboarded gate fired, but no sub found | `⚠ no sub` (red flag — investigate) |

Data sources:
- Amount: `stripe_plans.priceDisplay + pricePeriod`, joined via `customers.selectedStripePriceId`.
- Status: `customers.subscriptionStatus` (kept in sync by Stripe webhook).
- Trial end: `customer_subscriptions.currentPeriodEnd` for the `Core` product row.

The `⚠ no sub` case is a useful signal: it means HS Active → Stripe sub-create didn't fire (or the webhook missed). Today's report surfaces it instead of hiding it.

## Call Date column

Same column, dual-meaning by bucket:
- **Booked rows** → upcoming call (future date).
- **Onboarded rows** → date the call happened (past date).
- Other buckets → empty.

Source: latest `scheduledDate` from `calls` where `type='Onboarding'` for that customer. We don't filter by `calls.status` because nothing in the live system flips it to `Completed`; the bucket gate (Onboarded vs Booked) carries that meaning instead.

## Labels — why not the DB

Bucket labels live in `scripts/funnel-audit-labels.ts`, not the `workflow_templates` table. Reasons:

1. **Display concern**, not a system-of-record concern. The live app reads task titles ("Capture Payment Method") as imperatives because that's what the customer sees. The funnel report reads them as gap states ("Card saved, didn't book").
2. **No migration on a live system** for a reporting nicety.
3. **Easy iteration** — relabeling is a 1-line edit.

If you run the audit against a workflow with a new milestone task title that has no entry in `funnel-audit-labels.ts`, the script falls back to the raw task title AND prints a warning banner (terminal + email) pointing back to the labels file.

## CSV columns

Same row order as the terminal, but with subscription split into three columns for spreadsheet filtering:

- `name`, `funnelStage`, `callDate`
- `subscriptionState` — one of `Paying / Trial / Past Due / Cancelled / Pending / Missing / ""`
- `monthlyAmount` — raw `priceDisplay + pricePeriod` (e.g. `$199/mo`) or empty
- `trialEndsOn` — ISO date or empty
- `contactEmail`, `platformEmail`, `phone`, `created`, `daysSinceCreated`, `stuck` (true/false), `env`, `hubspotTicketId`, `stripeSubscriptionId`

`stuck` flips true for non-terminal buckets aged ≥ `--stuck-days` (default 3). Use to filter the spreadsheet to "needs nudging."

## Email mode

`--email` sends an HTML body + CSV attachment via Resend (uses the same `RESEND_API_KEY` and `success@rejig.ai` from address as the customer-facing email path).

Email body sections:
1. Header (with `B2B-` prefix stripped)
2. Generated date
3. Unmapped-milestone banner (if any)
4. Funnel-stage counts table
5. Per-customer table
6. Footer with rerun command

CSV is always attached when `--email` is used.

Recipients are free-form (no allowlist). Mistyped addresses fail at Resend.

## How to present results to the user

- Lead with bucket counts (the funnel summary they asked for).
- Follow with the per-customer table.
- If they only asked for counts, skip the per-customer table.
- If they passed a brokerage slug, repeat the resolved `workflow_key` in your summary.
- For CSV runs, surface the file path so they can open it.
- For email runs, surface the recipient list and subject.
- If the warning banner fired (unmapped milestones or `⚠ no sub` rows), call them out — they're real signals.

## What this skill does NOT do

- D2C workflows (intentional — different report shape).
- HubSpot side-of-house state directly — only mirrored fields on the customer row.
- Historical funnel — point-in-time snapshot. For trend analysis, run `--csv` periodically and diff `scripts/data/`, or schedule periodic `--email` runs via `/schedule`.

## Related

- Original one-off: `scripts/ipre-funnel-snapshot.ts` (kept for reference).
- Brokerage list: `scripts/dump-brokerages.ts`.
- Per-workflow template inspection: `scripts/check-ipre-tasks.ts` (and analogous).
- Labels + onboarded-gate config: `scripts/funnel-audit-labels.ts`.
