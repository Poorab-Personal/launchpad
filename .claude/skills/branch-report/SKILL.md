---
name: branch-report
description: Brokerage onboarding report grouped by office/branch — who raised a hand, where they stalled, who's subscribed, and how much of each office's roster is untouched. Reconciles against live Stripe and the Rejig product snapshot, so counts match the KPI deck. Sends a branded HTML email (charts + legend) with CSVs attached, either brokerage-wide or scoped to one office. Use when the user asks "send the Keyes report", "send <office> their list", "branch report for <brokerage>", "who hasn't started at <office>", "email the branch managers", "how many agents per office", or wants a per-branch push list for a B2B brokerage.
metadata:
  scope: project
  type: audit-report
---

# Branch report (B2B, per office)

Answers **"where does every agent at this brokerage stand, office by office?"** — and produces something you can send straight to the brokerage.

Script: `scripts/branch-funnel-report.ts`

## The one command that matters

Brokerage-wide, to real recipients:

```bash
npx tsx scripts/branch-funnel-report.ts keyes --stripe --external \
  --exclude @rejig.ai,mattmadden@kw.com \
  --email matt@rejig.ai,poorab@rejig.ai \
  --subject "Rejig across Keyes — where every agent stands"
```

One office (the branch-manager send):

```bash
npx tsx scripts/branch-funnel-report.ts keyes --stripe --external \
  --exclude @rejig.ai,mattmadden@kw.com \
  --branch Doral --email manager@keyes.com
```

`--branch` matches the office **name or number**, as a substring — `Doral`, `225`, `Boynton` all work. Case-insensitive. Run without `--email` first to check you matched the right office.

**Always dry-run the email before sending to anyone outside Rejig:**

```bash
... --preview /tmp/check.html      # writes the email HTML, sends nothing
```

## Non-negotiable flags

| Flag | Why it is not optional |
|---|---|
| `--stripe` | Without it, Trial/Paying come from `customers.subscription_status`, a stale mirror. Counts will not match the KPI deck. |
| `--external` | Anything leaving Rejig. Drops phone numbers and plan prices, replaces our internal stage names with what they mean commercially, and removes the "LaunchPad" product name. |
| `--exclude` | Nothing in the data marks internal accounts. Omit it and Matt Madden counts as a paying Keyes agent. Keep `@rejig.ai,mattmadden@kw.com` for Keyes. |

Other flags: `--csv` (two joined CSVs to `scripts/data/`), `--json` (full payload, used to build artifacts), `--no-detail` (summary only), `--branch`, `--subject`, `--stuck-days N`, `--include-test`.

## It also runs itself, monthly

`/api/cron/branch-report` sends Keyes and IPRE on the **1st of each month**
(14:00 UTC), scheduled in `vercel.json`. Same code path as the CLI — both call
`computeBranchReport` in `src/lib/reports/branch-report.ts`, so a scheduled
send and a hand-run can never disagree about a number.

Recipients live in `RECIPIENTS` in the route, not in a database. Adding a
brokerage, or pointing one at its own distribution list instead of us, is an
edit there and a deploy.

```bash
# what the 1st will send, without sending it
curl -H "authorization: Bearer $CRON_SECRET" \
  "https://onboarding.rejig.ai/api/cron/branch-report?dryRun=1"
# one brokerage, to a chosen address
curl -H "authorization: Bearer $CRON_SECRET" \
  "https://onboarding.rejig.ai/api/cron/branch-report?slug=ipre&to=you@rejig.ai"
```

A brokerage that throws does not block the others; the response reports each
one and returns 500 if any failed.

## What the recipient gets

Brokerage-wide: four stat tiles (raised a hand / subscribed / company-wide % / not yet started), the stage bar with full legend, then every office as a bar sorted by headcount. The per-agent roster is **attached as CSV, not inline** — Gmail clips past ~102KB. Under 60 agents (i.e. a single office) the roster is inline.

Charts are plain `<table>` with inline styles. Email clients strip `<script>`, so there is no hover, sort or search — that is what the artifact is for.

## Vocabulary — say it exactly this way

- **Raised a hand** — every agent who took any step, from opening sign-up through to being live. Not the same as subscribed.
- **Subscribed** — live Stripe subscription right now, paying or trialing.
- **Unbilled** — account live in Rejig with no subscription behind it. Derived from the latest *full* Rejig pull.
- **Lapsed** — had it, no longer does. A win-back list, not a prospect list.

## Before you send it to a brokerage

1. **Check the Rejig snapshot age.** The email prints which pull it used. The ingest dies quietly (Cloudflare 524 — see [[rejig_ingest_524_failure]]). If it is more than a week or two old, "Unbilled" and "Lapsed" may name people whose status has since changed. Do not put stale churn claims in front of a client.
2. **Read `docs/integrations/keyes-pilot-to-individual.md`** if the numbers look wrong for Keyes. Every Keyes miscount so far traces back to that history.
3. **Preview it.** `--preview` then open the file.

## Known limits

- Non-selling offices (Corporate, Title, Mortgage, Insurance, RELO, Keyes Recruiting) are in the denominator and drag the company-wide percentage down. No flag excludes them yet.
- An agent whose Stripe billing identity differs from their LP record is matched by subscription id, then email, then a normalised name key. Nickname cases can still slip (see the doc above).
- Stripe-only rows display the **Stripe customer name**, which is occasionally a spouse or business entity rather than the agent.
