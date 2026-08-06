# Plan — Align `/admin/stuck` to the Drop-off Reminder Cadence + Surface Outreach Info

**Status:** Draft, pending architect review.
**Author:** Claude (LaunchPad)
**Date:** 2026-08-06

## Problem

Three gaps found while reviewing `/admin/stuck` against the drop-off reminder cron shipped earlier today (`docs/plans/dropoff-reminder-cron.md`):

1. **`/admin/stuck` has no persistent navigation entry.** It's only reachable by clicking through the "Stuck Customers" tile on `/admin` — no link in the admin header nav. The user had forgotten it existed.
2. **Its day-thresholds (3d / 7d) predate the reminder cron and don't match its cadence (2d / 5d / 8d).** The admin view and the automation now disagree about what "stuck" means at each checkpoint.
3. **The green/yellow/red color scale is binary** (red ≥7d, yellow otherwise) and doesn't reflect the cron's actual states — whether a reminder has fired, and whether it's been escalated.

Separately (carried over from the prior "outreach info" discussion): `tasks.lastReminderAt` / `tasks.escalatedAt` already exist and flow into every relevant query, but aren't rendered anywhere in the admin/workspace UI yet.

---

## Design

### 1. Navigation

Add a `<Link href="/admin/stuck">` to the persistent header in `src/app/admin/layout.tsx` (lines 23-36), alongside the existing `/admin` and `/workspace` links. This wraps every `/admin/*` route including `/admin/stuck`, so no separate auth work is needed — `requireSession()` in the layout already gates it.

### 2. Threshold recalibration: `[3, 7]` → `[2, 5, 8]`

`STUCK_THRESHOLD_DAYS` in `src/lib/db.ts` (line 1384) is the source of truth, but **six other locations hardcode literal `3`/`7` values that don't derive from it** and will silently break or mismatch if only the constant changes:

| File | Line(s) | Issue |
|---|---|---|
| `src/lib/db.ts` | 1440-1443 | `getStuckCustomerSummary()`'s `counts` seed object is a hand-written literal keyed `3`/`7`, not generated from the array |
| `src/lib/db.ts` | 1455 | `keyesStuckWithoutCardCount` gate: `days >= 7 && wk === 'B2B-Keyes'` |
| `src/app/admin/page.tsx` | 102-105 | `StuckCustomersTile`'s `buckets` array is a hand-written 2-entry literal (`{threshold:3,...}`, `{threshold:7,...}`), not derived from the constant — needs to become 3 entries |
| `src/app/admin/page.tsx` | 126 | Copy string: "beyond the 3-day threshold" |
| `src/app/admin/page.tsx` | 166, 169 | `threshold === 7` gate + hardcoded `threshold=7` in the no-card drill-down href |
| `src/app/admin/stuck/page.tsx` | 41 | Default threshold fallback: `: 3` |
| `src/app/admin/stuck/page.tsx` | 42 | `noCardOnly` gate: `threshold === 7` |
| `src/app/admin/stuck/page.tsx` | 99-101 | Pill color ternary: `t === 7 ? red : yellow` (binary) |
| `src/app/admin/stuck/page.tsx` | 233-235 | "Days Stuck" badge color: `c.daysStuck >= 7 ? red : yellow` (binary) |

The bucket semantics stay the same (`days >= threshold`, nested/cumulative — someone stuck 10 days counts in the 2d, 5d, *and* 8d buckets), so the constant-array change is mechanical; the risk is entirely in these hand-written literals not picking up the new values automatically.

**Grid layout:** `StuckCustomersTile`'s `grid-cols-1 md:grid-cols-2` (line 129) needs to become `md:grid-cols-3` for a 3-bucket layout.

### 3. Color scale, tied to what the automation actually does at each tier

Proposed mapping (open question for architect/user — see below):

| Days stuck | Color | Meaning |
|---|---|---|
| 0-1 | Green | Below the first reminder tier |
| 2-7 | Yellow | A reminder has fired (day 2 and/or day 5), not yet escalated |
| 8+ | Red | Final reminder tier — escalation has fired (D2C sales rep / internal ops) |

This makes the color directly legible as "has this triggered an email yet, and was it escalated" rather than an arbitrary staleness gradient — the admin color scale and the cron's actual behavior become the same statement.

**Separate, flagged for a scope decision:** `src/app/admin/customer-list-table.tsx`'s `healthClass()` (lines 35-38) is a *different* metric — days since the customer's **current task's** `activatedAt`, not days since the **customer's stage** was entered (`stageEnteredAt`, what `/admin/stuck` uses). It's already a 3-tier scale (green/yellow/red at 4d/8d) but doesn't match `[2,5,8]` either. Conceptually adjacent, technically a different field — worth deciding whether to realign it too for one consistent visual language across `/admin` and `/admin/stuck`, or leave it alone since it's tracking something genuinely different (task-level, not stage-level).

### 4. Outreach info (carried over from prior discussion)

`tasks.lastReminderAt` / `tasks.escalatedAt` already flow into every `Task` object returned by `getTasksForCustomer()` / `getActiveTasksByCustomer()` — confirmed present on the type and the mapper, just unrendered. Cheapest additions, in priority order:

1. **`/admin/[customerId]` Tasks(N) section** — add a small badge per task row when `lastReminderAt`/`escalatedAt` is set (e.g. "Reminded 2d ago" yellow / "Escalated 5d ago" red-orange), reusing the existing `relativeTime()` helper and badge/color conventions already on that page.
2. **`/admin/stuck` list** — `getStuckCustomers()`'s `blockingTasks[]` would need `lastReminderAt`/`escalatedAt` added to its shape (currently only `{name, taskType}`) to show outreach status per blocking task. Grain question: a customer can have multiple blocking tasks — show the most-recent/most-severe outreach across all of them, or per-task-pill?
3. **`/admin` root list** (`customer-list-table.tsx`) — lower priority; would ride the existing "Current Task" health-dot column.
4. **`/workspace/customers/[id]`** — lowest priority (CSM-facing, less audit-oriented); same Tasks-tree gap exists there.

---

## Open questions for architect review

1. **Color boundary correctness** — does the proposed 0-1/2-7/8+ mapping actually match the cron's tiers cleanly, or is there an off-by-one (e.g., a task at exactly day 5 is mid-yellow already reminded twice, day 7 is still yellow but one day from escalation — is a 2-tier color enough to communicate that, or does day-5-to-7 deserve its own visual step)?
2. **`healthClass()` in `customer-list-table.tsx`** — realign to `[2,5,8]` too, or leave as its own independent scale since it tracks a different field (task `activatedAt` vs. stage `stageEnteredAt`)? Risk of the same color meaning two different things on two pages the same admin user flips between.
3. **Are the 6+ hardcoded-literal call sites listed above the complete set**, or does a fresh grep for `=== 7`, `>= 7`, `: 3`, `threshold=7` etc. across `src/app/admin/` turn up anything missed?
4. **`getStuckCustomers()`'s `blockingTasks[]` shape change** (adding `lastReminderAt`/`escalatedAt`) — any concern with the extra fields on that second-pass query, or a cleaner way to thread them through?
5. **Scope** — is bundling the nav fix + threshold recalibration + color scale + outreach-info surfacing into one plan/PR right, or should the nav fix (trivial, one line) ship independently of the larger threshold/color rework?
