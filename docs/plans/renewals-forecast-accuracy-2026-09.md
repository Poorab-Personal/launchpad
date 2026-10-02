# How accurate was the September 2026 churn forecast?

**Measured 2026-10-02.** Forecast = the renewals digest emailed **2026-08-25**
by the old LP-based script. Actuals = live Stripe.

## Headline

On the population that was actually live when the forecast was sent:

| Metric | Result |
|---|---|
| Precision — of rows flagged at-risk, share that churned | **35%** (6/17) |
| Recall — of September churn, share flagged in advance | **33%** (6/18) |
| Base rate — share of live rows that churned | 15% |
| Lift over flagging at random | **2.3x** |

The at-risk flag carries real signal — a flagged row was 2.3x more likely to
churn than an average one — but it misses two thirds of churn and two thirds of
its warnings are false. It is a triage hint, not a forecast.

## Revenue

| | |
|---|---|
| Forecast as sent | $57,886 |
| Collected from those same rows | $35,358 (**61%**) |
| Shortfall | $22,528 |
| Account-wide September collections | $62,394 |

Two independent errors, in opposite directions, roughly cancelling: the
forecast over-counted its own rows by 39% while entirely omitting revenue that
did arrive. It landed within 7% of the real total by luck, not accuracy.

## 20% of the forecast was never billable

$11,830 of the $57,886 could not have been collected by anyone:

| Cause | Rows | $ |
|---|---|---|
| Subscription already **cancelled** before the forecast was sent | 12 | $9,280 |
| Keyes **group-plan seats** with no individual subscription | 17 | $2,550 |
| **Total phantom** | **29** | **$11,830** |

The cancelled ones had been dead for months — the oldest since 2026-03-11.
They survived in the report because LP's `current_period_end` mirror never
advanced, so a dead sub keeps matching a future month's window forever. That is
the same stale-mirror defect documented in
`docs/plans/renewals-digest-stripe-truth.md`.

The 17 group-plan seats are LP customers pointing at the shared Keyes pilot
subscription. Their $150/mo was already being billed once, as seats on Mike
Pappas's subscription, so counting them individually double-counted it. See
`docs/integrations/keyes-pilot-to-individual.md`.

**This inflated the apparent hit rate.** Unfiltered, the at-risk bucket scores
58% precision — but 11 of those 15 "catches" were subscriptions that had
already cancelled before the email went out. Predicting a death that has
already happened is not skill. Restated on live rows only, precision falls from
58% to 35%.

## Where the forecast was wrong about dates, not churn

11 rows had a healthy subscription that simply was not charged in September —
the mirror had drifted, and their real next charge was October or later
(`debrasimon@keyes.com` was off by four months). Not churn, but $1,450 of
timing error.

## The 12 genuine misses

Live on 2026-08-25, flagged safe, cancelled during September:

| $ | Customer | Cancelled |
|---|---|---|
| 1,080 | keniavidaurrazaga@gmail.com | 2026-09-08 |
| 1,080 | mattlindahl@keyes.com | 2026-09-23 |
| 900 | info@notemortgage.com | 2026-08-31 |
| 300 | asremia@gmail.com | 2026-09-03 |
| 300 | rmilligan@miloffaubuchon.com | 2026-09-01 |
| 300 | rcavaliere@ipre.com | 2026-09-11 |
| 300 | judyballard01@gmail.com | 2026-08-27 |
| 300 | debbiedietz@keyes.com | 2026-09-15 |
| 150 | liznunes@keyes.com | 2026-09-24 |
| 119 | blakesteedley@keyes.com | 2026-09-11 |
| 119 | kbrannon@ipre.com | 2026-09-10 |
| 119 | marksadek@keyes.com | 2026-09-21 |

**Nine of the twelve are B2B trial conversions** (Keyes/IPRE at $119/$300/$1,080)
that cancelled within weeks of their first charge. The at-risk rule never looks
at them, because it keys off `engagement_drop_30d` and payment failure — and a
brand-new agent has no 30-day engagement history to drop. The single largest
blind spot is not a scoring weakness, it is a missing rule: **first-charge
trial conversions are an unmodelled churn class.**

Two more (`info@notemortgage.com`, `judyballard01@gmail.com`) cancelled in the
six days between the email being sent and September starting — effectively
unforecastable at that horizon.

## The 11 false alarms

All renewed and paid normally. Nine of the eleven were flagged solely on
`engagement_drop_30d`. Low engagement predicted churn at roughly the base rate
here, which is why precision is only 35%: on its own it is close to noise.
`payment_past_due` was the stronger signal — both past-due flags
(`bretceren@gmail.com`, `ericgreen@kw.com`) are still unpaid.

## A past forecast cannot be reconstructed

Re-running the old script for September on 2026-10-02 returned **31 rows /
$15,194** against the **147 rows / $57,886** it had actually sent on
2026-08-25. Once a subscription charges, its period end advances out of the
window and the row vanishes; what remains is mostly the stale rows that never
advanced. The new Stripe-first script is no better for this purpose — Stripe's
own next-charge dates advance too.

**So forecast accuracy can only be measured against an artifact archived at
send time.** This analysis was only possible because the August email carried a
CSV attachment. `scripts/renewals-digest.ts` now writes the CSV to
`scripts/data/` on every emailed run, not just with `--csv`.

## What to change

1. **Add a first-charge trial-conversion risk rule.** Nine of twelve misses sit
   here. Signals available at the time: never logged in, zero posts, no posts
   since onboarding. Several of the missed rows read `login never · 0 posts`
   in the very email that called them safe.
2. **Stop trusting `engagement_drop_30d` alone.** It drove nine of eleven false
   alarms. Either require a second signal or down-weight it to "watch".
3. **Phantom rows are fixed** by the Stripe-first rewrite: cancelled subs can no
   longer appear, and group-plan seats surface once, as seats.
4. **Score every month from now on.** With the CSV archived automatically, this
   analysis becomes a repeatable monthly check rather than an archaeology
   exercise.
