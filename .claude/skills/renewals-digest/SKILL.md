---
name: renewals-digest
description: Monthly renewals and upcoming-charges report, built from live Stripe as the source of truth and enriched from LaunchPad. Buckets by cadence x safety, splits Keller Williams self-serve into its own bucket, puts unmatched Stripe subs in Unclear rather than dropping them, and captures trials converting to a first charge plus a pipeline of captured-card agents with no Stripe sub yet. Terminal / CSV / branded HTML email. Use when the user asks to "run the renewals report", "renewals for <month>", "what renews in November", "upcoming renewals", "who is at risk this month", "monthly renewals digest", "send the renewals email", or wants expected subscription revenue for a month.
---

# Renewals digest

```bash
npx tsx --env-file=.env.local scripts/renewals-digest.ts <month> [flags]
```

`--env-file=.env.local` is **required** — the script's own `dotenv.config()` runs
after imports, so `@/db` throws `POSTGRES_URL is required` without it.

Month accepts `2026-11`, `november`, `november 2026`, `next-month`,
`this-month`, or omitted (defaults to next month).

## Always pass `--exclude @rejig.ai`

Internal test subscriptions bill on real plans in the live account and
otherwise land in the report as revenue. There is no LP `environment=test` flag
on them because they were bought in-product.

```bash
# the standard run
npx tsx --env-file=.env.local scripts/renewals-digest.ts 2026-11 --exclude @rejig.ai

# preview, then send once the numbers look right
npx tsx --env-file=.env.local scripts/renewals-digest.ts 2026-11 --exclude @rejig.ai \
  --email poorab@rejig.ai
```

Send to `poorab@rejig.ai` first and wait for an explicit OK before any wider
distribution.

## Flags

| Flag | Effect |
|---|---|
| `--exclude a@b.com,@domain` | Drop rows whose LP or Stripe email/name contains any term. **Use `@rejig.ai` every run.** |
| `--workflow <key>` | Filter to one workflow. Only applies to LP-matched rows, so Unclear is suppressed — the email says so. |
| `--include-test` | Keep customers flagged `environment=test` (excluded by default). |
| `--no-projected` | Confirmed rows only. |
| `--no-pipeline` | Drop the captured-card-no-sub section. |
| `--email a,b,c` | Send branded HTML via Resend (`success@rejig.ai`); CSV always attached. |
| `--subject <s>` | Override the subject. |
| `--csv` | Also write `scripts/data/renewals-<YYYY-MM>-<today>.csv`. |
| `--note "<text>"` | Red caveat banner at the top of the email. Plain text only — no newlines or HTML, it is escaped and rendered in one block. |

Use `--note` whenever something upstream makes part of the report
untrustworthy. The usual case is a stale Rejig ingest, which freezes the
Engagement column and the BI attention flags while Stripe-derived dates and
dollars stay live. The terminal footer prints the engagement as-of date —
if it is more than ~8 days old, say so in a note.

## Stripe is the source of truth

The script walks live Stripe subscriptions and lets Stripe set the charge date,
cadence and amount. LaunchPad is consulted **only** to attach health signals.
Do not "improve" this by reading LP's `customer_subscriptions.current_period_end`
again — that mirror goes stale silently and a stale row fails the month's
window predicate, so the customer vanishes with no error. It silently omitted
4 paying customers and counted 2 already-cancelled subs in the first November
2026 run. Full write-up: `docs/plans/renewals-digest-stripe-truth.md`.

## Reading the output

Six buckets, then two extra tiers:

- **Non-monthly safe / at-risk** — the primary focus. Quarterly, 6-month, annual.
- **Monthly safe / at-risk**.
- **KW self-serve** — core Rejig's $20 / $50 / $90 Keller Williams tiers. Bought
  in-product, never onboarded through LaunchPad, so no LP customer is expected.
  Revenue, not a data gap. Keyed on product id
  (`KW_SELF_SERVE_PRODUCT_IDS`); if a new tier appears the script warns that a
  product id needs adding.
- **Unclear** — billing in Stripe, no LP match. Money still counted; only the
  health columns are blank. Each row is worth linking.

Tiers:

- **CONFIRMED** — Stripe's own next-charge date is in the month. Fact.
- **PROJECTED** — the next-charge date precedes the month but the sub's cadence
  bills again inside it. Stripe advances `current_period_end` only *after* a
  charge, so without this a monthly plan billing on the 26th is invisible in
  next month's report.

### How the confirmed/projected mix shifts with distance — read this before calling anything broken

| Running | Shape to expect |
|---|---|
| **Current month** | ~0 projected. Every charge in it is already confirmed by Stripe. |
| **Next month** | Both populated. Non-monthly mostly confirmed; most monthly rows projected. |
| **2+ months out** | **Monthly and KW confirmed collapse to ~0** and nearly all monthly revenue sits in Projected. |

That last row is the surprising one. A monthly sub's next-charge date is never
more than ~1 month ahead, so for December (run in October) *no* monthly
subscription can be confirmed yet — they are all projections. Observed on
2026-10-02: October 203 confirmed / 0 projected; November 59 / 148; December
60 confirmed with monthly **and** KW both showing 0, and 159 projected.

So for a far-out month, quote **Total expected**, not Confirmed — Confirmed
alone understates by roughly the entire monthly book. Nothing is broken.
- **PIPELINE** — Keyes/IPRE agent with a captured card but no Stripe sub yet
  (it is created when the HubSpot ticket reaches Active, after the onboarding
  call). Projected from the scheduled call date + the workflow's trial days,
  excluded from every total. Calls more than 14 days stale are ignored.

## Trials

A `trialing` sub's `trial_end` **is** its first charge date, and the amount is
read off whichever plan the agent picked. Keyes and IPRE each sell monthly
($119), quarterly ($300/3mo) and annual ($1,080/yr) and all three are in live
use — never assume the quarterly. The `Trial→1st charge` flag appears only on
confirmed rows; a projected row is a later cycle.

## Identity

Match cascade, most reliable first, with the winning tier shown in Flags:
`stripe_subscription_id` → `stripe_customer_id` → email → normalised name key →
unique name-token subset → same Stripe customer as an already-matched sub.
Indexes every product, not just Core, so Avatar and Voice subs resolve.

**Separate subscriptions stay separate.** A shared billing email does not make
two rows the same person — Jennifer Lux billing from `travousdever@gmail.com`
is a different customer from Travous Dever, and both are real. Where one Stripe
customer genuinely holds several billable subs the row is flagged
(`N subs on this Stripe customer`) and never merged; sometimes that is a second
business, sometimes a duplicate worth cancelling, and that call is the user's.

Seat-based group plans are valued at `unit_amount x quantity`. The Keyes pilot
group plan (Mike Pappas, 14 seats) shows up in Unclear because its LP pointers
were never moved — expected, see `docs/integrations/keyes-pilot-to-individual.md`.

## Known limits

- Brokerages billed outside Stripe (Baird & Warner's master agreement, Ruhl's
  pilot, Coach's invoicing) have no subscription object and are absent by
  nature. The email banner states this.
- Metered/tiered prices have no `unit_amount`; those rows show `??` and count
  as $0.
- Scope is wider than pre-2026-10-02 digests: Avatar plans and the KW tiers are
  included, so totals are not comparable to older runs.
- The report takes a few minutes — it retrieves every billable sub plus one
  customer record per in-window row.
