# HubSpot intake-push self-collision

**Diagnosed** 2026-08-12 · **Fixed** 2026-09-14

The `[LaunchPad] HS Ticket Push Failed` alert emails (400 `VALIDATION_ERROR`
— *"Cannot set … propertyName=email … NNN already has that value"*) were
LaunchPad colliding with itself. Not HubSpot flakiness, not a pre-existing
contact, not a search-index problem. Every alert's blocking contact was one
we had created ~600ms earlier in a parallel request.

## The chain

1. `Capture Payment Method` is completed twice, ~100–300ms apart, by two
   independent paths: the browser's `POST /api/customers/[id]/payment-setup/confirm`
   and Stripe's `setup_intent.succeeded` webhook. Both call
   `updateTaskStatus(id, 'Completed')`.
2. `updateTaskStatus` race-guarded only `'Active'` — the `'Completed'` WHERE
   was a bare `eq(id)`, so both UPDATEs won and `handleTaskCompleted` (Auto 2)
   ran twice, concurrently. `handleTaskCompleted` itself only checks *"is this
   task Completed"*, never *"did I already process it"*, so it can't
   self-deduplicate.
3. Every guard inside the push was check-then-act with a ~1.5s window:
   `if (customer.hubspotTicketId) skip`, then `findContactByEmail()` →
   `createContact()`. Both invocations read null. Both created.
4. HubSpot enforces contact email uniqueness → the loser 400s.

The confirm route additionally fires its own explicit push after
`updateTaskStatus`, so a single payment could drive **three** concurrent
pushes.

## Blast radius

The 400 alert was the loud symptom. The quiet one was **duplicate live HS
tickets** — 10 customers between 2026-06-18 and 2026-09-14 (Mary Sibiski,
Amos Eyal, JoAnn Mazzeo, Tim Webb, CJ Wang, Bhavik Patel, Monica Hanna,
Roberto Cavaliere, Kristi Dye, Jennifer Boyce).

Duplicates bite because the inbound HS webhook resolves customers by
`customers.hubspot_ticket_id`. Stage moves on the orphan are invisible to LP,
so a CSM marking the onboarding outcome there means **the Stripe trial
subscription never gets created**. And because both tickets hang off the same
Contact, HubSpot's own workflows enroll both — the orphan drifts to `Active`
alongside the real one and looks entirely plausible in the pipeline.

Auto 2 double-running also meant double dependent-activation, double Slack
intake alerts, and a double Stripe-sub bridge. ~20 tasks carry duplicate
`Task Completed` events.

## The fix

1. **Race-guard the `Completed` transition** (`src/lib/db.ts`) in both
   `updateTaskStatus` and `updateTaskFields`:
   `WHERE id = ? AND status <> 'Completed'`. Zero rows → re-read, return the
   row, and **do not** fire `handleTaskCompleted`. Kills the whole
   double-Auto-2 chain at the source, not just the HubSpot symptom.
   Safe for every caller: all of them pass only `{status, completedAt}` when
   setting Completed, so the loser has nothing left to write.
2. **Claim the push atomically** (migration `0026`, `customers.hubspot_push_claimed_at`).
   One conditional `UPDATE … WHERE hubspot_push_claimed_at IS NULL`, so
   exactly one of N concurrent invocations proceeds. Released on every failure
   path so the Auto 2 backstop and manual re-runs still work; a 10-minute
   staleness window (past the 300s Vercel ceiling) prevents a hard crash from
   wedging a customer permanently. This is the load-bearing guard, because the
   confirm route and the webhook are *legitimately* two different callers.
3. **Adopt the blocking contact instead of failing.** `parseConflictingContactId`
   pulls the existing contact id out of the error and continues with it. Covers
   both HubSpot phrasings — and note the 400 names *two* ids; the one you want
   is the record that "already has that value", not the half-allocated record
   the create was writing to. This also makes genuine search-index lag and
   secondary-email collisions self-healing.
   **Do not retry the create** — that's what gave Roberto Cavaliere his second
   ticket. Retry only 429/5xx.
4. **Don't alert on a lost race.** The failure path re-reads the customer; if a
   ticket now exists, it writes an `HS Ticket Push Raced` event and sends no
   email. All 10 historical alerts claimed "The HubSpot ticket was NOT created"
   while the ticket existed, made ~600ms later by the winner.

Regression test: `tests/hubspot-contact-conflict.test.ts` (fixtures are the
verbatim 2026-09-14 error bodies).

## Cleanup

`scripts/archive-duplicate-hs-tickets.ts` archives the 10 orphans. Dry-run by
default. HubSpot archive is a soft delete (recycling bin, 90 days).

Two hard refusals guard it: the candidate must not be any customer's
`hubspot_ticket_id`, and **the keeper must already hold every meeting
associated to the candidate**. The second one matters because meetings are how
a CSM reaches a ticket and where the onboarding outcome gets recorded —
archiving a ticket carrying a meeting the keeper lacks would hide that meeting
from the surviving ticket.

Verified 2026-09-14: all 10 pass. It works out because LP associates the
meeting via `ensureMeetingTicketAssociation`, keyed off
`customers.hubspot_ticket_id` — so the meeting always lands on the ticket LP
knows about. Mary Sibiski's and Jennifer Boyce's orphans hold zero meetings;
the other 8 carry the same meeting ids as their keeper (HubSpot's own
workflows enroll both tickets, since both hang off one Contact). Still a
guard, not an assumption — the next collision might not be so tidy.

## Unrelated gap surfaced while auditing

**Mary Sibiski** (B2B-Keyes, created 2026-06-18) has a Stripe customer and a
selected plan (`Keyes Monthly`) but **no subscription**, and has sat at
`Onboarding Scheduled` since June. Both her tickets are still at
`Onboarding Scheduled`, so this reads as a no-show rather than a
collision casualty — but she's been unbilled for ~3 months. Needs a decision,
same class as the items in `pending_default_pm_followups`.
