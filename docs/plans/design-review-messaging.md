# Design-Review In-Portal Correspondence

**Status:** planned, v1 not yet built
**Scope:** the D2C design review/approval flow (ProofTask ↔ workspace review area). Not a generic any-stage inbox — generalization is a future extension.

## Problem

During design review, customers often send an email or ask a question instead of cleanly
approving. Sometimes the team needs to reply / send a revision that has no new proof to
attach — just a message. Today the only forward actions are **Upload & Mark Complete** (team,
forces an attachment + advances the task) and **Request Changes → new round** (customer,
advances the workflow). There is no way for either side to just *say something or send a file
mid-round*, so the conversation escapes to email and lives outside LaunchPad.

## Decision (v1)

Let both sides **append a note + attachments to the existing design conversation mid-round,
without advancing the workflow**, and render the **full back-and-forth inline** inside the
review UI. One unified transcript — the Request-Changes feedback and the free-form
correspondence are the same list.

### Storage — extend `customers.designNotes` (no new table, no migration)

The design conversation already lives in `customers.designNotes` (jsonb array,
`{ from: 'designer'|'customer', note, uploadTask, at }`, `src/types/index.ts`,
`src/lib/design-notes.ts`), written today only at round boundaries
(`design-approval.ts`, `design-proof/route.ts`) and read only via `latestNoteFrom()`.

Add two optional keys to `DesignNote` (jsonb absorbs them — **no migration**):
- `attachments?: InternalNoteAttachment[]` (reuse `{ url, filename, size, contentType }`)
- `authorName?: string | null` (display denorm — team member name or customer name;
  `from` stays `designer|customer`)

New `src/lib/db.ts` helpers mirroring the internal-notes pattern:
- `getDesignThread(customerId)` → full `DesignNote[]` (attachments defaulted)
- `appendDesignNote({ customerId, from, body, uploadTask, attachments, authorName })`
  — single atomic `UPDATE customers SET design_notes = COALESCE(design_notes,'[]') || $entry`
  used by both sides; also refactor the three existing round-boundary writers onto it.

### Behavior / decoupling

Appending is a plain `UPDATE` on the jsonb column — it never goes through
`updateTaskStatus`/`updateTaskFields`, so it **cannot** fire Auto-2 (dependent activation /
stage advance). Approve / Request Changes are unchanged; the composer is a separate
affordance beside them. Team initiates (the trail starts when the designer sends a proof),
so the customer can never open it unprompted.

### UI — rendered in-context

- Customer: replace the single-note callouts in `src/components/tasks/ProofTask.tsx` with a
  full-trail `<DesignThread>` + composer.
- Team: replace the "Customer feedback" callout in
  `src/app/workspace/customers/[id]/page.tsx` (in `TaskActionRenderer`) with `<DesignThread>`
  + composer, above the review actions.
- `<DesignThread>` and the composer are cloned from the internal-notes
  `InternalNotesThread` / `AddInternalNoteButton` (paste-to-attach + direct-to-Blob upload).
- Portal re-fetch rides the existing `force-dynamic` + `TaskList` `router.refresh()` polling;
  thread the portal `token` down through `TaskList → ProofTask`.

### Routes / auth

- Customer reply: `POST /api/r/[token]/messages` — authorize via `getCustomerByToken(token)`
  (do NOT trust a bare customerId). Delegates to `src/lib/automations/design-message.ts`.
- Customer attachment sign: `POST /api/r/[token]/messages/sign` — token-authorized clone of
  `notes/sign` (existing sign routes require a session, so a portal-specific one is needed).
- Team send: `appendDesignMessageAction` server action (session-authorized), reuses the
  existing `/api/workspace/notes/sign` for team attachments.

### Notifications

- Team posts → customer email `new-message` (clone of `design-ready.tsx`), with a short
  truncated preview of the message body + portal CTA. Button label "Send Email".
- Customer replies → notify the **assignee of the active design task**
  (fallback: `customer.csmAssigned[0]`) via **email only** (`sendAlertEmail`, plaintext,
  delivered to the individual's address, sent from success@). Best-effort (log, don't throw).
- **No Slack ping** for design messages — deliberately dropped (2026-08-06). The shared
  Slack channel (`SLACK_WEBHOOK_URL` / `notifyCustomerSubmitted`) is reserved for the
  existing new-intake-submission alert; design correspondence would be too noisy there.

### Emails — "do not reply" stopgap (see Deferred below)

All customer-facing design emails get a clear line: **"Please don't reply to this email —
use your portal so nothing gets lost,"** with the portal button as the obvious path. This is
the cheap mitigation for customers who would otherwise reply by email; the real fix (inbound
capture) is deferred.

## Deferred / future — inbound email capture

**Deferred by product decision (keeps v1 scope tight).** The gap: LaunchPad emails send from
`success@rejig.ai`, so a customer who hits **Reply** ("approved!" / an attachment) lands in
the human `success@` mailbox, invisible to LP — the conversation escapes. The "do not reply"
line reduces but does not eliminate this.

Future fix — one-way **capture** (not email threading as a medium):
1. Put an encoded Reply-To on customer-facing design emails, e.g.
   `reply+<customer-token>@inbound.rejig.ai`.
2. Receive replies via an inbound webhook (confirm Resend inbound receiving via MX on a
   subdomain; fallback: Cloudflare Email Routing → webhook).
3. Decode token → find customer → append body + attachments (uploaded to Blob) to
   `designNotes` as a `from:'customer'` note → notify the team. **Identical downstream path**
   to a portal reply, so it lands in the same unified transcript.
4. Unmatched sender → fall through to `success@` (never silently drop). Filter
   auto-replies/OOO. Strip quoted history/signatures (best-effort).

Note: an emailed "approved" would land as a **note, not an auto-advance** (free-text intent
parsing is too fragile to trigger a workflow transition). This implies a companion
enhancement — a **"mark approved on behalf of the customer"** action in the workspace review
UI (does not exist today) — worth adding if email-approvals prove common.

## Related, out of scope

- The existing `POST /api/customers/[id]/design-approval` route authorizes by bare URL
  customerId with no token check — a pre-existing soft spot. New portal routes will authorize
  by `accessToken`; tightening the old route is a separate follow-up.
