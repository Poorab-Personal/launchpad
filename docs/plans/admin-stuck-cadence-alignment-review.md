# Review — Align `/admin/stuck` to the Drop-off Reminder Cadence + Surface Outreach Info

**Status:** Architect review of `docs/plans/admin-stuck-cadence-alignment.md`.

**Reviewer:** Architect (read-only review pass)

**Reviewing:** `/Users/poorabshah/dev/rejig-ai/launchdeck/docs/plans/admin-stuck-cadence-alignment.md`

**Date:** 2026-08-06

Verdict legend: **OK ship as-is** / **CHANGE X** / **SCRAP and rethink**.

---

## 1. Navigation

**Verdict: OK ship as-is.**

Adding `<Link href="/admin/stuck">` to `src/app/admin/layout.tsx`'s header (alongside the existing `/admin` and `/workspace` links, lines 24-35) is exactly right. The layout already wraps every `/admin/*` route in `requireSession()`, so `/admin/stuck` inherits auth for free — confirmed, no route-specific gate exists on `src/app/admin/stuck/page.tsx` beyond what the layout provides. Zero risk, ship independently of everything else in this plan (see §5 below).

---

## 2. Threshold recalibration: `[3, 7]` → `[2, 5, 8]`

**Verdict: CHANGE — the mechanical part (six/seven call sites) is fine, but the premise underneath it is broken. `/admin/stuck`'s "days stuck" and the cron's day-2/5/8 tiers are not the same clock, and renumbering the thresholds doesn't fix that — it just makes two different quantities use the same-looking labels.**

I traced both clocks end to end:

- **The cron** (`src/lib/automations/dropoff-reminders.ts`) computes `daysSince = daysBetween(task.activatedAt, now)` — per **task**. `activatedAt` resets every time a *new task* in the customer's chain goes Draft→Active. Reminder tiers and `lastReminderAt`/`escalatedAt` are all scoped to that one task row.
- **`/admin/stuck`'s `daysStuck`** (`getStuckCustomers()` / `getStuckCustomerSummary()` in `src/lib/db.ts:1449, 1540-1542`) computes days off `customers.stageEnteredAt` — per **stage**. `stageEnteredAt` only advances in `activate-dependents.ts:402` when the *entire stage* transitions (all its tasks complete), not when an individual task inside the stage activates.

Stages are not single-task. Confirmed against the vetted flow docs:
- `docs/flows/d2c-standard.md` Stage 1 has 3 sequential tasks (customer form → Create Designs → Review Designs), Stage 2 has 3, Stage 3 has 5 (with a documented parallel-track caveat the doc itself flags as broken UX).
- `docs/flows/b2b-keyes.md` Stage 1 has 3 sequential Client tasks (Confirm Info → Start Trial → Schedule Call).

So the common case — not the exception — is: a customer dawdles N days on an early task in a stage, then the later tasks in that same stage activate and complete quickly. `stageEnteredAt` never moves during any of this. Concretely: agent takes 8 days to confirm their info (task 1 of B2B-Keyes Stage 1), then starts their trial and books the call within the hour. `daysStuck` (stage clock) reads 8+ and, under the proposed 8+ = red mapping, would render as "escalated." But the *actual* blocking task right now (`Schedule Your Onboarding Call`) has `activatedAt` from minutes ago — the cron's clock reads 0, no reminder has ever been sent, and no escalation has fired. The admin page would claim the customer is in the cron's most severe state while the cron hasn't touched this task at all.

This is one-directional and structural, not a rounding error: because `stageEnteredAt` is always ≤ the currently-blocking task's `activatedAt`, `daysStuck` is **always ≥** the cron's actual per-task day-count. Recalibrating the thresholds to `[2,5,8]` makes `/admin/stuck` systematically over-report severity relative to the cron, never under-report — the opposite of harmless. An admin who has learned "red on `/admin/stuck` means the cron escalated to the sales rep" will be wrong most of the time a stage has more than one task in it.

The fix isn't a different set of threshold numbers — it's sourcing the badge from the right field. Given Decision 4 is *already* about to thread `lastReminderAt`/`escalatedAt` onto `blockingTasks[]`, the color/threshold work in this plan should be redesigned to key off those actual per-task fields (ground truth: has a reminder fired, has escalation fired) rather than reverse-engineering an inference from a recalibrated `stageEnteredAt` day-count. See §3.

The mechanical piece — the six-site table — is otherwise accurate (see §5's grep verification) and the `days >= threshold` nested/cumulative bucket semantics genuinely are unaffected by a constant swap. Keep that part; just don't let it stand in for the real fix.

---

## 3. Color scale, tied to what the automation actually does at each tier

**Verdict: CHANGE — don't infer tier state from a recalibrated day-count band; read the two outreach fields directly once they're threaded through (Decision 4). This also directly answers the plan's own Open Question 1.**

Given §2's finding, the plan's proposed `0-1 green / 2-7 yellow / 8+ red` mapping inherits the wrong-clock problem regardless of which day-count boundaries you pick — it's built on `daysStuck`, which isn't the cron's input. Separately, even taken purely as a question about the cron's *own* tiering (set that aside and just ask "is the banding right, assuming the days were the cron's real days"): yes, there's a real information loss the plan's Open Question 1 already suspects. A task at day 5 has already been reminded twice (tier 2) and is not escalated; a task at day 7 is one day from escalation. Both currently render as identical yellow. That's a meaningful state difference for an admin deciding whether to intervene manually before the cron auto-escalates — collapsing "reminder 1 sent" and "reminder 2 sent, about to escalate" into one color is losing exactly the signal this plan exists to surface.

Once `blockingTasks[]` carries `lastReminderAt`/`escalatedAt` (Decision 4), the color doesn't need day-count inference at all:
- `escalatedAt` set → red ("escalated — sales rep/ops notified").
- `lastReminderAt` set, `escalatedAt` null → yellow, and you can label it "reminder 1/2/3 sent" from the same `tierForDays` arithmetic the cron itself uses, rather than guessing.
- Neither set → green.

This is strictly more accurate than any day-count band, requires no boundary judgment call, and is literally "the same statement" the plan's problem section wants — because it's reading the same fields the cron writes, not a proxy. It does mean Decisions 3 and 4 are not actually separable the way the plan's Design section presents them (3 first, 4 "carried over separately") — 4's data is what 3 should be built on. Recommend folding them into one change.

One smaller note: the `StuckCustomersTile` bucket array (currently 2 entries, `>3d` yellow / `>7d` red) becomes 3 entries under `[2,5,8]`. If you keep the day-count coloring at the tile level (a coarser, `stageEnteredAt`-based "how long has this customer's stage been idle" view is legitimately useful on its own, distinct from cron-tier meaning — just don't call it cron-aligned), the `>2d` and `>5d` buckets would both render yellow under the proposed 3-band scale, which reads a little flat in a 3-column layout. Not a blocker, just worth a glance once it's laid out.

---

## 4. Outreach info (`lastReminderAt` / `escalatedAt`)

**Verdict: OK ship as-is for the type/data-flow claims (verified), CHANGE on one implementation detail for item 2.**

Verified independently, not taking the plan's word for it:
- `src/types/index.ts:219-220` — `Task.lastReminderAt` / `Task.escalatedAt` exist on the type.
- `src/lib/db.ts:253-254` — `mapDbTask()` populates both from the row.
- Both `getTasksForCustomer()` (`src/lib/db.ts:717-725`) and `getActiveTasksByCustomer()` (`src/lib/db.ts:848-863`) go through `mapDbTask()`, so the plan's claim that these fields "already flow into every relevant query" holds for the paths it names.
- `src/app/admin/[customerId]/page.tsx:524-611` — the `Tasks (N)` section renders one row per task with existing status/type/assignee pills already in place; a `lastReminderAt`/`escalatedAt` badge slots in cleanly next to them, and `relativeTime()` (line 38, `src/app/admin/[customerId]/page.tsx`) already exists for exactly this kind of "Xd ago" rendering — worth noting its `d < 7` branch is a generic display-format cutoff (switch to calendar date past a week), unrelated to `STUCK_THRESHOLD_DAYS`; correctly *not* one of the plan's hardcoded-threshold call sites (see §5).

Item 2 — **`getStuckCustomers()`'s `blockingTasks[]` shape change**: mechanically clean (the second-pass query at `src/lib/db.ts:1506-1520` already selects a handful of columns off `schema.tasks`; adding `lastReminderAt`/`escalatedAt` is two more fields in that `select`). The real gap: that query doesn't select `activatedAt` either. Without it, you can render "last reminded 3d ago" but you can't correctly derive which tier that was or whether a new tier is now due without re-implementing `tierForDays`/`daysBetween` a second time in the admin layer — which is precisely the "hardcoded literal drifts from the source of truth" failure mode Decision 2's own six-site table is trying to avoid, just in a seventh place. Recommend one of: (a) export `tierForDays`/`daysBetween` from `dropoff-reminders.ts` for the admin page to import, or (b) keep the admin display purely informational ("last reminded Nd ago" / "escalated Nd ago", no tier prediction) and skip deriving anything cron-shaped in the UI. (b) is the cheaper, lower-drift-risk choice for a v1 and is consistent with this page's existing "read-only tactical view" framing (`src/lib/db.ts:1370-1381`).

The grain question the plan raises (most-severe vs. per-pill display across multiple blocking tasks) is a legitimate implementation-time call, not something that needs resolving here.

---

## 5. `healthClass()` in `customer-list-table.tsx` (Open Question 2)

**Verdict: CHANGE — don't decide this in isolation; it's downstream of §2/§3, and the plan has the relative correctness backwards.**

Verified the plan's factual claim: `daysActive()` (`src/app/admin/customer-list-table.tsx:29-33`) computes `Date.now() - (task.activatedAt || task.createdAt)` on the result of `pickCurrentTask()` (line 23-27), which selects a task from `activeTasksByCustomer[customer.id]` filtered to `t.stage === currentStage`. This is genuinely a different field from `/admin/stuck`'s `daysStuck` — confirmed, it's task-level (`activatedAt`), not stage-level (`stageEnteredAt`).

But this makes `customer-list-table.tsx`'s metric the one that's *already close to the cron's actual clock* — task-scoped, not stage-scoped — while `/admin/stuck`'s is the one structurally mismatched (§2). The plan frames this as "two adjacent-but-different metrics, pick one to realign," which undersells the asymmetry: `healthClass()`'s current `[4, 8]` bands are on the right axis with the wrong numbers; `/admin/stuck`'s bands are on the wrong axis entirely. Realigning `healthClass()` to `[2,5,8]`-style bands *before* fixing `/admin/stuck`'s data source would actually make `customer-list-table.tsx` more correct while leaving `/admin/stuck` broken — the two pages would then use the same color language to mean genuinely different things (one task-accurate, one stage-inflated), which is worse for the admin flipping between them than today's status quo where at least neither claims to track the cron. Sequence matters: fix `/admin/stuck` per §2/§3 first (source its color from `blockingTasks[].lastReminderAt`/`escalatedAt`, or at minimum from the blocking task's own `activatedAt`), *then* realign `healthClass()`'s bands to match — at that point both pages are reading the same kind of clock and consistent bands genuinely produce one visual language, which is what Q2 is actually asking for.

---

## 6. Are the six-plus hardcoded call sites the complete set? (Open Question 3)

**Verdict: The plan's list is complete.** I ran the grep myself rather than trusting the table:

```
grep -rn -E "\b(3|7)\b" src/app/admin  →  no stuck-threshold hit outside the plan's list
grep -n -E "\b(3|7)\b" src/lib/db.ts   →  no stuck-threshold hit outside the plan's list
grep -rn "/admin/stuck" src/           →  no additional href/threshold literal outside stuck/page.tsx and page.tsx
```

The only extra `7`-literal turned up by the raw grep is `relativeTime()`'s `if (d < 7) return \`${d}d ago\`` in `src/app/admin/[customerId]/page.tsx:47` — a generic "days-ago" display-format cutoff (switches to calendar-date rendering past a week), unrelated to `STUCK_THRESHOLD_DAYS` or the stuck feature at all. Correctly not on the plan's list, and correctly should stay off it. No other candidate site exists in `src/app/admin/` or `src/lib/db.ts`. The plan can drop this from "open question" to "confirmed" in the final doc.

---

## 7. Scope — bundle all four decisions, or split? (Open Question 5)

**Verdict: CHANGE — split nav out (ship now), but the plan's implicit "2+3 mechanical now, 4 maybe-later" framing is also wrong given §2/§3's finding.**

Nav (§1) is a one-line, zero-risk change with no dependency on anything else in the plan — ship it today, independently, exactly as the plan's own Open Question 5 leans toward.

The threshold/color/outreach cluster (§§2-4) is not actually three independently-sizeable pieces of work the way the plan's Design section lays them out (numbered 2, 3, 4 as if sequential and separable). Once you accept §2/§3's finding, Decision 3's correct implementation *requires* Decision 4's data (`lastReminderAt`/`escalatedAt` on `blockingTasks[]`) — coloring by day-count band was the wrong design regardless of which numbers you pick, so there's no clean "ship the threshold/color swap now, outreach info later" milestone; the intermediate state (recalibrated day-count colors, no outreach data yet) is actively misleading in a new way (systematically over-signals red) and would just get replaced once outreach data lands. Better to treat §§2-4 as one redesign — pull `blockingTasks[]`'s task-level fields (`activatedAt`, `lastReminderAt`, `escalatedAt`), drive both the "days" display and the color off those, and skip shipping the day-count-only version at all. That's a larger single pass than the plan currently scopes for "mechanical" Decision 2, but it's the version that's actually correct, and it's not meaningfully bigger in code-touched than the mechanical version plus a follow-up Decision 4 patch would have been.

---

## Top 3 changes I'd make

1. **Redesign the `/admin/stuck` badge to key off the blocking task's own `activatedAt`/`lastReminderAt`/`escalatedAt`, not `customers.stageEnteredAt`.** These are two different clocks — `stageEnteredAt` only advances on full stage transitions, while stages routinely contain 3-5 sequential tasks (confirmed in `docs/flows/d2c-standard.md` and `docs/flows/b2b-keyes.md`) whose individual `activatedAt` resets each time. `stageEnteredAt` is always ≥ the cron's real per-task day-count, so recalibrating its thresholds to `[2,5,8]` makes the admin view systematically over-signal severity (red/"escalated" for tasks the cron hasn't even reminded once) rather than actually agreeing with the automation. Fix the data source, and the color naturally becomes a direct read of `lastReminderAt`/`escalatedAt` rather than a day-count guess. (§§2-3.)

2. **Fold Decisions 2, 3, and 4 into one implementation pass, not a threshold-swap now / outreach-info-maybe-later sequence.** Once the color scale is correctly sourced from the blocking task's own outreach fields (change #1), Decision 3 can't be implemented independently of Decision 4's data plumbing — there's no correct intermediate milestone that ships the day-count recoloring first. Ship the nav link (Decision 1) separately today; ship the threshold/color/outreach cluster together as a redesigned single change. (§§3-4, §7.)

3. **Sequence `healthClass()` realignment (Open Question 2) after, not instead of or alongside, fixing `/admin/stuck`.** `customer-list-table.tsx`'s `daysActive()`/`healthClass()` is already task-scoped (closer to the cron's real clock than `/admin/stuck` currently is) — it just uses different day boundaries. Realigning its bands to `[2,5,8]`-style thresholds only produces genuine cross-page visual-language consistency once `/admin/stuck` is also reading a task-level clock; doing it first or in isolation makes one page more correct and leaves the other systematically wrong, using the same colors to mean different things. (§5.)

### Critical Files for Implementation

- `src/lib/db.ts` (`getStuckCustomerSummary`, `getStuckCustomers`, `STUCK_THRESHOLD_DAYS` — lines ~1370-1550)
- `src/app/admin/stuck/page.tsx` (threshold pills, "Days Stuck" badge, blocking-tasks list)
- `src/app/admin/page.tsx` (`StuckCustomersTile`)
- `src/lib/automations/dropoff-reminders.ts` (source of truth for tier arithmetic — `tierForDays`, `daysBetween`, `REMINDER_TIER_DAYS`, `FINAL_TIER`)
- `src/app/admin/customer-list-table.tsx` (`healthClass`, `daysActive`, `pickCurrentTask`)
- `src/app/admin/layout.tsx` (nav link addition)
