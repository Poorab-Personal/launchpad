# Plan: B2B Roster Integration (Multi-Source, DMG First)

**Status: 2026-05-13 rewrite — applies cutover + new auth/multi-source decisions. Supersedes v2 (2026-05-06).**

Postgres is now LaunchPad's system of record (Airtable retired 2026-05-12). The legacy plan assumed a hybrid Airtable+Postgres future; that framing is gone. Customer creation is a single `db.transaction` in `POST /api/customers`. Roster bulk lookup is a uniform Postgres table keyed by `brokerage_id` with per-source adapters. Verification is hCaptcha-only soft auth — no magic-link round-trip on the happy path.

---

## 1. Context

Three B2B brokerages onboard via Delta Media Group (DMG): Keyes and Baird & Warner today, plus Illustrated Properties Real Estate (IPRE, slug `ipre`) launching end of May 2026. Keyes + B&W today use `rejig-ai/brokerage-onboarding-app` (Apps Script + Sheets + Drive + Zapier); IPRE will launch directly on the LaunchPad pipeline. We are folding the existing flow into LaunchPad and adding IPRE at the same time. The replacement must:

- Pull agent data from each brokerage's source (DMG today; potentially MLS Grid / manual CSV later).
- Verify an agent at the brokerage landing page (`/{slug}`).
- Pre-fill the onboarding form from roster data.
- Hand off to the customer portal (`/r/{token}`).
- Be cheap, fast, and reasonable to extend to a third brokerage or non-DMG source.

### URL structure (locked)

Bare top-level slugs at the root. No `/b/` prefix.

```
onboarding.rejig.ai/keyes
onboarding.rejig.ai/bw
onboarding.rejig.ai/{slug}         ← brokerage #3+
onboarding.rejig.ai/r/{token}      ← customer portal (existing)
onboarding.rejig.ai/api/*          ← API
```

Implementation: `src/app/[slug]/page.tsx` with an allowlist driven by `brokerages.landing_page_slug` so unknown slugs don't shadow `/admin`, `/workspace`, `/r`, `/signin`, `/auth`, `/api`.

> **Stale doc note.** `CLAUDE.md` line 103 (project-structure tree) and `src/db/schema/brokerages.ts:22` (`// /b/[slug]` comment) both reference the obsolete `/b/[slug]` route. Update both when the route lands.

### Scale

- Each brokerage: ~3,000 agents.
- DMG returns the entire roster in one API response (no pagination), plus a single-agent endpoint `GET /users/{userId}/`.
- Both current brokerages use the same DMG API (`https://apis.deltagroup.com/v2`); only OAuth2 client credentials differ.

### Goals

1. Same-or-better data freshness than the legacy app.
2. Sub-second agent lookup at the landing page.
3. Resilient to source-API outages (signup never blocked by a transient 5xx).
4. Sales/CSM can run ad-hoc "nudge unboarded agents" queries.
5. Adding a brokerage on a new source = one adapter file + config rows. No fork of the lookup, cron, or auth path.

### Non-goals

- Two-way sync (read-only).
- Replacing Stripe / Calendly integrations.
- Migrating historical Sheets data (those agents already onboarded).

---

## 2. Architecture decision

> **Postgres holds bulk reference data we sync from third parties. The `customers` / `tasks` / `events` graph holds workflow state LaunchPad authors.**

This was the durable principle in the v2 plan; with Postgres now the system of record across the board it's even less controversial. `brokerage_roster` is bulk reference data — ~3K rows per brokerage, weekly-synced, read-mostly. It sits next to `customers` in the same database but has a totally different lifecycle.

### Multi-source abstraction

One uniform `brokerage_roster` table for all brokerages regardless of source. A `source_type` enum on `brokerages` discriminates; per-source adapters in `src/lib/roster/sources/<source>.ts` expose `fetchAll` / `fetchOne` / `normalize`. The lookup, cron, and auth paths stay single-path forever; adding a non-DMG source is one adapter file, not a schema migration.

```
brokerage_roster                  brokerages                       Source APIs
────────────────                  ──────────                       ───────────
~3K rows × N brokerages   ←──FK── id                  ←─via──── DMG /users/
bulk pre-verification             source_type ('dmg')   adapter   (today)
lookup                            source_config jsonb
                                  verification_mode
                                  support_contact_*

roster (existing)                 customers
────────────────                  ─────────
one row per agent who      ←──FK── workflow / state graph
verified and started               (created atomically when
onboarding; post-verify            an agent verifies)
bridge to customers
```

`brokerage_roster` (bulk, pre-verification) and `roster` (post-verification, one row per onboarding agent) are two distinct tables with two distinct lifecycles. Do not confuse them. The existing `roster` semantics from `docs/schema/production-schema.md` are unchanged.

---

## 3. Data model

### 3.1 New: `brokerage_roster` table

One table, Drizzle ORM, single migration. Per-row sync detail lives in Vercel logs; one event row per brokerage per cron run goes into the `events` table.

```sql
CREATE TYPE source_type AS ENUM ('dmg');  -- extensible: 'mls_grid', 'manual_csv', ...
CREATE TYPE verification_mode AS ENUM ('soft', 'magic_link_required');

CREATE TABLE brokerage_roster (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id          UUID NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  source_user_id        TEXT NOT NULL,            -- stable id from the source (DMG userId today)
  account_type          TEXT NOT NULL,            -- always 'agent'; non-agents filtered at sync
  status                TEXT,                     -- source-specific status (active/inactive)
  display_name          TEXT,
  first_name            TEXT,
  last_name             TEXT,
  public_email          TEXT,
  private_email         TEXT,
  cell_phone            TEXT,                     -- stored; NEVER used as an auth factor (TCPA)
  website               TEXT,
  license               TEXT,
  photo_url             TEXT,                     -- reference only; NOT copied to customers.agent_photo
  bio                   TEXT,
  mls_ids               TEXT,
  primary_office_id     TEXT,
  office_name           TEXT,                     -- promoted: nudge queries group by office
  source_data           JSONB NOT NULL,           -- raw normalized payload
  source_schema_version TEXT,                     -- forward-compat: which payload shape
  customer_id           UUID REFERENCES customers(id) ON DELETE SET NULL,  -- set on verification
  first_seen_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at        TIMESTAMPTZ NOT NULL,
  deleted_at            TIMESTAMPTZ,              -- soft-delete: missing from latest sync
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (brokerage_id, source_user_id)
);

CREATE INDEX idx_brokerage_roster_public_email
  ON brokerage_roster (LOWER(public_email), brokerage_id)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_brokerage_roster_private_email
  ON brokerage_roster (LOWER(private_email), brokerage_id)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_brokerage_roster_unboarded
  ON brokerage_roster (brokerage_id)
  WHERE customer_id IS NULL AND deleted_at IS NULL;
```

**Promotion rule.** A field is promoted to a column iff (a) we filter or sort by it in SQL, (b) we read it on the hot path more than once, or (c) it appears in the customer field mapping in §3.3. Everything else lives in `source_data` only.

**UPSERT race rule.** The cron's `INSERT ... ON CONFLICT (brokerage_id, source_user_id) DO UPDATE` must:
- Preserve `customer_id` if already set.
- Preserve `last_synced_at` if existing is newer than `sync_started_at` (race with a concurrent lookup).
- Preserve `first_seen_at` (only set on INSERT).
- Clear `deleted_at` (re-appeared in roster).

**Why `first_seen_at` is separate from `created_at`:** so the "agents who joined the roster in the last N days" nudge query stays meaningful across soft-delete + reappearance cycles. `created_at` = first stored in this Postgres instance; `first_seen_at` = first ever observed for that `(brokerage_id, source_user_id)`.

### 3.2 `brokerages` schema changes

The same Phase 1 migration drops the vestigial Airtable-era columns and adds the new ones. Don't ship them separately.

| Column | Action | Notes |
|---|---|---|
| `roster_api_url` | DROP | URL is shared across DMG brokerages, lives in code. |
| `roster_api_key` | DROP | Credentials live in Vercel env vars. |
| `roster_refresh_interval` | DROP | Cadence is hardcoded weekly. |
| `source_type` | ADD `source_type NOT NULL DEFAULT 'dmg'` | Drives adapter dispatch. |
| `source_config` | ADD `jsonb` | Per-source bits (e.g. DMG env-var key prefix). |
| `verification_mode` | ADD `verification_mode NOT NULL DEFAULT 'soft'` | Escape hatch; flip to `magic_link_required` if abuse appears. |
| `support_contact_name` | ADD `text` | Shown on the "we don't see you" failure screen. |
| `support_contact_email` | ADD `text` | Same. |
| `support_contact_phone` | ADD `text` | Same. |

The existing `last_roster_sync timestamptz` stays; it's the "did the cron run" signal.

The drop is safe — the Airtable cutover already retired the only readers, and the `brokerages.ts` schema file already tags those three columns as `// vestigial post-DMG plan`.

### 3.3 Events table

Fire one event row per brokerage per cron run with `event_type = 'Roster Synced'`.

**No DDL needed.** `events.event_type` is a plain `text` column (per `src/db/schema/events.ts`) — not a pgEnum — so the Phase 1c sync handler can write the literal string `'Roster Synced'` directly. (An earlier draft of this plan had an `ALTER TYPE` step; that was based on a misread of the schema.)

Event row shape: `customer_id` left NULL (system-level event), `actor_type = 'System'`, `details jsonb` carries `{brokerage_id, source_type, agents_total, agents_upserted, agents_soft_deleted, duration_ms}`. On failure, `details` carries `{brokerage_id, source_type, error, duration_ms}` and the same handler emails `alerts@rejig.ai` — see §6.

### 3.4 Customer creation field mapping

On verification, the atomic `POST /api/customers` flow copies these fields from the matched `brokerage_roster` row into the new `customers` row:

| `customers` column | `brokerage_roster` source | Notes |
|---|---|---|
| `name` | `display_name` | Postgres column is `name`, not `displayName`. |
| `type` | literal `'B2B'` | |
| `channel_id` | resolved from `brokerage.default_workflow_key` | `brokerages` has no `channel_id` column; the verification handler maps `slug → brokerage → default_workflow_key → channel code → channel.id` via the existing `channelIdForCode()` helper in `src/lib/db.ts`. Same path as `POST /api/customers`. |
| `contact_email` | the matched roster email | Whichever of `public_email` / `private_email` matched the agent's input. |
| `platform_email` | the matched roster email | Set to the SAME value as `contact_email` on roster-driven creates. Both columns are NOT NULL. |
| `phone` | `cell_phone` | Postgres column is `phone`. |
| `website` | `website` | |
| `bio` | `bio` | |
| `license_number` | `license` | |
| `mls_ids` | `mls_ids` | |
| `brokerage_id` | brokerage FK | |
| `roster_record_id` | newly-created `roster` row | The post-verification bridge row, created in the same transaction. |
| `agent_photo` | **not pre-populated** | `agent_photo` is a JSONB array of Vercel Blob attachment objects. Source `photo_url` is a third-party CDN URL; mismatched shape. Agent uploads in-portal via the existing FileUploadTask after sign-in. |

Same transaction also sets `brokerage_roster.customer_id` on the matched row — closes the loop and powers the unboarded-agent partial index.

---

## 4. Flows

### 4.1 Periodic sync (Vercel Cron, data-driven)

One cron entry. The handler reads active brokerages from Postgres and dispatches to the right adapter via `source_type`.

```
Vercel Cron (one entry, weekly: Sunday 10:00 UTC = 2 AM PST / 3 AM PDT)
  ↓
GET /api/cron/sync-roster-all
  ↓ FIRST LINE: verify Authorization: Bearer ${CRON_SECRET}, else 401
  1. SELECT * FROM brokerages WHERE active = true;
  2. For each brokerage, in parallel via Promise.allSettled:
       a. const sync_started_at = now()
       b. Load adapter: src/lib/roster/sources/{brokerage.source_type}.ts
       c. agents = await adapter.fetchAll(brokerage.source_config)
       d. Filter to account_type = 'agent' AND status active
       e. UPSERT each agent into brokerage_roster (by brokerage_id, source_user_id):
            - SET all promoted columns + source_data + source_schema_version
            - SET last_synced_at = GREATEST(existing.last_synced_at, sync_started_at)
            - Preserve customer_id, first_seen_at; clear deleted_at on conflict
       f. Soft-delete agents missing from this fetch:
            UPDATE brokerage_roster SET deleted_at = now()
             WHERE brokerage_id = $1 AND last_synced_at < $sync_started_at
               AND deleted_at IS NULL
       g. UPDATE brokerages SET last_roster_sync = now() WHERE id = $1
       h. INSERT INTO events ('Roster Synced', actor='System',
            details={brokerage_id, source_type, agents_total,
                     agents_upserted, agents_soft_deleted, duration_ms})
  3. Aggregate results; on any rejection, send Resend email to alerts@rejig.ai
     with brokerage(s) and stack trace(s). Return 200 with JSON summary.
```

**Schedule** (`vercel.json`):

```json
{ "crons": [ { "path": "/api/cron/sync-roster-all", "schedule": "0 10 * * 0" } ] }
```

Sunday 10:00 UTC = 2 AM PST / 3 AM PDT. Weekly is plenty for nudge segmenting; the lookup path serves cached data and the agent confirms it on intake (§4.2).

**Failure handling.** `Promise.allSettled` so one brokerage's source outage doesn't block another. Alert fires; handler returns 200 (no Vercel auto-retry). If freshness ever becomes urgent, add an `/api/cron/sync-roster-now` endpoint or shorten the schedule.

### 4.2 Agent verification + signup (single round trip)

Soft auth via hCaptcha. No magic-link email. No JWT. The atomic customer-creation transaction is the only side effect.

```
Agent visits /keyes
  ↓ server component
  SELECT * FROM brokerages WHERE landing_page_slug = 'keyes' AND active = true;
  → render landing (logo, copy, support contact, hCaptcha widget)
  ↓
Agent enters email + completes hCaptcha → POST /api/agent-lookup
  body: { email, slug, hcaptchaToken }
  ↓
  1. Verify hCaptcha:
       POST https://api.hcaptcha.com/siteverify
            { secret: HCAPTCHA_SECRET, response: hcaptchaToken }
       Reject if !success.
  2. Resolve brokerage_id from slug. Reject if brokerage.verification_mode
     != 'soft' (escape hatch — future-proofing only; behavior for the
     'magic_link_required' branch is a separate plan if/when we flip it).
  3. SELECT * FROM brokerage_roster
       WHERE brokerage_id = $1
         AND deleted_at IS NULL
         AND (LOWER(public_email) = $2 OR LOWER(private_email) = $2)
       LIMIT 1
     (note: no live source refresh — cached weekly roster is fine; agent
      confirms / edits on the intake form).
  4. No match:
       Log "agent-lookup miss" + email-hash + brokerage_id to Vercel logs.
       Return 200 with generic copy:
         "We don't see you in this brokerage's roster. If your office uses
          a secondary email for you, try that — or contact
          {brokerage.support_contact_name} at {support_contact_email}."
       Never indicate whether the email exists elsewhere.
  5. Match — atomically:
       BEGIN
         SELECT pg_advisory_xact_lock(hashtext(brokerage_id || ':' || source_user_id));
         -- Idempotency: re-runs on the same row land on the same customer.
         IF roster.customer_id IS NOT NULL:
           token = SELECT access_token FROM customers WHERE id = roster.customer_id;
           COMMIT; return { redirect: `/r/${token}` };
         ELSE:
           matched_email = whichever of public_email / private_email matched $2;
           -- POST /api/customers helper (same one the admin "add customer"
           -- form uses) — inserts customer + tasks + dependencies + Customer
           -- Created event in one transaction.
           channelId = channelIdForCode(channelCodeForWorkflow(brokerage.default_workflow_key));
           -- brokerages has no channel_id column; resolution path is
           -- slug → brokerage → default_workflow_key → channel code → channel.id.
           -- Mirrors POST /api/customers' existing channel-resolver in src/lib/db.ts.
           customer = createCustomer({
             type: 'B2B',
             channelId,
             brokerageId: brokerage.id,
             rosterRecordId: (newly-created roster row),
             name, contactEmail=matched_email, platformEmail=matched_email,
             phone, website, bio, licenseNumber, mlsIds, ...
           });
           UPDATE brokerage_roster SET customer_id = customer.id WHERE id = roster.id;
       COMMIT
       Return 200 with { redirect: `/r/${customer.access_token}` };
```

**Why hCaptcha + email matching is enough.** No money moves at this gate (Stripe trial happens later, in-portal). Real threat is scripted abuse creating bogus customer rows and burning Resend reputation; hCaptcha + per-IP rate limit on `/api/agent-lookup` address that. Identity proof is "soft" — the pre-populated intake form is the truth-establishing moment. Agent sees roster data, confirms or edits, then anything ships.

**Why NOT magic links on the happy path.** Spam folders, deliverability friction, and a worse UX (open inbox, find email, click) for a gate that doesn't protect dollars. We pre-wire `brokerages.verification_mode = 'magic_link_required'` as an escape hatch; if scripted abuse appears post-launch we flip the flag (and ship the magic-link branch then).

**Why NOT license number / MLS ID as a second factor.** License is public (state regulator sites, Zillow). MLS ID can be multiple-per-agent. Roughly zero abuse-resistance gain over hCaptcha alone, real agent friction.

**Why the advisory lock survives.** Double-click / quick re-submit / open-in-two-tabs is a real behavior. `pg_advisory_xact_lock(hashtext(brokerage_id || ':' || source_user_id))` serializes the create step within Postgres for the transaction's lifetime; the second caller waits, then finds `customer_id` already set and redirects to the existing portal. No duplicate customers, no double task fan-out.

**Email matching rule.** Match on either `public_email` or `private_email` (case-insensitive). Send the agent into the portal with `contact_email = platform_email = whichever-matched`. We don't ask "did you mean X@brokerage.com?" — that's the email enumeration leak the v2 plan already retired.

**Recovery for legit agents who fail captcha.** Rare with a checkbox captcha. The "no match" screen surfaces `brokerage.support_contact_*` for manual intervention.

### 4.3 Nudge campaign queries (sales workflow)

Ad-hoc SQL via Neon's web console. Examples:

```sql
-- Unboarded Keyes agents who joined the roster in the last 60 days
SELECT br.public_email, br.display_name, br.license
  FROM brokerage_roster br
  JOIN brokerages b ON b.id = br.brokerage_id
 WHERE b.landing_page_slug = 'keyes'
   AND br.customer_id IS NULL
   AND br.deleted_at IS NULL
   AND br.first_seen_at > now() - interval '60 days';

-- Unboarded B&W agents grouped by office
SELECT br.office_name, count(*) AS unboarded_count
  FROM brokerage_roster br
  JOIN brokerages b ON b.id = br.brokerage_id
 WHERE b.landing_page_slug = 'bw'
   AND br.customer_id IS NULL
   AND br.deleted_at IS NULL
 GROUP BY br.office_name
 ORDER BY unboarded_count DESC
 LIMIT 100;
```

A `/workspace/roster` page with canned filters is punted until sales asks.

---

## 5. Code structure

```
src/
  lib/
    roster/
      sources/
        dmg.ts                -- OAuth2, fetchAll, fetchOne, normalize → BrokerageRosterRow
        (future: mls-grid.ts, manual-csv.ts, ...)
      sync.ts                 -- syncBrokerage(brokerage), runAllActiveSyncs()
      lookup.ts               -- lookupByEmail(brokerageId, email)
      types.ts                -- shared adapter interface + BrokerageRosterRow type
    captcha.ts                -- verifyHCaptcha(token): boolean
  db/
    schema/
      brokerageRoster.ts      -- new table
      brokerages.ts           -- adds source_type, source_config, verification_mode,
                                  support_contact_*; drops three vestigial columns
      enums.ts                -- adds source_type, verification_mode, 'Roster Synced'
                                  event_type value
  app/
    [slug]/
      page.tsx                -- landing (server component); renders hCaptcha widget
      EmailForm.tsx           -- client component; POST /api/agent-lookup
    api/
      agent-lookup/
        route.ts              -- POST: verify hCaptcha, match roster, create customer,
                                  return redirect
      cron/
        sync-roster-all/
          route.ts            -- GET: verify Bearer CRON_SECRET (FIRST LINE),
                                  fan out to adapters, alert on failure

drizzle/migrations/
  NNNN_brokerage_roster.sql   -- generated; adds table + brokerages columns +
                                  drops vestigial columns + extends enums

vercel.json                   -- single cron entry, weekly Sunday 10:00 UTC
```

### Adapter interface

```ts
// src/lib/roster/types.ts
export interface RosterSourceAdapter {
  fetchAll(config: unknown): Promise<NormalizedRosterRow[]>;
  fetchOne(config: unknown, sourceUserId: string): Promise<NormalizedRosterRow | null>;
}

export type NormalizedRosterRow = {
  sourceUserId: string;
  accountType: string;
  status: string | null;
  displayName: string | null;
  // ... rest of the promoted columns
  sourceData: unknown;          // raw payload — opaque to lookup/cron code
  sourceSchemaVersion: string;
};
```

The sync handler is unaware of DMG specifics; it just calls `adapter.fetchAll(brokerage.source_config)` and UPSERTs the normalized result. Adding MLS Grid is one file under `sources/` plus inserting `'mls_grid'` into the `source_type` enum.

### Next.js 16 note (per AGENTS.md)

Consult `node_modules/next/dist/docs/` before writing route handlers or server components. Do not rely on training-data familiarity with App Router conventions.

---

## 6. Environment & infrastructure

### Env vars

```
# DMG credentials (per brokerage; source_config.credEnvPrefix tells the adapter
# which prefix to read — adapter does process.env[prefix + "_CLIENT_ID"], etc.)
# Each brokerage has its own DMG account; do not share credentials across brokerages.
DMG_KEYES_CLIENT_ID=...
DMG_KEYES_CLIENT_SECRET=...
DMG_BAIRD_WARNER_CLIENT_ID=...
DMG_BAIRD_WARNER_CLIENT_SECRET=...
DMG_IPRE_CLIENT_ID=...
DMG_IPRE_CLIENT_SECRET=...

# hCaptcha (free tier: 1M verifications/month; we'll do ~6K agents total)
HCAPTCHA_SITE_KEY=...          # public, embedded in landing page
HCAPTCHA_SECRET=...            # server-only, used in siteverify

# Cron auth (set manually; Vercel forwards as Authorization: Bearer)
CRON_SECRET=...

# Error alerts (reuse existing Resend setup)
ALERTS_EMAIL=alerts@rejig.ai
```

### Cron auth — literal first line of the handler

```ts
export async function GET(request: Request) {
  if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }
  // ... rest
}
```

Without this, anyone can DoS DMG by hitting `/api/cron/sync-roster-all` repeatedly.

### Failure alerts

```
on cron failure (any brokerage rejected) OR on agent-lookup transaction half-success:
  await resend.emails.send({
    from: 'launchpad@rejig.ai',
    to: process.env.ALERTS_EMAIL,
    subject: `[LaunchPad] Roster sync failed: ${brokerageSlug}`,
    text: `Brokerage: ${slug}\nError: ${err.message}\n\nStack:\n${err.stack}`,
  });
```

This must ship in the same PR as the cron handler. Silent cron failures kill agent freshness.

### Preview deployments

Preview environments must NOT see real production roster PII. Branch from a sanitized dev-roster Neon project, not from production. Set the Vercel-Neon integration source accordingly.

### Cost

- Postgres: ~30 MB for 2 brokerages × 3K agents (well under free tier).
- hCaptcha: free up to 1M verifications/month.
- Net additional monthly cost: $0.

---

## 7. Open questions

All previously open items resolved:

1. **Offices flat vs joined** — flat. `office_name` is the only promoted column; rest lives in `source_data`. Revisit if office count exceeds 1,000.
2. **Channel resolution** — channel is an FK target on `customers.channel_id`; no string-match step. Brokerage row carries the right `channel_id` and the resolver copies it directly.
3. **Idempotency** — Postgres advisory lock + `customer_id` check in the verification transaction. Re-submits land on the same customer.
4. **Non-agent account types** — filtered at sync time. Office users and management never enter `brokerage_roster`.
5. **Sales nudge UI** — punted. Neon SQL console suffices.
6. **Legacy app sunset** — 2-week parallel run after launch, redirect legacy URLs, archive `rejig-ai/brokerage-onboarding-app`. Row-count parity check before cutover.
7. **Error monitoring** — Resend email to `alerts@rejig.ai`, wired in the same PR as the cron.

---

## 8. Rollout plan

Four phases, each reversible. Legacy app keeps working at every phase.

**Phase 1 — Foundation (no user-facing change)**
1. Drizzle migration: add `brokerage_roster`, drop vestigial `brokerages` columns, add new `brokerages` columns (`source_type`, `source_config`, `verification_mode`, `support_contact_*`), extend enums.
2. Implement DMG adapter (`src/lib/roster/sources/dmg.ts`) + manual sync script (`npx tsx scripts/sync-roster.ts keyes`).
3. Verify row counts match the legacy Sheet (parity check).
4. Update `brokerages` rows with `source_type='dmg'`, `source_config`, support contacts.

**Phase 2 — Cron + alerts**
1. Add `/api/cron/sync-roster-all` route with `Authorization: Bearer ${CRON_SECRET}` as the first line.
2. Add `vercel.json` cron entry (weekly Sunday 10:00 UTC).
3. Wire Resend failure alert in the same PR.
4. Verify on preview: curl without header → 401; manually trigger → success row in `events`.
5. Watch for 2 consecutive successful weekly runs before promoting.

**Phase 3 — Landing pages + atomic verification**
1. Build `src/app/[slug]/page.tsx` with brokerage allowlist + hCaptcha widget.
2. Build `POST /api/agent-lookup` (verify hCaptcha → match roster → create customer atomically → redirect).
3. Update `CLAUDE.md` line 103 and `src/db/schema/brokerages.ts:22` to remove the stale `/b/[slug]` references.
4. End-to-end test with a sandbox DMG record (or our own roster entry).
5. Concurrent-submit test: two parallel POSTs for the same agent → exactly one customer row.

**Phase 4 — Cutover**
1. Soft-launch: send the new URL to 1–2 real Keyes agents; observe.
2. Update legacy app to show "we've moved → new URL" banner.
3. Two weeks later: redirect legacy URL → new URL.
4. Archive `rejig-ai/brokerage-onboarding-app`.

**Reversibility:** at each phase the legacy app still works. Worst case at Phase 4 we point real agents back at the legacy URL.

---

## 9. Out of scope

- Stripe trial flow for Keyes — separate plan.
- Calendly URL per brokerage — already a `brokerages` column, separate.
- Two-way sync to DMG — explicit non-goal.
- `/workspace/roster` UI for sales — punted until requested.
- Sentry / structured error monitoring — Resend alerts cover for now.
- Magic-link branch implementation — wired as `verification_mode = 'magic_link_required'` enum value; the actual branch ships if/when we flip the flag.

---

## 10. Decisions locked 2026-05-13

1. **Soft auth via hCaptcha — no magic-link round-trip on the happy path.** Spam-folder/deliverability concerns outweigh security at this gate; no money moves until in-portal Stripe trial. `verification_mode` flag pre-wired for the escape hatch.
2. **Multi-source abstraction from day one.** Uniform `brokerage_roster` table keyed by `brokerage_id`; per-source adapters at `src/lib/roster/sources/<source>.ts`; `source_type` enum on `brokerages`. Brokerage #4 on a non-DMG source = one adapter file, zero schema migration.
3. **Bare top-level slugs for brokerage landings.** `/keyes`, `/bw`, future `/{slug}`. No `/b/` prefix. Allowlist driven by `brokerages.landing_page_slug` to avoid collisions.

Superseded from v2 (2026-05-06):

- "Live DMG refresh at lookup time" — dropped. Cached weekly roster suffices; agent confirms on intake.
- "15-minute magic-link TTL" — moot under soft auth. Kept as future spec for the `magic_link_required` branch.
- "Send link to whichever email matched" — preserved in spirit: roster matches on either email; that email becomes `customers.contact_email` and `customers.platform_email`.

Kept from v2:

- `pg_advisory_xact_lock(hashtext(brokerage_id || ':' || source_user_id))` for verification idempotency.
- `account_type = 'agent'` filter at sync time.
- Generic "we don't see you, contact {support}" copy on lookup miss; no cross-brokerage hint.
- Promotion rule for columns vs `source_data`.
- Soft-delete with `deleted_at`; preserve `customer_id` / `first_seen_at` on UPSERT.

---

## 11. Summary

A Postgres-native, multi-source-ready roster integration. Weekly Vercel Cron syncs `brokerage_roster` from each brokerage's source via per-source adapters. Agent lands at `/{slug}`, completes an hCaptcha, gets matched against the cached roster, and lands in the customer portal — all in one atomic transaction, no magic-link round-trip, no Airtable hop. Stale rosters are fine because the agent confirms data on the intake form. The escape hatch for abuse is a one-flag flip to `verification_mode = 'magic_link_required'`. Adding a non-DMG brokerage is one adapter file plus config rows. Zero new monthly infrastructure cost.
