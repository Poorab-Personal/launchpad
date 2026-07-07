---
name: stripe-subs
description: Direct Stripe pull of subscriptions / payments for a B2B brokerage, straight from the Stripe API on the plan price IDs LP knows (stripe_plans). Three modes — current active+trialing, a single-month cash report (--month, payments actually received that month), or cumulative cash through a date (--as-of). Reports per-customer name / email / amount / plan, counts split by plan, paying-only revenue, and an optional rev-share; supports --exclude for internal rows and flags duplicate subs. Bypasses the LP funnel entirely — use for brokerages where LP never held the full customer set (e.g. the Keyes backfill cohort). Optional CSV + email via Resend. Use when the user asks "how many <brokerage> paying vs trialing", "pull Keyes subs from Stripe", "Keyes payments for June / monthly Stripe report", "what's <brokerage> billing right now", "revenue / rev-share for <brokerage>", or wants a Stripe-truth count the funnel can't give.
metadata:
  scope: project
  type: audit-report
---

# Stripe Subs (B2B, direct pull)

Answers **"what is Stripe actually billing for this brokerage's product right now?"** — a pure Stripe pull, no LP-customer or Rejig join.

## When to use — and when NOT to

Use this (not `funnel-audit`) when the question is about **billing reality**:
- "How many Keyes customers are paying vs trialing?"
- "Pull the Keyes subs from Stripe."
- "What's IPRE billing right now / what's the monthly revenue?"
- "Rev-share owed back to <brokerage>."

Prefer `funnel-audit` when the question is about **onboarding progress** (who's stuck, who booked, furthest milestone).

**Why a separate skill:** the funnel walks LP tasks, so it only sees customers LP created. For brokerages where LP never held the full set (the Keyes Oct-2025 backfill cohort self-onboarded straight into Rejig/Stripe, bypassing LP intake), the funnel undercounts and its `subscriptionStatus` column is a stale mirror field. Stripe is the complete, live source. This skill reads Stripe directly.

## How to invoke

```bash
npx tsx scripts/stripe-subs.ts <workflow_key|brokerage_slug> [flags]
```

### Positional
- `<workflow_key>` — `B2B-Keyes`, `B2B-IPRE`, `B2B-BW` (case-sensitive), OR
- `<brokerage_slug>` — `keyes`, `ipre`, `bw` (matched against `brokerages.landing_page_slug`, case-insensitive → resolves to `defaultWorkflowKey`).

### Flags
| Flag | Default | Meaning |
|---|---|---|
| `--month <YYYY-MM>` | none | **Cash-basis, single month.** Count only payments whose paid date falls in that month; a customer is "Paying" iff a real payment landed in the window. This is the monthly-cadence unit — run it each month. Mutually exclusive with `--as-of`. |
| `--as-of <YYYY-MM-DD>` | none | **Cash-basis, cumulative through a date.** All Keyes cash ever collected up to that date. Lifetime-to-date baseline; long-time payers show large totals. Mutually exclusive with `--month`. |
| `--exclude <a,b,c>` | none | Drop rows whose customer email **contains** any of these substrings (case-insensitive). Use for internal / non-brokerage rows, e.g. `--exclude @rejig.ai,mattmadden@kw.com`. |
| `--customer <q>` | none | Drill-down: filter to rows whose **name or email** contains `<q>`, and dump every invoice on each matched sub (with the counted one marked) plus the window gross/refunded/net. Use to answer "why is X included / where's Y?". |
| `--rev-share <pct>` | `15` | Rev-share percentage back to the brokerage. In default/`--as-of`/`--month` modes it's applied to the revenue figure shown (effective-monthly in default mode, collected cash in cash modes). Accepts `15` or `0.15`. Pass `0` to hide the column. |
| `--email <a,b,c>` | none | Comma-separated recipients. Sends HTML summary + CSV attachment via Resend (`success@rejig.ai`). |
| `--subject <s>` | auto | Override email subject. |

### Examples
```bash
# Current-state: active + trialing right now, effective-monthly revenue
npx tsx scripts/stripe-subs.ts keyes
npx tsx scripts/stripe-subs.ts B2B-Keyes --email poorab@rejig.ai

# Monthly cash report (the recurring one) — payments received in a month
npx tsx scripts/stripe-subs.ts keyes --month 2026-06 --exclude @rejig.ai,mattmadden@kw.com --email poorab@rejig.ai

# Cumulative cash collected through a date
npx tsx scripts/stripe-subs.ts keyes --as-of 2026-06-30

npx tsx scripts/stripe-subs.ts ipre --rev-share 20 --email poorab@rejig.ai
npx tsx scripts/stripe-subs.ts bw --rev-share 0        # hide rev-share, counts + revenue only
```

## Three modes

| Mode | Trigger | "Paying" means | Revenue = | Rev-share on |
|---|---|---|---|---|
| **Current-state** | (no date flag) | sub is `active` right now | effective **monthly** rate | monthly rate |
| **Monthly cash** | `--month YYYY-MM` | a payment landed **in that month** | cash **collected in the month** | collected cash |
| **Cumulative cash** | `--as-of YYYY-MM-DD` | any payment landed **on/before the date** | cash **collected through the date** | collected cash |

Cash modes read Stripe **paid invoices** (`status_transitions.paid_at`), not sub status — the actual money-in-the-door record. Subs that started after the window are excluded ("nothing after"). Trials in cash mode are those whose trial overlapped the window (no payment yet → $0, shown for context only). Note the extra Stripe cost: cash modes list invoices per subscription and resolve each in-window invoice's charge (invoice → `payments[].payment.payment_intent` → PI `latest_charge`) to read refunds, so they're several API calls per paying sub — slower than current-state.

**Refunds are netted out.** For each in-window payment, the resolver subtracts the charge's `amount_refunded`. A payment later fully refunded contributes **$0** and the customer drops out of the paying count (listed in a "Fully refunded → excluded" footnote); partial refunds reduce their collected figure (noted in a "Partial refunds netted" footnote and a `refunded` CSV column). This matters for rev-share — you must not pay a brokerage a share of money you handed back. (Real case: 4 Keyes agents paid $119 in June 2026 and were fully refunded; netting them out dropped June collected from $6,518 to $6,042 and rev-share from $977.70 to $906.30.) Note the linkage lives under `invoice.payments`, not the deprecated `invoice.payment_intent` top-level field.

**Duplicate flagging:** if the same customer email appears on more than one counted row in a cash window (e.g. two subs both charging that month), those rows are flagged with `‼` in the terminal, highlighted in the email, and carry `dup=true` in the CSV — surfaced, never silently double-counted. Verify before treating both as real revenue.

## What it does

1. Reads the brokerage's plan **price IDs** from `stripe_plans WHERE workflow_key=<key>`.
2. Lists live Stripe subscriptions on those prices with status **`active` (→ Paying)** and **`trialing` (→ Trial)**, paginated, customer expanded for name/email.
3. Computes the **effective monthly** amount per sub, honoring `interval_count` (see below).
4. Splits counts + paying-only revenue by plan, applies the rev-share, and renders terminal + CSV + optional email.

## Effective-monthly / prepay handling — important

Amount is taken from the live Stripe price `unit_amount`, and **the per-month figure honors `interval_count`**. A "Quarterly Prepay" plan billed `$300` every `3 months` is:
- `amount` column → `$300 / 3 months` (the actual charge)
- `perMonth` column → `$100/mo` (effective) — this is what revenue and rev-share are computed on.

So for that plan, a 15% rev-share is **$15/mo per customer**, paid across the 3 months (= $45 per quarter). The email footnote states this per plan, generated dynamically from each plan's real cadence — no hardcoding, so new plans/brokerages describe themselves correctly. Monthly-interval plans just show `$X/mo × pct`.

Revenue and rev-share are **paying only** — trials are excluded from all `$` figures (but still counted in the Trialing column).

## Output

**Terminal**: plan list, totals (`Paying` / `Trialing`), a "Monthly economics — paying only" block (per-plan revenue + rev-share + dynamic footnote), a by-plan counts block, then one line per customer.

**CSV** (`scripts/data/<workflow_key-lower>-stripe-subs-<YYYY-MM-DD>.csv`): `name, email, state, plan, amount, perMonth, currentPeriodEnd, created, subId, priceId`. Note there is **no `trialEnd` column** — Stripe keeps `trial_end` populated even after a sub converts to paying, so it reads as a confusing "trial" date on paying rows. `currentPeriodEnd` (next charge/renewal date) is the useful field and is kept.

**Email** (`--email`): HTML body (economics table on top → by-plan counts → per-customer table) + the CSV attached. Same Resend path (`success@rejig.ai`) as the customer-facing email code.

## Gotchas / how to read the output

- **Duplicate people = real duplicate subs.** A customer with two active subs (e.g. one on each plan) appears as **two rows** and is counted twice in `Paying` and in revenue — because Stripe is billing both. That's billing reality, not a bug. If a double is a known error to be canceled, call it out separately; don't silently dedupe. (As of the first Keyes run: Syndee Yost and Travous Dever each had two active subs.)
- **This is Stripe-truth, not LP-truth.** Names/emails come from the Stripe Customer object, which may differ from the agent's `@brokerage.com` address (personal Gmail, spouse's name on the card, etc.). For cross-system reconciliation (LP ↔ Rejig ↔ Stripe, orphans, sub-ID mismatches), use `scripts/reconcile-keyes-stripe.ts` instead.
- **Live key required.** Brokerage price IDs are live-mode. The script prefers `STRIPE_LIVE_SECRET_KEY` and warns if the resolved key isn't `sk_live_`.

## Related
- `funnel-audit` skill — onboarding-progress funnel (LP-task based).
- `scripts/reconcile-keyes-stripe.ts` — full three-way LP/Rejig/Stripe reconciliation with drift flags.
- Plan config: `stripe_plans` table (per-workflow price options).
