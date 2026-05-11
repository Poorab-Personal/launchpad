# Plan: B2B Roster Integration (Delta Media Group)

**Status:** Draft, pending review
**v2 — applies architect review 2026-05-06**
**Author:** poorab@ + Claude
**Last updated:** 2026-05-06
**Reviewers wanted:** push back on architecture, schema, and the Postgres-vs-Airtable split.

---

## 0. Changes from v1

For future readers diffing this against v1:

- Live DMG refresh + Airtable writes moved off the magic-link click path. Live refresh now runs at email-lookup time (before the link is sent). Click path is just JWT verify → advisory lock → check `customer_record_id` → create-or-resume → redirect.
- Postgres advisory lock keyed on `(brokerage, user_id)` added around the create-Customer step to make concurrent clicks safe.
- Dropped `roster_sync_log` Postgres table. Sync history goes to Airtable Events as a new `Roster Synced` event type carrying `{brokerage, agents_total, agents_upserted, agents_soft_deleted, duration_ms}` in Details. `Brokerages.Last Roster Sync` remains the "did it run" signal.
- Cron is now a single data-driven handler (`/api/cron/sync-roster-all`) that pulls active brokerages from Airtable and fans out via `Promise.allSettled`. Adding brokerage #3 = config, not deploy.
- Magic-link TTL standardized to 15 minutes (matches existing `src/lib/auth/magic-link.ts`).
- Cross-email "send to public_email instead" UX dropped. We send the magic link to whichever email matched.
- Cross-brokerage hint dropped from the "not found" branch. Generic "we don't see you, contact support" message regardless. Internal log only for support routing.
- `account_type = 'agent'` filter applied at sync time. Office users and management never enter `roster_agents`.
- Roster table behavior change documented loudly with a callout, plus an explicit doc-update task list (schema doc, architecture doc, b2b-keyes/b2b-bw flow docs).
- Schema simplifications: dropped `office_phone`, `service_areas`, `office_state`, `office_city` from promoted columns (live in `dmg_data` only). Added `dmg_schema_version` and `first_seen_at`. UPSERT `ON CONFLICT` preserves a newer `last_synced_at` when the cron races a live refresh.
- Vercel Cron `Authorization: Bearer ${CRON_SECRET}` check is now specified as the literal first line of the cron handler.
- Error monitoring wired before launch via Resend email to `alerts@rejig.ai`.
- Preview environments use a sanitized dev-roster Neon project, not a branch from production.
- Channel exact-string verification added as a Phase 1 prerequisite (manual Airtable check).
- All seven Open Questions resolved inline (see §7).

---

## 1. Context

Two B2B brokerages (Keyes, Baird & Warner) onboard via a different app today: `rejig-ai/brokerage-onboarding-app`, a Google Apps Script + Sheets + Drive system that pulls agent data from Delta Media Group (DMG), verifies email, prefills a form, and emits to Zapier.

We are folding that flow into LaunchPad. The replacement must:

- Pull agent data from DMG for each brokerage.
- Verify an agent at the brokerage landing page (`/{slug}`).
- Pre-fill the onboarding form from roster data.
- Hand off to the customer portal (`/app/r/{token}`).
- Be cheap, fast, and reasonable to extend to a 3rd brokerage.

### URL structure (locked 2026-05-08)

Single subdomain — `onboarding.rejig.ai` — for everything. Brokerage landing slugs live at the root; everything LaunchPad owns lives under `/app/*` so brokerage slugs can never collide with internal routes.

```
Brokerage landings (root, must match live legacy URLs verbatim):
  onboarding.rejig.ai/keyes
  onboarding.rejig.ai/b&w
  onboarding.rejig.ai/ipre

Magic-link landing (per-brokerage, under the slug):
  onboarding.rejig.ai/{slug}/start?t={jwt}

Internal / app routes (under /app):
  onboarding.rejig.ai/app/r/{token}     ← customer portal (link in emails)
  onboarding.rejig.ai/app/admin
  onboarding.rejig.ai/app/workspace
  onboarding.rejig.ai/app/signin
  onboarding.rejig.ai/api/*              ← Vercel-reserved, stays at root
```

Note: existing LaunchPad routes today are `/r/[token]`, `/admin`, `/workspace`, `/signin` (no `/app` prefix). They have not been shared with any real customer yet, so the migration to `/app/*` is a one-time directory move with no redirects required. Sequencing into the rollout phases is open — see §8.

`b&w` is the literal slug — the legacy app's QR codes and brokerage internal links use `onboarding.rejig.ai/b&w` verbatim. Ampersand-in-path is unusual but valid; Next.js dynamic routes URL-decode it transparently.

The legacy app stays running in parallel until LaunchPad's B2B path is verified, then is sunset.

### Scale facts

- Each brokerage has **3,000+ agents**.
- DMG returns the entire roster in **one API response** (no pagination).
- DMG exposes a single-agent endpoint: `GET /users/{userId}/`. Confirmed via DMG API docs.
- Both brokerages use the **same DMG API** (`https://apis.deltagroup.com/v2`); only OAuth2 client credentials differ.

### Goals

1. Same-or-better data freshness as the legacy app.
2. ~Sub-second agent lookup at the landing page.
3. Resilient to DMG outages (signup must not be blocked by a transient DMG 5xx).
4. Internal team can run "nudge unboarded agents" campaigns (light, ad-hoc, sales-driven).
5. Adding brokerage #3 is a config change, not a code fork.

### Non-goals

- Two-way sync to DMG (we only read).
- Replacing Stripe / Calendly integrations (separate pieces).
- Migrating historical data from the legacy app's Google Sheets — those agents are already onboarded; nothing to migrate.

---

## 2. Architecture decision

Three storage options were considered for the bulk roster data:

| Option | Verdict | Reason |
|---|---|---|
| Airtable `Roster` table | Rejected for bulk | 6K–30K rows + 5 req/s base rate limit + slow `filterByFormula` lookups + sync writes hog the base. Internal team browse over 6K+ rows in Interface Designer is also bad UX. |
| Vercel KV (Upstash Redis) | Rejected | Email lookup is fast, but segmenting for nudge campaigns ("all Keyes agents who haven't onboarded") requires hand-rolled index sets. Coherence breaks silently. |
| **Vercel Postgres (Neon)** | **Chosen** | SQL segmenting for nudges, indexed email lookup, schema-flexible (JSONB for raw DMG payload), Vercel-native DX, scales to zero. Free tier covers our scale on Vercel Pro. |

### The durable principle (write this down)

> **Airtable holds workflow state we author. Postgres holds bulk reference data we sync from a third party. If a future integration brings 10K+ rows of read-mostly external data, the answer is a new Postgres table, not Airtable rows.**

This is the rule the next reader of the codebase will need. The Postgres dependency that this plan introduces will look strange to anyone steeped in CLAUDE.md's "Airtable is the system of record." It is. Postgres is for reference data we don't author. Airtable remains system of record for everything LaunchPad creates, mutates, or workflows over.

```
Postgres (Vercel)         Airtable                       DMG API
─────────────────         ────────                       ───────
roster_agents       ←──── (no link)                ←──── /users/  (full sync, daily)
                                                   ←──── /users/{id}  (live, on lookup)
                          Brokerages
                            ↓ link
                          Roster (only onboarded)
                            ↓ link
                          Customers, Tasks, Events
                          (workflow lives here)
```

---

## 3. Data model

### 3.1 New: Postgres schema

One table. Drizzle ORM, single migration. Sync history and operational telemetry live in Airtable Events (see §3.2) and Vercel logs.

```sql
CREATE TABLE roster_agents (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage           TEXT NOT NULL,            -- 'keyes' | 'baird-warner' (matches Brokerages.Landing Page Slug)
  user_id             TEXT NOT NULL,            -- DMG userId, stable identifier
  account_type        TEXT NOT NULL,            -- always 'agent'; non-agents are filtered at sync
  status              TEXT,                     -- DMG status (active/inactive)
  display_name        TEXT,
  first_name          TEXT,
  last_name           TEXT,
  public_email        TEXT,
  private_email       TEXT,
  cell_phone          TEXT,
  website             TEXT,
  license             TEXT,
  photo_url           TEXT,
  bio                 TEXT,
  mls_ids             TEXT,
  primary_office_id   TEXT,
  office_name         TEXT,                     -- promoted because nudge queries group by office (§4.3)
  dmg_data            JSONB NOT NULL,           -- raw DMG payload (incl. office_phone, service_areas, office_city, office_state, etc.)
  dmg_schema_version  TEXT,                     -- forward-compat: which DMG payload shape this row was synced under
  customer_record_id  TEXT,                     -- Airtable rec ID, set when Customer is created
  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),  -- first time we ever saw this user_id; survives soft-delete + reappearance
  last_synced_at      TIMESTAMPTZ NOT NULL,
  deleted_at          TIMESTAMPTZ,              -- soft-delete: agent no longer in DMG roster
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (brokerage, user_id)
);

CREATE INDEX idx_roster_agents_public_email_brokerage
  ON roster_agents (LOWER(public_email), brokerage)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_roster_agents_private_email_brokerage
  ON roster_agents (LOWER(private_email), brokerage)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_roster_agents_brokerage_unboarded
  ON roster_agents (brokerage)
  WHERE customer_record_id IS NULL AND deleted_at IS NULL;  -- nudge campaign queries
```

**Promotion rule.** A field is promoted to a column if and only if (a) we filter or sort by it in SQL, (b) we read it on the hot path more than once, or (c) it appears in the Customer field mapping in §3.3. Everything else lives in `dmg_data` only. Per this rule, `office_phone`, `service_areas`, `office_state`, `office_city` are NOT promoted — they're not queried and not in the Customer mapping. A typed TS helper reads them out of JSONB on the rare occasions they're needed.

**Notes:**
- `(brokerage, user_id)` is the natural key. We dedupe on `user_id` from DMG (stable across email changes).
- Both emails are indexed and lookup is case-insensitive (matches legacy behavior at `AgentLookup.gs:39`).
- `dmg_data` stores the full raw payload. Promoted columns are for indexing; everything else lives in JSONB so we don't have to schema-change every time DMG adds a field.
- `dmg_schema_version` lets us detect and migrate when DMG changes payload shape. Cheap to add now, expensive to bolt on later.
- `first_seen_at` is separate from `created_at` so that the "agents who joined the roster in the last N days" nudge query in §4.3 stays meaningful even after a soft-delete + reappearance cycle. `created_at` is when we first stored the row in this Postgres instance; `first_seen_at` is when we first saw this `(brokerage, user_id)` ever.
- Soft-delete (not hard-delete) so we have audit history if an agent is dropped from DMG mid-flow.

**UPSERT race rule.** The cron's `INSERT ... ON CONFLICT (brokerage, user_id) DO UPDATE` clause must:
- Preserve `customer_record_id` if it was already set (don't clobber the link to Airtable).
- Preserve `last_synced_at` if the existing value is newer than the cron's `sync_started_at`. With change #1 in v2 the live refresh moved to lookup time so this race is much smaller, but it doesn't disappear (a lookup mid-cron still races the cron's UPDATE).
- Preserve `first_seen_at` if it was already set (use `EXCLUDED.first_seen_at` only on INSERT).
- Clear `deleted_at` on conflict (re-appeared in roster).

### 3.2 Airtable additions

> **CALLOUT — Roster table semantics change.** The existing Airtable Roster table currently means "the bulk synced roster of all agents at a brokerage." After this work it means **"agents who have verified and started onboarding only."** Bulk roster moves to Postgres `roster_agents`. This is a one-line behavior change with several-doc consequences. The "Roster → Customer one-time copy" semantic is unchanged; what changes is when a Roster row exists at all (now: only on agent verification, not on cron sync).

**Brokerages table** — add three fields for the "we can't find you" failure screen:

| Field | Type | Purpose |
|---|---|---|
| `Support Contact Name` | Single line text | Shown to agents who fail email lookup |
| `Support Contact Email` | Email | Same |
| `Support Contact Phone` | Phone | Same |

**Brokerages.Roster API URL / Roster API Key / Roster Refresh Interval** — these are now misleading. The API URL is shared between brokerages and lives in code; credentials live in Vercel env vars; refresh interval is hardcoded daily. Two acceptable resolutions, pick during cutover:

1. Delete the three fields outright.
2. Keep them, rename to add a `(vestigial)` suffix, and add a schema-doc note explaining their status.

Either way, the schema doc must be updated (see "Doc-update tasks" below). `Brokerages.Last Roster Sync` is still written by the cron as the "did it run successfully" signal.

**Events table** — add a new value to the Event Type single-select: `Roster Synced`. Fired once per brokerage per cron run. `Customer` link is left blank (this is a system-level event, not customer-scoped). `Actor Type` = `System`. `Details` field carries JSON-stringified `{brokerage, agents_total, agents_upserted, agents_soft_deleted, duration_ms}`. On failure, `Details` instead carries `{brokerage, error: "...", duration_ms}` — see §6 for the email alert that fires alongside.

**Roster table** — no schema change. Behavior change as called out above. The existing "Roster → Customer one-time copy" semantics from `docs/schema/production-schema.md` lines 149–177 are unchanged once a Roster row exists.

#### Doc-update tasks (must ship with this rollout)

These are not "nice to haves." If the schema doc says Roster contains the bulk roster and the code says otherwise, the next agent reading either will write wrong queries. List of mandatory doc updates:

- `docs/schema/production-schema.md` Table 4: change Roster description to "agents who have verified and started onboarding only; bulk roster lives in Postgres `roster_agents`. Roster → Customer one-time copy semantics unchanged."
- `docs/schema/production-schema.md` Table 7: update Brokerages — note `Roster API URL` / `Roster API Key` / `Roster Refresh Interval` status (deleted or vestigial, per the choice above). Add the three new `Support Contact *` fields.
- `docs/schema/production-schema.md` Table 5: add `Roster Synced` to the Event Types list.
- `docs/schema/production-schema.md` "Enterprise Agent Onboarding Flow" section (lines 269–292): update entire flow to match the new lookup → magic link → click-path-creates-Customer flow.
- `docs/architecture.md`: same one-paragraph update on Roster semantics + Postgres principle from §2.
- `docs/flows/b2b-keyes.md` and `docs/flows/b2b-bw.md`: update entry-point flow from "6-digit verification code" to "magic link." These are tagged `VETTED, SOURCE OF TRUTH` in their headers — call out in the PR description that they become inconsistent the moment this rolls out and must update in the same change.

### 3.3 Customer creation field mapping

When an agent verifies and we create a Customer record (Airtable), we copy from the Postgres `roster_agents` row:

| Customer field | Postgres source | Notes |
|---|---|---|
| Name | `display_name` | |
| Type | (literal) `"B2B"` | |
| Channel | brokerage Channel value | **Verify exact string in Airtable before coding** — see Phase 3 cutover prereqs. Per current schema doc: Keyes = `"Keyes"`, B&W = `"BW"` (not `"Baird & Warner"`). |
| Contact Email | the email the agent verified with | Whichever of `public_email` / `private_email` matched at lookup. Carried through the JWT payload. |
| Phone | `cell_phone` | |
| Website | `website` | |
| Bio | `bio` | |
| License Number | `license` | |
| MLS IDs | `mls_ids` | |
| Brokerage | link to Brokerages record by slug | |
| Roster Record | link to newly-created Airtable Roster row | The Airtable Roster row is created in the same atomic step |

The Airtable Roster row gets the same fields plus `Onboarding Status = "In Progress"` and `Customer Record` link.

---

## 4. Flows

### 4.1 Periodic sync (Vercel Cron, data-driven)

A single cron entry, not one per brokerage. The handler reads active brokerages from Airtable and fans out at runtime, so adding brokerage #3 = add a row in Airtable + add env vars for credentials. No deploy.

```
Vercel Cron (one entry, daily at 06:00 UTC)
  ↓
GET /api/cron/sync-roster-all
  ↓ (FIRST LINE: verify Authorization: Bearer ${CRON_SECRET}, else 401)
  1. Query Airtable Brokerages where Active = true AND Roster API URL is set
       (the URL field's presence is the "syncs from DMG" signal — even though
        the actual URL lives in code, the field's set/unset state is the toggle.)
  2. For each brokerage, in parallel via Promise.allSettled, run syncBrokerage(slug):
       a. const sync_started_at = now()
       b. Resolve DMG credentials from Vercel env (DMG_{BROKERAGE}_CLIENT_ID/SECRET)
       c. OAuth2 client_credentials → access_token
       d. GET /users/  → all users
       e. GET /users/offices/ → join office data in memory
       f. Filter to account_type = 'agent' AND status = 'active'  -- excludes office users + management
       g. UPSERT each agent into roster_agents (by brokerage, user_id):
            - SET all promoted columns
            - SET dmg_data = raw payload
            - SET dmg_schema_version = current constant
            - SET last_synced_at = GREATEST(existing.last_synced_at, sync_started_at)
            - Preserve customer_record_id (don't overwrite if set)
            - Preserve first_seen_at (only set on INSERT, never UPDATE)
            - Clear deleted_at if previously soft-deleted (re-appeared in roster)
       h. Soft-delete agents missing from this fetch:
            UPDATE roster_agents
               SET deleted_at = now()
             WHERE brokerage = $1
               AND last_synced_at < $2  -- sync_started_at
               AND deleted_at IS NULL
       i. Update Airtable Brokerages.Last Roster Sync = now()
       j. Create Airtable Events row { Event Type: 'Roster Synced',
            Actor Type: 'System',
            Details: JSON of {brokerage, agents_total, agents_upserted,
                              agents_soft_deleted, duration_ms} }
  3. Aggregate results; if any brokerage failed, send a Resend email to alerts@rejig.ai
     with the brokerage(s) and stack trace(s). Return 200 with JSON summary.
```

**Schedule** (`vercel.json`):
```json
{
  "crons": [
    { "path": "/api/cron/sync-roster-all", "schedule": "0 6 * * *" }
  ]
}
```

Daily at 06:00 UTC (around 1–2am US Eastern). `Promise.allSettled` ensures one brokerage's DMG outage doesn't block another's sync. Stagger inside the loop with a short delay (1–2s between starts) if DMG cares about per-account concurrency from our IP — we'll learn the answer empirically and tune.

**Function timeout:** 60s on Vercel Pro is enough — 3K rows of upserts via batched `INSERT ... ON CONFLICT` complete in <10s on Neon. Two brokerages parallel = under 30s wall clock.

**Failure handling:** any brokerage's promise rejection is caught by `allSettled`. The handler emails `alerts@rejig.ai` with the details and returns 200 (so Vercel doesn't auto-retry — we want to see the failure on tomorrow's run, not hammer DMG). If freshness becomes critical, we can add a manual retry endpoint or more frequent crons later.

**No `roster_sync_log` table.** Per-row counts and durations live in the `Roster Synced` Events row (queryable in Airtable Interface Designer alongside everything else). Per-row debugging info ("which row failed at index 1432") lives in Vercel logs, which is the right place for that level of detail.

### 4.2 Agent verification + signup

The change from v1: the live DMG refresh and all Airtable writes move OFF the click path. Live refresh runs at lookup time (before the magic link is sent). The click path is just JWT-verify → advisory lock → check-or-create → redirect. Three round trips at most, all internal except the Airtable creates.

```
=== STAGE 1: Lookup (POST /api/agent-lookup) ===

Agent visits /keyes
  ↓ (server component)
  Fetch Brokerages record by slug → render landing page (logo, copy, support contact)
  ↓
Agent enters email → POST /api/agent-lookup { email, slug }
  ↓
  SELECT * FROM roster_agents
   WHERE brokerage = 'keyes'
     AND deleted_at IS NULL
     AND (LOWER(public_email) = $1 OR LOWER(private_email) = $1)
   LIMIT 1
  ↓
  ┌─ no match in this brokerage ──────────────────────────┐
  │  Look up the same email globally (no brokerage        │
  │  filter). If found in another brokerage: log to       │
  │  Vercel logs ("cross-brokerage lookup attempt: email  │
  │   X tried slug Y but exists in slug Z") for support   │
  │  routing. DO NOT surface this in the UI.              │
  │                                                       │
  │  Render the standard generic message regardless:      │
  │  "We don't see you in this brokerage's roster.        │
  │   Some agents are registered with a secondary email   │
  │   — check with your broker. Contact:                  │
  │   {Brokerage.Support Contact}"                        │
  │                                                       │
  │  Returns 200 (don't leak via status code either).     │
  └───────────────────────────────────────────────────────┘
  ┌─ match found (on either email) ───────────────────────┐
  │  matched_email = whichever of public_email or         │
  │                  private_email matched the input      │
  │                                                       │
  │  Live refresh from DMG: GET /users/{user_id}/         │
  │    ├─ success: UPDATE promoted columns + dmg_data +   │
  │    │           last_synced_at = now()                 │
  │    └─ 5xx / timeout (3s): log warning, proceed        │
  │                            with cached row            │
  │                                                       │
  │  Sign JWT { agent_id, brokerage, matched_email,       │
  │              iat, exp: now+15min }                    │
  │  HS256, SESSION_SECRET (reuses existing key var).     │
  │                                                       │
  │  Send magic link via Resend to matched_email:         │
  │    https://onboarding.rejig.ai/{slug}/start?t={jwt}   │
  │                                                       │
  │  Render "check your email at {matched_email}" page.   │
  │  (Showing the matched email back is fine — user just  │
  │   typed it. No enumeration risk.)                     │
  └───────────────────────────────────────────────────────┘

=== STAGE 2: Click (GET /{slug}/start?t={jwt}) ===

Agent clicks magic link → GET /keyes/start?t={jwt}
  ↓ (server component)
  Verify JWT signature + expiry (15 min)
    invalid/expired → render "link expired, request a new one" + back to /keyes
  ↓
  BEGIN postgres transaction
    SELECT pg_advisory_xact_lock(hashtext($brokerage || ':' || $user_id))
    ↓
    SELECT customer_record_id FROM roster_agents WHERE id = $jwt.agent_id
    ↓
    ┌─ customer_record_id IS NOT NULL (resume) ─────────┐
    │  COMMIT (releases lock)                            │
    │  Redirect to /app/r/{customer_record_id}           │
    └────────────────────────────────────────────────────┘
    ┌─ customer_record_id IS NULL (first click) ────────┐
    │  1. Re-SELECT full roster_agents row for field    │
    │     mapping (already locked).                      │
    │  2. Create Airtable Roster row                     │
    │     (copy from Postgres; Contact Email =           │
    │      jwt.matched_email).                           │
    │  3. Create Airtable Customer row (§3.3 mapping)    │
    │     with Roster Record link, Brokerage link,       │
    │     Channel = brokerage Channel value, Type='B2B'  │
    │     → Airtable Auto 1 generates tasks              │
    │  4. UPDATE roster_agents SET customer_record_id =  │
    │       <new Airtable rec ID> WHERE id = $1          │
    │  5. COMMIT (releases lock)                         │
    │  6. Redirect to /app/r/{customer_record_id}        │
    └────────────────────────────────────────────────────┘
  
  If steps 2–4 throw after Roster create succeeds but before
  customer_record_id UPDATE: log the orphaned Airtable rec ID
  to Vercel logs and send an alerts@rejig.ai email so a human
  can clean up. Do NOT retry inside the lock — release and let
  the next click handle it (which it can't, because Postgres
  customer_record_id is still NULL → it'll create a duplicate).
  Manual cleanup is the right tradeoff vs writing a saga here.
```

**Why move live refresh to lookup time (Option B from the review).** The click path is now race-free, fast, and has one external write (Airtable). The user perceives DMG latency as "we're checking our records" on the lookup page, which is the right mental model. If DMG is slow at lookup, the agent waits 3s for the magic-link email to send instead of waiting 3s after clicking the link.

**Magic link, not 6-digit code.** We already built magic-link auth for `/workspace` (commit `86b3b8e`). Reusing the pattern is cheaper than a new code-entry screen, and the UX is one click vs typing 6 digits. Identity is proven by email ownership either way.

**JWT, not DB-stored token.** Stateless. Payload `{ agent_id, brokerage, matched_email, iat, exp }`, HS256 signed with `SESSION_SECRET` (same key as `magic-link.ts`). 15-min expiry **(standardized to match the existing `MAGIC_LINK_TTL_MINUTES = 15` in `src/lib/auth/magic-link.ts`)**. Re-clicks within window are idempotent: the advisory lock serializes them, and the `customer_record_id` check makes duplicate attempts return the existing Customer.

**Different from the existing magic-link helper.** The agent verification flow does NOT issue a session cookie. The existing magic link redirects to `/app/workspace` with a session — the agent flow performs a one-shot side effect (create Customer) and redirects to the customer portal at `/app/r/{token}`. Implementer must NOT call `setSessionCookie` on the agent. We'll either (a) extend `magic-link.ts` with a second `subject: 'agent-verification'` tagged variant, or (b) write a sibling `agent-magic-link.ts` that reuses the JWT helpers but no session code. Lean (a) for less code duplication.

**Postgres advisory lock.** `pg_advisory_xact_lock(hashtext(brokerage || ':' || user_id))` is per-transaction (auto-released on COMMIT/ROLLBACK), zero-config, and exactly suited for "serialize concurrent writes for one entity." Two browsers clicking the same link at T=0 will execute serially: the second waits for the first's COMMIT, then SELECTs the now-set `customer_record_id` and redirects to the existing portal. No duplicate Customer rows, no double Auto-1 fan-out.

**Cross-email "send instead" UX dropped.** Match on either `public_email` or `private_email`; send the magic link to whichever email matched. `Customer.Contact Email = the email the agent verified with`. This eliminates the email-masking screen entirely and closes the email-enumeration leak (no PII signal that "this personal email belongs to a Keyes agent named Jane Smith").

**Cross-brokerage hint dropped.** Same generic "we don't see you" message regardless of whether the email exists in another brokerage. Internal Vercel-logs entry on cross-brokerage match for support routing. This closes the org-relationship enumeration leak — relevant once we have 3+ brokerages.

### 4.3 Nudge campaign queries (sales workflow)

These are ad-hoc SQL run by sales via Neon's web SQL console, not built-in features. Examples:

```sql
-- "Email unboarded Keyes agents who joined the roster in the last 60 days"
-- (uses first_seen_at, not created_at, so soft-delete + reappearance doesn't skew this)
SELECT public_email, display_name, license
FROM roster_agents
WHERE brokerage = 'keyes'
  AND customer_record_id IS NULL
  AND deleted_at IS NULL
  AND first_seen_at > now() - interval '60 days';

-- "Show me top 100 unboarded B&W agents by office"
SELECT office_name, count(*) AS unboarded_count
FROM roster_agents
WHERE brokerage = 'baird-warner'
  AND customer_record_id IS NULL
  AND deleted_at IS NULL
GROUP BY office_name
ORDER BY unboarded_count DESC
LIMIT 100;
```

A `/admin/roster` page with canned filters is punted until sales asks (Open Q5 resolved).

---

## 5. Code structure

```
src/
  lib/
    dmg.ts                   -- shared DMG client. OAuth2, fetchAllUsers, fetchAllOffices, fetchUser
                                Reads creds from env by brokerage slug.
    roster/
      db.ts                  -- Drizzle schema for roster_agents
      sync.ts                -- syncBrokerage(slug): orchestrates sync flow (4.1)
                                runAllActiveSyncs(): reads Brokerages, Promise.allSettled fan-out
      lookup.ts              -- lookupByEmail(brokerage, email): returns matched row + matched_email
                                refreshAgent(userId): live DMG + upsert (called from lookup endpoint)
      create-customer.ts     -- createCustomerFromAgent(agentId, matchedEmail): runs inside the
                                advisory-lock transaction; creates Airtable Roster + Customer.
    magic-link.ts            -- (existing) extend with subject: 'agent-verification' variant
                                OR add agent-magic-link.ts sibling
  types/
    dmg.ts                   -- DMGUser, DMGOffice, DMGUsersResponse types
  app/
    [slug]/                  -- brokerage landings live at root: /keyes, /b&w, /ipre
      page.tsx               -- landing page (server component, fetches Brokerages record by slug)
      EmailForm.tsx          -- client component, posts to /api/agent-lookup
      start/
        page.tsx             -- magic-link landing: verify JWT, advisory lock, create-or-resume
                                redirects to /app/r/{customer_record_id}
    app/                     -- everything LaunchPad-internal moves under /app/* (Phase 1 migration)
      r/[token]/page.tsx     -- customer portal (was /r/[token])
      admin/                 -- (was /admin)
      workspace/             -- (was /workspace)
      signin/                -- (was /signin)
    api/
      agent-lookup/
        route.ts             -- POST: lookup + (live refresh) + send magic link via Resend
      cron/
        sync-roster-all/
          route.ts           -- GET: verify Authorization Bearer CRON_SECRET (FIRST LINE),
                                run runAllActiveSyncs(), email alerts on failure

drizzle/
  migrations/
    0001_roster_agents.sql   -- generated by drizzle-kit
drizzle.config.ts

vercel.json                  -- single cron entry: /api/cron/sync-roster-all
```

### Key library choices

- **Drizzle ORM** over Prisma: lighter, no codegen step, serverless-friendly (no engine binary), simpler migrations. Architect approved.
- **`@neondatabase/serverless`** as the driver: HTTP-based, no connection pooling needed for serverless functions. (Vercel Postgres = Neon.)
- **`jose`** for JWT — already used by `src/lib/auth/magic-link.ts`. Reuse.

### Next.js 16 note (per AGENTS.md)

This project is on Next.js 16, not 14/15. Before writing any route handler or server component code, the implementer must consult `node_modules/next/dist/docs/` for the current App Router conventions. Do not assume training-data familiarity with Next.js APIs.

---

## 6. Environment & infrastructure

### 6.1 New env vars

```
# Vercel Postgres (auto-set when DB is added to project)
POSTGRES_URL=...
POSTGRES_URL_NON_POOLING=...

# DMG credentials (per brokerage)
DMG_KEYES_CLIENT_ID=...
DMG_KEYES_CLIENT_SECRET=...
DMG_BAIRD_WARNER_CLIENT_ID=...
DMG_BAIRD_WARNER_CLIENT_SECRET=...

# Magic-link signing — REUSE existing SESSION_SECRET (already used by src/lib/auth/magic-link.ts)
SESSION_SECRET=...

# Cron auth — set this manually in Vercel; Vercel sets the Authorization
# header from it on cron-triggered invocations.
CRON_SECRET=...

# Error alerts (existing Resend setup)
ALERTS_EMAIL=alerts@rejig.ai
```

**On `CRON_SECRET`:** confirmed by spot-check that this repo has no existing cron handler and no current `vercel.json` — there's no auto-magic to inherit. Per current Vercel docs, `CRON_SECRET` is an env var YOU set; Vercel then includes it as the `Authorization: Bearer ${CRON_SECRET}` header on cron-triggered requests to the cron route. The handler must verify it. Do not rely on a `x-vercel-cron` header — the explicit Bearer check is what we want.

### 6.2 Vercel Cron auth — literal first line of the handler

The cron handler's first executable line must be the auth check, before any DB query, env read, or import side effect:

```ts
// /api/cron/sync-roster-all/route.ts
export async function GET(request: Request) {
  if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }
  // ... rest of handler
}
```

Without this, the cron endpoint is publicly callable and anyone can DoS the DMG API by hitting `/api/cron/sync-roster-all` repeatedly.

### 6.3 Error monitoring — wired before launch

Sentry is not in this project (verified — not in package.json). The cheap path:

```
on cron failure (any brokerage):
  await resend.emails.send({
    from: 'launchpad@rejig.ai',
    to: process.env.ALERTS_EMAIL,
    subject: `[LaunchPad] Roster sync failed: ${brokerage}`,
    text: `Brokerage: ${brokerage}\nError: ${err.message}\n\nStack:\n${err.stack}`,
  });
```

About 20 lines including the wrapper. **This must ship in the same Phase 2 PR as the cron handler — do not enable the cron without the alert wired.** A silent cron failure for two days kills agent freshness without anyone noticing.

The same alert path is reused by the click handler if the create-Customer transaction half-succeeds (Roster row created but `customer_record_id` not set in Postgres) — see §4.2 closing note.

### 6.4 Vercel infra checklist

- [ ] Vercel Pro plan (cron, longer function timeouts, KV/Postgres free tiers)
- [ ] Vercel Postgres (Neon) added to project — provisions connection strings
- [ ] `vercel.json` with single cron entry: `/api/cron/sync-roster-all` daily at 06:00 UTC
- [ ] `CRON_SECRET` set as env var in Vercel (Production + Preview)
- [ ] DMG creds set as env vars in Vercel (Production + Preview separately — Preview points at sandbox if DMG provides one)
- [ ] `ALERTS_EMAIL` set as env var
- [ ] Resend already configured (commit `5346cae`) — reuse for magic-link sends + cron alerts
- [ ] Preview environments: branch from a **sanitized dev-roster Neon project**, not from production. Preview deployments must NOT see real agent PII via the Postgres branch. The Vercel-Neon integration normally branches from the production DB by default — change the integration setting to point at the dev-roster project as the source.

### 6.5 Cost estimate

Both Postgres and KV options were within free tier on Vercel Pro. Postgres usage:

- Storage: ~30 MB at 2 brokerages × 3K agents (well under 256 MB free).
- Compute: Neon scales to zero when idle. Daily 60s cron + occasional lookups = a few minutes/day. Free tier is 60 compute-hours/month.

Net additional monthly cost beyond existing Vercel Pro: **$0** at current scale.

---

## 7. Open questions — resolved

All seven v1 open questions are resolved here per the architect's review.

**1. DMG offices: separate table or inline?** **Resolved: ship flat.** Office data is small, changes rarely, and the join is on the hot path. Revisit if office count exceeds 1,000 across all brokerages. We promote `office_name` only (used in nudge group-by); other office fields live in `dmg_data`.

**2. "Channel" exact string.** **Resolved: verify in Airtable as a Phase 1 prerequisite.** Per current schema doc: `Customer.Channel = "Keyes"` produces Workflow Key `B2B-Keyes`; for B&W, Channel = `"BW"` produces `B2B-BW`. Confirm verbatim in the live Airtable base before coding the create-Customer step. Added as a checklist item in Phase 3 cutover prereqs.

**3. Magic link single-use enforcement.** **Resolved: reframed.** The right question is concurrency safety, not single-use. The Postgres advisory lock + `customer_record_id` check makes concurrent clicks safe AND preserves re-clickable-within-TTL behavior. No `used_at` column needed. Re-clicks land on the same Customer (idempotent).

**4. Account types beyond `agent`.** **Resolved: filter at sync time.** Only `account_type = 'agent'` rows enter `roster_agents`. Office users and management never get a magic link, never get a Customer record, never get 13 inappropriate B2B-Keyes tasks. If management ever needs to onboard, that's a separate workflow with its own template.

**5. Sales nudge UI.** **Resolved: punt.** Neon SQL console is fine until sales asks. No `/admin/roster` page in this rollout.

**6. Sunset of legacy app.** **Resolved.** 2-week parallel run after LaunchPad B2B launch, redirect legacy URL → new URL, archive `rejig-ai/brokerage-onboarding-app`. Phase 1 includes a row-count parity check against the legacy Sheet before cutover.

**7. Error monitoring.** **Resolved.** Resend email to `alerts@rejig.ai` from cron handler on any brokerage failure, and from click handler on partial-Customer-create failure. Wired in the same PR as the cron — see §6.3.

---

## 8. Rollout plan

Phased so each step is reversible. The legacy app keeps working at every phase.

**Phase 1 — Foundation (no user-facing change)**
1. Add Vercel Postgres to project; set env vars.
2. Add Drizzle, write migration, push to DB.
3. Implement `src/lib/dmg.ts` with both Keyes + B&W credentials.
4. Manual sync script (`npx tsx scripts/sync-roster.ts keyes`) — verifies DMG creds work and the upsert logic is correct.
5. Verify row counts match what legacy app's Sheet has (parity check before cutover).
6. **Confirm `Customer.Channel` exact string in Airtable for both brokerages** (resolves Open Q2). Don't code the create-Customer step until this is recorded in this doc.

**Phase 2 — Cron**
1. Add `/api/cron/sync-roster-all` route with `Authorization: Bearer ${CRON_SECRET}` as the literal first line.
2. Add `vercel.json` with the single cron entry.
3. Add the Resend `alerts@rejig.ai` failure-email path **in the same PR** as the cron handler.
4. Add `Roster Synced` to the Airtable Events single-select before deploy.
5. Deploy to staging branch first; verify CRON_SECRET enforcement (curl the endpoint without the header → 401).
6. Watch Airtable Events for 3 consecutive successful daily `Roster Synced` rows before promoting.

**Phase 3 — Lookup + landing (cutover prereqs)**
1. Add Brokerages support-contact fields in Airtable.
2. Decide and execute the `Brokerages.Roster API URL` / `Roster API Key` / `Roster Refresh Interval` cleanup (delete vs rename — see Decisions for Poorab below).
3. Update `docs/schema/production-schema.md`, `docs/architecture.md`, `docs/flows/b2b-keyes.md`, `docs/flows/b2b-bw.md` per the doc-update task list in §3.2. Same PR.
4. Build `/[slug]` landing page + `/api/agent-lookup` (lookup runs the live DMG refresh).
5. Build `/[slug]/start` magic-link handler (advisory-lock create-or-resume).
6. Test end-to-end with a single test agent in DMG sandbox (or ourselves added to the roster).
7. Confirm Postgres advisory lock works under concurrent click test (two curls in parallel → exactly one Customer row).

**Phase 4 — Cutover**
1. Update Brokerages records: `Landing Page Slug` confirmed (`keyes`, `baird-warner`).
2. Soft-launch: send the new URL to one or two real Keyes agents; observe.
3. Update legacy app to display "we've moved → new URL" banner.
4. Two weeks later: redirect legacy URL → new URL.
5. Archive `rejig-ai/brokerage-onboarding-app`.

**Reversibility:** at each phase the legacy app keeps working. Worst case at Phase 4 we point real agents back at the legacy URL.

---

## 9. Out of scope

Things that touch this work but are separate efforts:

- **Stripe trial flow for Keyes** (legacy `StripeHandler.gs`) — separate plan (`docs/plans/payment-mode-dropoff.md`).
- **Calendly URL per brokerage** — already a Brokerages-table concern, separate.
- **B2B intake-form fields beyond what DMG returns** — handled by existing `FormTask.tsx` once Customer is created.
- **Photo / logo uploads** — DMG provides URLs; if/when agents want to upload their own, the existing `FileUploadTask.tsx` flow handles it post-customer-creation.
- **Two-way sync (writing back to DMG)** — explicit non-goal.
- **`/admin/roster` UI for sales** — punted until requested.
- **Sentry / structured error monitoring** — using Resend-to-`alerts@rejig.ai` for now; revisit if/when we have multiple integrations needing observability.

---

## 10. Decisions — locked 2026-05-06

Both v2-flagged items resolved by Poorab:

1. **`Brokerages.Roster API URL` / `Roster API Key` / `Roster Refresh Interval` → DELETE.** Credentials live in Vercel env vars; the URL is shared/in-code; refresh interval is hardcoded daily. Airtable revision history preserves the audit trail. Delete in Phase 3 cutover (alongside the schema-doc updates).

2. **Magic-link variant for agent verification → EXTEND `magic-link.ts` with a second `subject` tag.** Reuses JWT helpers without duplicating signing/verification logic. The agent path skips `setSessionCookie`; the workspace path keeps it.

Everything else is committed.

---

## 11. Summary

Build a Vercel-native DMG roster integration: Postgres for the bulk lookup table, daily Vercel Cron (single data-driven handler) for full sync, single-agent DMG endpoint for live refresh at lookup time (NOT click time), 15-minute magic link for verification, advisory-locked Airtable handoff at click time. Adds zero new monthly cost at current scale. Preserves Airtable-first architecture for everything LaunchPad already does, with the explicit principle that Postgres holds bulk reference data we sync from third parties and Airtable holds workflow state we author.
