# Internal Task Assignee Notifications

**Status:** Approved with revisions (2026-06-02). Architect-reviewed and product-locked.

## Goal

When a task becomes actionable for an internal team member (Designer, Senior Designer, Account Creator, Admin), send them a Resend email so they don't have to poll `/workspace` to discover new work. Triggers include:

- Customer submits intake → "Create Designs" activates → notify assigned Designer
- Designer uploads proof → "Review Designs" activates → notify Senior Designer
- Customer approves designs → "Move Designs to Production" activates → notify Designer
- Customer requests changes → "Revise Design (Round N)" created Active → notify Designer
- Workspace user reassigns an Active task → notify new assignee

Out of scope (separate feature): customer-side nudges for stalled portal tasks + escalation to sales@rejig.ai.

## Decisions locked with product

| Decision | Value | Reason |
|---|---|---|
| Trigger condition | Task transitions Draft → Active (or activates Active at create), with `assignedToTeamMemberId != null` | Draft tasks aren't actionable; null assignee = nobody to notify |
| Cadence | One email per task activation | All workflows audited — only Client intake task starts Active at creation; Team tasks activate one-at-a-time as deps clear. Bundling deferred until proven needed. |
| CSM scope | Skip CSM-only assignees, always (including reassignment) | CSM lifecycle is managed entirely in HubSpot per `hubspot_integration_decision.md` — no LP emails to CSMs, ever. Multi-role members (e.g. Designer + CSM) still notify when acting in their non-CSM role. |
| Dedupe | `tasks.assignee_notified_at` stamped in the same race-guarded UPDATE that flips status to Active | Pre-stamping inside the activation UPDATE eliminates the double-notification race that a post-send stamp would leave open. Cleared on reassignment. |
| Delivery | Resend (existing `sendEmail()` infrastructure) | Same pattern as Welcome / Design Ready / Credentials Sent. |

## Architecture

### Schema change

New column on `tasks`:

```ts
// src/db/schema/tasks.ts
assigneeNotifiedAt: timestamp('assignee_notified_at', { withTimezone: true }),
```

No index — column is read by primary key (`WHERE id = $1`) inside the new automation, never scanned.

Migration generated via `npm run db:generate`, applied via `npm run db:migrate`.

### New module: `src/lib/automations/notify-assignee.ts`

```ts
export async function notifyTaskAssigned(taskId: string): Promise<void>
```

Logic:

1. Load task + assignee (team_member) + customer in parallel.
2. Short-circuit (no-op, log) if:
   - Task not found
   - Task status != 'Active'
   - `assignedToTeamMemberId` is null
   - Assignee `active = false`
   - `assigneeNotifiedAt` already set (idempotency)
   - Assignee's `roles` array equals `['CSM']` exactly (CSM-only — HubSpot handles them; multi-role members like Designer+CSM still notify)
   - Customer `createdVia = 'backfill'` (mirrors `triggerCustomerEmail` Phase 2 suppression)
3. Send via Resend using new `'task-assigned'` template.
4. Stamp `assigneeNotifiedAt = now()` on the task.
5. Log `'Assignee Notified'` event with `relatedTaskId`, actorType `'System'`.
6. Wrap step 3+4 in try/catch — best-effort, log errors, never throw (matches `triggerCustomerEmail` discipline).

### Email template

New file: `src/lib/email/templates/task-assigned.tsx` (React Email, same pattern as `design-ready.tsx`).

Data shape:

```ts
interface TaskAssignedData {
  firstName: string;        // team member first name
  taskName: string;         // e.g. "Create Designs"
  customerName: string;     // e.g. "Sarah Lee"
  workspaceUrl: string;     // deep-link to /workspace (per-task URL TBD if available)
  instructions?: string | null;  // task.instructions for context
}
```

`src/lib/email/send.ts` extensions:

- `EmailTemplate` union: add `'task-assigned'`
- `subjects` map: `'New task in your queue: {taskName}'` — Resend doesn't template subjects, so it'll be set per-call as a string field, requiring a small refactor of how `subjects[template]` is consumed (either pass subject directly OR make subjects a function for this template).
- `TemplateDataMap` + `renderTemplate` switch case.

**Subject-line interpolation note:** the existing `subjects` map is static. Cleanest fix: change `subjects` for this template to a function `(data) => string`, or pass `subject` as an optional override on `sendEmail({ template, to, data, subject? })`. Subject override is less invasive.

### Fire points

1. **`src/lib/automations/activate-dependents.ts`** — two activation passes:
   - Same-stage activation (around line 99, inside the `for (const draft of productTasks)` loop)
   - New-stage activation (around line 339, inside the `for (const t of newStageTasks)` loop)

   Both: include `assigneeNotifiedAt: sql\`now()\`` in the race-guarded UPDATE alongside `status: 'Active'` and `activatedAt`, **only when the row has a non-null `assignedToTeamMemberId`**. After the UPDATE returns rows (winner), `void notifyTaskAssigned(taskId)`. Pre-stamping the column inside the UPDATE means a concurrent loser sees `assigneeNotifiedAt` already set and skips. Already inside a fire-and-forget context (the design-ready email next to it uses `void` too).

2. **`src/lib/automations/design-approval.ts`** — `handleDesignChangesRequested`:
   - At insert time, stamp `assigneeNotifiedAt: new Date()` on the Active `reviseTask`.
   - After the transaction commits, fire `void notifyTaskAssigned(reviseTask.id)` (only the active task; review + upload are Draft and will fire via Auto 2 when their deps clear).

3. **`src/lib/automations/generate-tasks.ts`** — defensive fire point:
   - Current workflow templates have only the Client intake task starting Active, but a future template row with `initial_status='Active'` on a Team task would silently skip notification under fire-point §1/§2.
   - After the transaction commits, for each created task where `status === 'Active'` AND `taskType === 'Team'` AND `assignedToTeamMemberId !== null`, fire `void notifyTaskAssigned(task.id)`.
   - Stamp `assigneeNotifiedAt` in the same insert when those conditions hold.

4. **`src/lib/db.ts` — `updateTaskFields`**:
   - If `fields.assignedToTeamMemberId` is being changed (set or cleared) AND post-update task status is `'Active'`:
     - Clear `assigneeNotifiedAt` in the same UPDATE (so the dedupe doesn't suppress a legitimate reassignment notification)
     - After commit, fire `void notifyTaskAssigned(taskId)`
   - Detection: read the task's existing `assignedToTeamMemberId` before the UPDATE (one extra SELECT keyed by PK) and compare to `fields.assignedToTeamMemberId`. Only act if changed and new value is non-null.

5. **`src/lib/db.ts` — `updateTaskStatus`** (defensive sibling):
   - Per CLAUDE.md, `updateTaskFields` and `updateTaskStatus` are sibling canonical paths. Current callers only set `'Completed'`, but the function accepts `'Active'`.
   - If `status === 'Active'`: include `assigneeNotifiedAt: sql\`now()\`` in the UPDATE (only if the task has an `assignedToTeamMemberId`), use a race-guarded `WHERE status != 'Active'` predicate, and fire `void notifyTaskAssigned(taskId)` only when the UPDATE returned rows.

6. **`src/app/api/workspace/design-review-reject/route.ts`** — direct task creation:
   - Around line 102, after the senior designer rejects and `createTask({ ..., status: 'Active', assignedToTeamMemberId: designerId })` returns, fire `void notifyTaskAssigned(created.id)`.
   - Stamp `assigneeNotifiedAt` on creation.
   - This route bypasses both `updateTaskFields` and `updateTaskStatus` — the architect flagged it as the missing fire-point.

### What does NOT get notified

- Customer (Client) tasks — those are the customer's queue, not internal.
- Draft tasks — by design, can't act yet.
- Tasks reassigned while still Draft — they'll notify when they activate.
- Self-claims — open question; see "Open questions" §1.
- Backfilled customers — suppressed per existing Phase 2 pattern.

## Architect review verdicts (2026-06-02)

All settled:

1. **Self-claim suppression:** Accept the noise — confirmation email is harmless; threading actor identity is over-engineering.
2. **Task URL:** Link to `/workspace/customers/{customerId}` (confirmed page exists).
3. **`updateTaskFields` reassignment detection:** Read-before-write inside `updateTaskFields`. Keeps business logic out of routes per CLAUDE.md.
4. **Migration safety:** Confirmed instant on Neon (nullable timestamp, no default, no backfill, no index).
5. **Race correctness:** Post-send stamp leaves a window where two concurrent winners both send. **Fix applied:** stamp `assigneeNotifiedAt` inside the same race-guarded UPDATE that flips to Active. Loser sees the column set and skips. Trade-off: failed Resend send leaves the timestamp stamped (acceptable — matches existing best-effort discipline; unsent < duplicate).
6. **Event log noise:** Keep the `'Assignee Notified'` events. Audit value > row count.
7. **Cross-cutting audit completed.** Architect caught 2 missing fire-points the original plan missed:
   - `src/app/api/workspace/design-review-reject/route.ts:102` — adds fire-point §6 above.
   - `src/lib/db.ts` `updateTaskStatus` — adds fire-point §5 above (defensive sibling of `updateTaskFields`).
   - Confirmed clean: Stripe automations, HubSpot intake push, Calendly webhook, handle-call-completed — none activate tasks outside the enumerated paths. Admin ad-hoc scripts (`reset-chris-design-loop.ts` etc.) use raw `db.update` and correctly stay outside the notification path (operator intent).

## Testing

- `npm run build` — type check the new files, union extension, schema column.
- `npm run db:migrate` — apply the new column locally.
- Manual smoke: create a test customer, complete intake form, confirm assigned Designer (`team_members` row) receives email and `tasks.assignee_notified_at` is set.
- Verify second activation (Designer uploads proof → Senior Designer notified) and dedupe (no re-notify on idempotent re-fire).
- Verify reassignment in `/workspace` clears the timestamp + re-notifies the new assignee.

## Rollout

- Single commit on `main` (per `feedback_work_on_main.md`).
- Test locally via `npm run dev` + manual flow exercise before push.
- Vercel auto-deploys.
- No flag — small feature, fail-closed (errors logged, never throw, customer flow unaffected).
