# Plan: B2B Roster Integration (Delta Media Group)

**Status:** Draft, pending review
**Author:** poorab@ + Claude
**Last updated:** 2026-05-06
**Reviewers wanted:** push back on architecture, schema, and the Postgres-vs-Airtable split.

---

## 1. Context

Two B2B brokerages (Keyes, Baird & Warner) onboard via a different app today: `rejig-ai/brokerage-onboarding-app`, a Google Apps Script + Sheets + Drive system that pulls agent data from Delta Media Group (DMG), verifies email, prefills a form, and emits to Zapier.

We are folding that flow into LaunchPad. The replacement must:

- Pull agent data from DMG for each brokerage.
- Verify an agent at the brokerage landing page (`/b/{slug}`).
- Pre-fill the onboarding form from roster data.
- Hand off to the existing customer portal (`/r/{token}`).
- Be cheap, fast, and reasonable to extend to a 3rd brokerage.

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

**The principle:** Airtable stays the system of record for **workflow state** (Customers, Tasks, Events). Postgres holds **bulk reference data** (the full roster). Airtable's `Roster` table only ever gets a row when an agent **actually starts onboarding** — so it stays small (hundreds, not tens of thousands) and the existing "Roster → Customer one-time copy" semantic is preserved.

This keeps CLAUDE.md's Airtable-first architecture intact: business logic and workflow state are still 100% in Airtable. Postgres is a pure cache for the lookup table.

```
Postgres (Vercel)         Airtable                       DMG API
─────────────────         ────────                       ───────
roster_agents       ←──── (no link)                ←──── /users/  (full sync, daily)
                                                   ←──── /users/{id}  (live, on signup)
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

Two tables. Drizzle ORM, single migration.

```sql
CREATE TABLE roster_agents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage       TEXT NOT NULL,                -- 'keyes' | 'baird-warner' (matches Brokerages.Landing Page Slug)
  user_id         TEXT NOT NULL,                -- DMG userId, stable identifier
  account_type    TEXT,                         -- 'agent' | 'office user' | 'management'
  status          TEXT,                         -- DMG status (active/inactive)
  display_name    TEXT,
  first_name      TEXT,
  last_name       TEXT,
  public_email    TEXT,
  private_email   TEXT,
  cell_phone      TEXT,
  office_phone    TEXT,
  website         TEXT,
  license         TEXT,
  photo_url       TEXT,
  bio             TEXT,
  mls_ids         TEXT,
  primary_office_id TEXT,
  office_name     TEXT,
  office_city     TEXT,
  office_state    TEXT,
  service_areas   TEXT,
  dmg_data        JSONB NOT NULL,               -- raw DMG payload, full fidelity
  customer_record_id TEXT,                      -- Airtable rec ID, set when Customer is created
  last_synced_at  TIMESTAMPTZ NOT NULL,
  deleted_at      TIMESTAMPTZ,                  -- soft-delete: agent no longer in DMG roster
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
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

CREATE TABLE roster_sync_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage     TEXT NOT NULL,
  started_at    TIMESTAMPTZ NOT NULL,
  finished_at   TIMESTAMPTZ,
  agents_total  INTEGER,
  agents_upserted INTEGER,
  agents_soft_deleted INTEGER,
  status        TEXT NOT NULL,                  -- 'running' | 'success' | 'failed'
  error_message TEXT
);
```

**Notes:**
- `(brokerage, user_id)` is the natural key. We dedupe on `user_id` from DMG (stable across email changes).
- Both emails are indexed and lookup is case-insensitive (matches legacy behavior at `AgentLookup.gs:39`).
- `dmg_data` stores the full raw payload. Promoted columns are for indexing; everything else lives in JSONB so we don't have to schema-change every time DMG adds a field.
- Soft-delete (not hard-delete) so we have audit history if an agent is dropped from DMG mid-flow.

### 3.2 Airtable additions

**Brokerages table** — add three fields for the "we can't find you" failure screen:

| Field | Type | Purpose |
|---|---|---|
| `Support Contact Name` | Single line text | Shown to agents who fail email lookup |
| `Support Contact Email` | Email | Same |
| `Support Contact Phone` | Phone | Same |

(Existing `Roster API URL` / `Roster API Key` / `Roster Refresh Interval` / `Last Roster Sync` fields are kept but only `Last Roster Sync` is written to from this flow — the actual API endpoint lives in code since both brokerages use the same one. Credentials live in Vercel env vars, not Airtable.)

**Roster table** — no schema change. Behavior change: rows are only created at the moment an agent verifies, not by a periodic sync. The existing "Roster → Customer one-time copy" semantics are unchanged from `docs/schema/production-schema.md` lines 149–177.

### 3.3 Customer creation field mapping

When an agent verifies and we create a Customer record (Airtable), we copy from the Postgres `roster_agents` row:

| Customer field | Postgres source | Notes |
|---|---|---|
| Name | `display_name` | |
| Type | (literal) `"B2B"` | |
| Channel | brokerage name | e.g., `"Keyes"` — matches the channel value in workflow templates |
| Contact Email | `public_email` | Or whichever email the agent verified with |
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

### 4.1 Periodic sync (Vercel Cron)

```
Vercel Cron (per-brokerage entry, staggered)
  ↓
GET /api/cron/sync-roster/[brokerage]
  ↓ (verify Vercel cron secret header)
  1. Insert roster_sync_log row, status='running'
  2. Resolve DMG credentials from Vercel env (DMG_{BROKERAGE}_CLIENT_ID/SECRET)
  3. OAuth2 client_credentials → access_token
  4. GET /users/  → all users (agent/office user/management)
  5. GET /users/offices/ → join office data in memory
  6. Filter by SYNC.INCLUDE_INACTIVE = false (matches legacy)
  7. UPSERT each agent into roster_agents (by brokerage, user_id):
       - SET all promoted columns
       - SET dmg_data = raw payload
       - SET last_synced_at = sync_started_at
       - Preserve customer_record_id (don't overwrite)
       - Clear deleted_at if previously soft-deleted (re-appeared in roster)
  8. Soft-delete agents missing from this fetch:
       UPDATE roster_agents
          SET deleted_at = now()
        WHERE brokerage = $1
          AND last_synced_at < $2  -- sync_started_at
          AND deleted_at IS NULL
  9. Update roster_sync_log row: status='success', counts
  10. Update Brokerages.Last Roster Sync in Airtable
```

**Schedule** (`vercel.json`):
```json
{
  "crons": [
    { "path": "/api/cron/sync-roster/keyes",         "schedule": "0 6 * * *" },
    { "path": "/api/cron/sync-roster/baird-warner",  "schedule": "30 6 * * *" }
  ]
}
```
Daily at 06:00 / 06:30 UTC (around 1–2am US Eastern). Staggered so a DMG outage during one doesn't take both down.

**Function timeout:** 60s on Vercel Pro is enough — 3K rows of upserts via batched `INSERT ... ON CONFLICT` complete in <10s on Neon.

**Failure handling:** if any step throws, log to `roster_sync_log` with `status='failed'` + error, return 500. Vercel Cron does not auto-retry; we'll get the next day's run. If freshness becomes critical, we can add manual retry endpoint or more frequent crons later.

### 4.2 Agent verification + signup

```
Agent visits /b/keyes
  ↓ (server component)
  Fetch Brokerages record by slug → render landing page (logo, copy, support contact)
  ↓
Agent enters email → POST /api/agent-lookup
  ↓
  SELECT * FROM roster_agents
   WHERE brokerage = 'keyes'
     AND deleted_at IS NULL
     AND (LOWER(public_email) = $1 OR LOWER(private_email) = $1)
   LIMIT 1
  ↓
  ┌─ no match ──────────────────────────────────────────┐
  │  Look up the same email globally (no brokerage      │
  │  filter) — if found in another brokerage, render    │
  │  "you appear to be at {other brokerage}, contact    │
  │   support" rather than letting them sign up wrong.  │
  │  Otherwise: "we don't see you. Some agents are      │
  │  registered with a secondary email — check with     │
  │  your broker. Contact: {Brokerage.Support Contact}" │
  └─────────────────────────────────────────────────────┘
  ┌─ match on private_email ────────────────────────────┐
  │  Render: "we have you under {public_email} — want   │
  │   us to send the link there instead?" (don't expose │
  │   the alt email; show domain only or first-letter   │
  │   masked). Yes → magic link to public_email.        │
  └─────────────────────────────────────────────────────┘
  └─ match on public_email ─────────────────────────────┐
     Sign JWT { agent_id, brokerage, exp: now+30min }   │
     Send magic link via Resend:                        │
       https://launchpad.rejig.ai/b/{slug}/start?t={jwt}│
     Render "check your email" page.                    │
  └─────────────────────────────────────────────────────┘

Agent clicks magic link → GET /b/keyes/start?t={jwt}
  ↓ (server component)
  Verify JWT signature + expiry
  ↓
  SELECT * FROM roster_agents WHERE id = $1
  ↓
  Live refresh: GET DMG /users/{user_id}/
    ├─ success: UPDATE promoted columns + dmg_data + last_synced_at
    └─ 5xx / timeout (3s): log warning, proceed with cached row
  ↓
  ┌─ roster_agents.customer_record_id IS NOT NULL ──────┐
  │  Resume: redirect to /r/{customer_record_id}        │
  └─────────────────────────────────────────────────────┘
  └─ customer_record_id IS NULL ────────────────────────┐
     1. Create Airtable Roster row (copy from Postgres) │
     2. Create Airtable Customer row (Section 3.3 map)  │
        with Roster Record link, Brokerage link,        │
        Channel = brokerage name, Type = 'B2B'          │
        → Airtable Auto 1 generates tasks               │
     3. UPDATE roster_agents.customer_record_id         │
     4. Redirect to /r/{customer_record_id}             │
  └─────────────────────────────────────────────────────┘
```

**Magic link, not 6-digit code.** We already built magic-link auth for `/workspace` (commit `86b3b8e`). Reusing the pattern is cheaper than a new code-entry screen, and the UX is one click vs typing 6 digits. Identity is proven by email ownership either way.

**JWT, not DB-stored token.** Stateless. Payload `{ agent_id, brokerage, iat, exp }`, HS256 signed with `AGENT_VERIFICATION_SECRET` env var. 30-min expiry. Re-clicks within window are idempotent (the customer_record_id check handles it).

**Why live refresh on signup?** The cron is daily. An agent's bio/photo could be 24h stale at moment-of-signup. The single-agent endpoint is cheap (~200ms) and gives us fresh data for prefill. If DMG is down, the cached row is still good enough to onboard.

### 4.3 Nudge campaign queries (sales workflow)

These are ad-hoc SQL run by sales, not built-in features. Examples:

```sql
-- "Email unboarded Keyes agents who joined the roster in the last 60 days"
SELECT public_email, display_name, license
FROM roster_agents
WHERE brokerage = 'keyes'
  AND customer_record_id IS NULL
  AND deleted_at IS NULL
  AND created_at > now() - interval '60 days';

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

We expose this via either (a) Neon's web SQL console for sales, or (b) a `/admin/roster` page that surfaces a few canned queries. Punt on (b) for now.

---

## 5. Code structure

```
src/
  lib/
    dmg.ts                   -- shared DMG client. OAuth2, fetchAllUsers, fetchAllOffices, fetchUser
                                Reads creds from env by brokerage slug.
    roster/
      db.ts                  -- Drizzle schema for roster_agents, roster_sync_log
      sync.ts                -- fullSyncBrokerage(slug): orchestrates sync flow (4.1)
      lookup.ts              -- lookupByEmail(brokerage, email)
                                refreshAgent(userId): live DMG + upsert
                                createCustomerFromAgent(agentId): Airtable Roster + Customer
    magic-link/
      sign.ts, verify.ts     -- JWT helpers (HS256, 30min)
  types/
    dmg.ts                   -- DMGUser, DMGOffice, DMGUsersResponse types
  app/
    b/
      [slug]/
        page.tsx             -- landing page (server component, fetches Brokerages record)
        EmailForm.tsx        -- client component, posts to /api/agent-lookup
        start/
          page.tsx           -- magic-link landing: verify JWT, refresh, create-or-resume
    api/
      agent-lookup/
        route.ts             -- POST: lookup + send magic link via Resend
      cron/
        sync-roster/
          [brokerage]/
            route.ts         -- GET: verify Vercel-Cron header, run fullSyncBrokerage(slug)

drizzle/
  migrations/
    0001_roster_agents.sql   -- generated by drizzle-kit
  schema.ts                  -- (or under src/lib/roster/db.ts)
drizzle.config.ts

vercel.json                  -- cron schedule
```

### Key library choices

- **Drizzle ORM** over Prisma: lighter, no codegen step, serverless-friendly (no engine binary), simpler migrations. Prisma is fine; Drizzle is what I'd default to for a small schema. Reviewer can push back.
- **`@neondatabase/serverless`** as the driver: HTTP-based, no connection pooling needed for serverless functions. (Vercel Postgres = Neon.)
- **`jose`** for JWT (already in the Next 16 ecosystem; or whatever the existing `/workspace` magic-link auth uses — reuse that).

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

# Magic-link signing
AGENT_VERIFICATION_SECRET=...        # 32+ random bytes, base64

# Vercel auto-sets CRON_SECRET for /api/cron/* routes
```

### 6.2 Vercel infra checklist

- [ ] Vercel Pro plan (cron, longer function timeouts, KV/Postgres free tiers)
- [ ] Vercel Postgres (Neon) added to project — provisions connection strings
- [ ] `vercel.json` with cron entries
- [ ] Env vars set for Production + Preview (Preview targets a Neon branch DB)
- [ ] Resend already configured (commit `5346cae`) — reuse for magic-link sends

### 6.3 Cost estimate

Both Postgres and KV options were within free tier on Vercel Pro. Postgres usage:

- Storage: ~30 MB at 2 brokerages × 3K agents (well under 256 MB free).
- Compute: Neon scales to zero when idle. Daily 60s cron + occasional lookups = a few minutes/day. Free tier is 60 compute-hours/month.

Net additional monthly cost beyond existing Vercel Pro: **$0** at current scale.

### 6.4 Preview environments

Neon supports DB branching. CI/Preview deployments target a Neon branch DB, not production. Branch is created on PR open, destroyed on PR close. Preview deployments have their own `POSTGRES_URL` set by the Vercel-Neon integration — no special handling needed in code.

---

## 7. Open questions

The reviewer should weigh in on these.

1. **DMG offices: separate table or inline?**
   Legacy joins office data into the agent row (`office_name`, `office_city`, etc.). I've kept that flat shape. Alternative: a `roster_offices` table joined by `primary_office_id`. Flat is simpler, joined is normalized. I lean flat; offices change rarely and the join cost is real on hot path.

2. **What does "Channel" need to be exactly?**
   `Customer.Channel` drives workflow template lookup. For Keyes it's currently `"Keyes"` mapping to Workflow Key `B2B-Keyes`. Confirm the value verbatim before coding (verify in Airtable, not from `production-schema.md` alone — per the "verify schema before coding" rule).

3. **Magic link single-use enforcement?**
   Currently stateless; the link works for 30 min and can be re-clicked. Re-clicks land on the same Customer (idempotent via `customer_record_id`). Is that acceptable, or do we need strict single-use (requires a `used_at` column / KV record)?

4. **Account types beyond `agent`.**
   DMG returns `agent`, `office user`, `management`. Legacy syncs all three. Do we want to onboard non-agents through LaunchPad, or filter to agents only at sync time? I'd default to "sync all, filter at lookup" so policy lives in one place.

5. **Sales nudge UI.**
   Is "give sales access to Neon SQL console" enough, or do we want a `/admin/roster` page with canned filters? I'd punt on the page until sales asks for it.

6. **Sunset of legacy app.**
   When does `rejig-ai/brokerage-onboarding-app` get turned off? Suggest: keep both running for 2 weeks post-LaunchPad B2B launch, redirect the legacy URL to the new one, then archive the repo.

7. **Error monitoring.**
   Cron failures need to page someone. Do we have Sentry / similar wired up, or do we just send a Resend email to a `#launchpad-alerts` Slack address from the cron handler?

---

## 8. Rollout plan

Phased so each step is reversible.

**Phase 1 — Foundation (no user-facing change)**
1. Add Vercel Postgres to project; set env vars.
2. Add Drizzle, write migration, push to DB.
3. Implement `src/lib/dmg.ts` with both Keyes + B&W credentials.
4. Manual sync script (`npx tsx scripts/sync-roster.ts keyes`) — verifies DMG creds work and the upsert logic is correct.
5. Verify row counts match what legacy app's Sheet has.

**Phase 2 — Cron**
1. Add `/api/cron/sync-roster/[brokerage]` route.
2. Add `vercel.json` cron entries.
3. Deploy to staging branch first; verify Cron secret enforcement.
4. Watch `roster_sync_log` for 3 consecutive successful daily runs before promoting.

**Phase 3 — Lookup + landing**
1. Add Brokerages support-contact fields in Airtable.
2. Build `/b/[slug]` landing page + `/api/agent-lookup`.
3. Build `/b/[slug]/start` magic-link handler.
4. Test end-to-end with a single test agent in DMG sandbox (or ourselves added to the roster).

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

- **Stripe trial flow for Keyes** (legacy `StripeHandler.gs`) — separate plan.
- **Calendly URL per brokerage** — already a Brokerages-table concern, separate.
- **B2B intake-form fields beyond what DMG returns** — handled by existing `FormTask.tsx` once Customer is created.
- **Photo / logo uploads** — DMG provides URLs; if/when agents want to upload their own, the existing `FileUploadTask.tsx` flow handles it post-customer-creation.
- **Two-way sync (writing back to DMG)** — explicit non-goal.

---

## 10. Summary

Build a Vercel-native DMG roster integration: Postgres for the bulk lookup table, daily Vercel Cron for full sync, single-agent DMG endpoint for live refresh on signup, magic link for verification, Airtable for the workflow handoff. Adds zero new monthly cost at current scale. Preserves Airtable-first architecture for everything LaunchPad already does.

Reviewers, please push hardest on §2 (storage choice), §3.1 (Postgres schema), §4.2 (verification flow), and the open questions in §7.
