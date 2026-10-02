# Renewals digest: Stripe as the source of truth

**Status:** shipped 2026-10-02
**Script:** `scripts/renewals-digest.ts`

## The failure that forced this

The November 2026 digest was run from LaunchPad's
`customer_subscriptions.current_period_end`. Validated against live Stripe, it
was wrong in both directions:

| | Subs | Amount |
|---|---|---|
| What the LP-based script reported | 39 | $20,438 |
| − already cancelled in Stripe | −2 | −$1,800 |
| + LP's mirror never advanced | +4 | +$3,000 |
| **Stripe truth** | **41** | **$21,638** |

Worse than the dollar error was the *silence*. The digest selected rows with
`current_period_end BETWEEN <month start> AND <month end>`. A customer whose
mirror is stale does not fail loudly — they simply do not match the predicate
and disappear. The report then fetched live Stripe prices for the rows it did
find, so it looked Stripe-validated while omitting four paying customers.

### Why the mirror goes stale

Take Jessica Layser, a $600 6-month subscription billing every May 27 and
Nov 27:

```
2026-05-18 01:51   LP backfill writes current_period_end = 2026-05-27  (correct then)
2026-05-27         Stripe charges $600, advances the item period to 2026-11-27
2026-06-04         LP's Stripe webhook endpoint is created
2026-10-01         LP still says 2026-05-27
```

Her renewal happened eight days before the webhook endpoint existed, and she
has no `stripe_webhook` signals of any kind. Two structural weaknesses keep it
that way:

1. **The period refresh is reachable by only one path.**
   `updateSubscriptionPeriodsFromStripe` is called from
   `handleSubscriptionEvent` only, behind three early returns (no customer on
   the event, `findAirtableCustomerByStripeId` miss, unmapped status).
   `handleInvoiceEvent` writes invoice status and URL but *not* the period —
   so `invoice.paid`, the most reliable "a renewal just happened" signal
   Stripe sends, cannot advance the mirror.

2. **A `trial_end`-first precedence overwrites good dates with expired ones.**
   `scripts/backfill-customer-subscriptions.ts:111` and
   `src/lib/automations/handle-call-completed.ts:158` both read
   `sub.trial_end ?? item.current_period_end ?? …`. At sub creation that is
   right — for a trialing sub `trial_end` *is* the next charge. Run it over an
   already-converted sub and `trial_end` is history. Six IPRE/Keyes customers
   carry `current_period_end = 2026-07-15` written at `2026-07-16 02:56` (one
   batch, identical second) while Stripe had advanced them to 2026-10-15.

Monthly subs self-heal within weeks, because a charge arrives and fires the
webhook. **A 6-month or annual sub whose last charge predates 2026-06-04 stays
frozen for the whole interval** — precisely the window a renewals forecast
depends on. The bug is invisible in the monthly bucket and concentrated in the
non-monthly one, which is the bucket this report exists to show.

## The principle

> **LaunchPad is never the source of truth for customers.** Stripe decides who
> is billed, when, and how much. LaunchPad contributes only the things Stripe
> does not know: engagement, publishing activity, BI attention flags.

A reconciliation pass over the mirror would have fixed November's numbers, but
it would leave the report one missed cron away from being wrong again. Reading
Stripe directly removes the class of bug rather than the instance.

## Design

Walk live Stripe subscriptions, keep the billable statuses (`active`,
`trialing`, `past_due`, `unpaid`, `paused`), and let Stripe set the charge
date, cadence and amount. Then enrich from LP. Three tiers, kept visually
distinct because they carry different certainty:

- **CONFIRMED** — Stripe's own next-charge date falls in the month. Fact.
- **PROJECTED** — the next-charge date precedes the month, but the
  subscription's cadence bills again inside it. Stripe only advances
  `current_period_end` *after* a successful charge, so without this a monthly
  plan billing on the 26th is invisible in next month's report. For November
  2026 this was 148 subscriptions and $17,386 — about a third of expected
  cash. Derived arithmetic, always labelled.
- **PIPELINE** — LP holds a captured card for a Keyes/IPRE agent but no Stripe
  subscription exists yet (it is created when the HubSpot ticket reaches
  Active, after the onboarding call). Projected from the scheduled call date
  plus the workflow's trial length, and excluded from every total. Calls more
  than 14 days stale are ignored: a call still marked `Scheduled` long after
  its date is an unmarked outcome, not an upcoming meeting, and projecting
  from it invents revenue.

### Unclear, not dropped

A Stripe subscription that cannot be tied to an LP customer keeps its money in
the totals and loses only its health columns. The match cascade, most reliable
first, recording which tier hit:

`stripe_subscription_id` → `stripe_customer_id` → email → normalised name key
→ unique name-token subset → same Stripe customer as an already-matched sub.

The index covers **every** product, not just Core, so Avatar and Voice
subscriptions resolve. The token-subset tier requires two shared significant
tokens and a *unique* candidate — ambiguity yields no match, because attaching
the wrong person's health data is worse than an honest Unclear.

### Keller Williams self-serve is its own bucket, not Unclear

Core Rejig sells $20 Starter / $50 Pro / $90 Elite tiers directly to Keller
Williams agents. They buy inside the product and never pass through LaunchPad
onboarding, so having no LP customer is **expected** — reporting them as
unmatched invites someone to go chasing data that was never meant to exist.
They get their own bucket, counted as revenue.

Keyed on product id, not plan name, so a D2C customer who happens to work at a
KW brokerage is never swept in:

```
prod_UjC0vQ41wyWTV7  Rejig.ai - Starter Plan for Keller Williams  ($20/mo)
prod_UjC3qGGvqTajgn  Rejig.ai - Pro plan for Keller Williams      ($50/mo)
prod_UjC6xw0ZDNvCPK  Rejig.ai - Elite plan for Keller Williams    ($90/mo)
```

A plan-name regex is kept only as a safety net for a newly added tier, and the
run warns when it fires so the product id can be added to the set.

With that split, November 2026 left just 5 rows genuinely Unclear ($2,819) and
October 62 KW rows ($4,080). October's remaining Unclear includes the Keyes
pilot group plan (Mike Pappas, 14 seats, $2,100/mo) whose LP pointers were
never moved, and three Keyes agents paying $300/quarter with no LP record —
real findings that were invisible before.

### Separate subscriptions stay separate

One billing email can front several distinct Stripe customers. Travous Dever
bills two real subscriptions ($300/3mo each, a rental business and a
residential one) from `travousdever@gmail.com` across two Stripe customer
objects, one of them display-named "jennifer lux". Collapsing them would hide
a genuine second business and look like a double charge.

So the report never merges rows. Where the match was fuzzy (email, name, token
subset, same Stripe customer) and Stripe bills under a different name, the row
shows both — `TN Realty (billed as: Tony Ngai)` — otherwise two subscriptions
resolving to one LP customer render identically. And multiple billable subs are
flagged two ways, because they can share either key:

- `N subs on this Stripe customer`
- `N subs on this billing email`

Whether a duplicate is a second business or a billing error is a judgement the
report surfaces rather than makes. Syndee Yost's two Keyes subs remain
unresolved on exactly this basis.

### Trials

A `trialing` subscription's `trial_end` **is** its first charge date, and the
amount is read off whichever plan the agent actually picked — Keyes and IPRE
each sell monthly ($119), quarterly ($300/3mo) and annual ($1,080/yr), all
three in live use. Never assume the quarterly.

`trial_end` is now preferred **only** while the subscription is still
trialing. This is the same trap described above, and the rewrite closes it.

The November run found **zero** trials converting to a first charge: all 10
live trials end in October. The 18 rows the old report tagged `Trial→Paid`
were stale LP status on subscriptions Stripe reports as `active`.

## Known gaps

- Scope widened. The report no longer filters to LP's Core product, so Avatar
  plans and the KW self-serve tiers now appear. More complete, but not
  comparable to digests produced before 2026-10-02.
- Brokerages billed outside Stripe (Baird & Warner's master agreement, Ruhl's
  pilot, Coach's invoicing) have no subscription object and are absent by
  nature rather than by exclusion. The email banner says so.
- Metered/tiered prices have no `unit_amount`; those rows show `??` and count
  as $0.
- The two upstream bugs in **Why the mirror goes stale** are *not* fixed. The
  digest no longer depends on them, but `customers.subscription_status` and
  `customer_subscriptions` remain stale for other consumers — 224 of 487 subs
  had a status disagreeing with Stripe when measured on 2026-10-01.
