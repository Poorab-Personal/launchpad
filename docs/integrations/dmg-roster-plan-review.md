# Review: DMG Roster Integration Plan

**Reviewer:** Architect (Opus 4.7, 1M context)
**Date:** 2026-05-06
**Plan:** `docs/integrations/dmg-roster-plan.md`

## TL;DR

The plan is solid. It is not over-engineered. The big bet — Postgres for the roster lookup table — is the right call and the rationale is correctly stated. There are several specific changes I'd make, but no section needs to be scrapped. The biggest risks are (a) under-documenting the behavior change to the existing Airtable Roster table, (b) the live-refresh-on-magic-link flow doing too much work in one request, and (c) the JWT being stateless in a flow whose primary side effect is irreversible Airtable writes.

Verdicts by section: §2 ✓, §3.1 ⚠ (drop `roster_sync_log`, simplify `dmg_data`), §4.2 ⚠ (move live refresh + Airtable writes off the click path or accept narrow racy outcomes; tighten the cross-brokerage branch), §7 mostly ⚠ with concrete punts.

---

## §2 — Storage choice (Postgres). Verdict: ✓ ship as-is

The Airtable rejection is correct and not a close call:

- 6K rows today, 9K at brokerage #3, 30K+ if a big national broker ever lands. Airtable's 5 req/s and `filterByFormula` performance make this a poor fit, and the plan calls that out accurately.
- A "periodically materialized lookup table in Airtable" (an alternative I'd usually push hard for) doesn't fix any of the actual problems. The bottleneck is Airtable's read characteristics, not write characteristics. Even a hand-tuned Airtable view of 6K rows is slow for a hot lookup path on every brokerage landing-page submit.
- Vercel KV is correctly rejected. Hand-rolled secondary indexes for "all unboarded Keyes agents" is a footgun. The plan didn't give KV a fair fight on signup-only lookup, but the segmenting argument carries it.

The "Airtable-first principle is preserved" framing is right but undersold. **The principle to write down explicitly is: "Airtable holds workflow state. Postgres holds bulk reference data we sync from a third party." That is a clear, reusable rule** — if a future integration (say MLS data, or an enrichment API) gives us 10K+ rows of read-mostly reference data, the answer is "second Postgres table, not 10K Airtable rows." Without articulating the rule, the next plan will re-litigate this.

**One change I'd make:** Add a paragraph in §2 (or top of §3) that says, in the project's voice: "Postgres is for reference data we don't author. Airtable remains system of record for everything LaunchPad creates, mutates, or workflows over." That's the durable principle. "First non-Airtable store" is worth the framing because every future agent reading this codebase will look at the Postgres dependency and wonder whether to use it for their thing. Tell them no, here's why, and when they should.

---

## §3.1 — Postgres schema. Verdict: ⚠ change two things

**The grain is right.** Composite unique on (brokerage, user_id) using DMG's stable id is correct. Both emails indexed case-insensitively, partial index on `deleted_at IS NULL`, and the unboarded partial index for nudges — all good. Soft-delete is right (you'll want it the first time DMG drops someone mid-flow).

**Promoted columns + `dmg_data` JSONB hybrid is the correct call.** Don't go pure JSONB (you lose typed access in app code and Drizzle), and don't go pure normalized (DMG will add fields and you don't want a migration each time). The hybrid is the standard Postgres-ish answer to "third-party payload with a few hot fields" and the plan picks it correctly.

### Change 1: Drop `roster_sync_log` as a Postgres table. Use Airtable Events.

You already have an Events table that exists for "audit log of every state change." A daily cron run is a state change. Putting sync history in Postgres creates a coherence problem: now there are two audit logs in two systems. Sales/CSM can't see "did the Keyes sync run today?" without knowing about a SQL table they don't otherwise touch. Operations questions ("when did B&W last sync?") get answered in Airtable for everything else.

Counter-argument the author might raise: "but the cron handler is already in Postgres-land, and Airtable rate limits make a sync-completion write awkward." Two writes (start + finish, with maybe an error string) is one Airtable round-trip per sync, twice a day total. That's fine. If you really want fine-grained per-row counts, log them to `console`/Vercel logs — those are your operational telemetry anyway, and Sentry/Vercel logs are the right place for "the cron run failed at row 1,432," not a SQL table you'll never query.

The existing `Brokerages.Last Roster Sync` field already gives you the "did it run successfully" signal. Add an Events row with type `Roster Synced` (or reuse a generic `System Event` type) carrying `{brokerage, agents_total, agents_upserted, agents_soft_deleted, duration_ms}` in Details, and you have an audit trail that lives where everything else does.

If you keep `roster_sync_log` anyway, at least add an index on `(brokerage, started_at DESC)` — you will query it that way and the plan doesn't index it.

### Change 2: Simplify `dmg_data` storage rule.

The plan promotes ~20 columns and also stores the raw payload in `dmg_data`. That's fine, but write down the rule: **"A field is promoted if and only if (a) we filter or sort by it in SQL, (b) we read it on the hot path more than once, or (c) it's in the Customer field mapping in §3.3."** Otherwise it lives in `dmg_data` only.

Today you've promoted things like `bio`, `website`, `photo_url`, `mls_ids` — those are correct because §3.3 copies them to Customer. But you've also promoted `office_phone`, `service_areas`, `office_state`, `office_city` which aren't in the Customer mapping and aren't queried. They could live in `dmg_data` with a TypeScript helper to read them. Lower migration burden later. Marginal call — flag and move on if you disagree.

### Missing fields

- **`source_payload_version`** or `dmg_schema_version`: when DMG changes a field shape (they will), you need to know which rows were synced under which schema. Cheap to add now, expensive to bolt on later.
- **`first_seen_at`** vs `created_at`: `created_at` is "when we first stored this row." If a soft-deleted agent reappears (you clear `deleted_at`), you preserve `created_at`. That's probably fine, but a `first_seen_at` separate from row creation makes the nudge query in §4.3 ("agents who joined the roster in the last 60 days") meaningfully more correct. Today that query measures "agents we first synced in the last 60 days," which is "agents we discovered" not "agents who joined." Acceptable for v1 if you say so explicitly; flag for later.
- **No field needed** for: versioning of agent edits (you don't edit DMG data — read-only), audit history per row (Events table covers this once Customer is created).

---

## §4.2 — Verification flow. Verdict: ⚠ several specific changes

### Magic link vs 6-digit code: ✓ correct call, but watch the inconsistency

The plan says reuse the existing magic-link pattern (commit `86b3b8e`). Verified — `src/lib/auth/magic-link.ts` exists, uses `jose`/HS256, and `src/app/signin/actions.ts` uses it.

**One thing the plan got wrong:** existing magic-link TTL is **15 minutes**, not 30. The plan proposes 30 for agent verification. Either (a) standardize on 15 to match existing UX and security posture, or (b) explicitly justify the divergence ("agents may forward to assistant who clicks later"). I lean (a). Either way, document the choice.

Note also: the existing magic link issues a **session cookie** and redirects to `/workspace`. The agent verification flow does *not* want to issue a session — it wants to perform a one-shot side effect (create Customer) and redirect to the customer portal at `/r/{token}`. So the flow is structurally different even though it reuses the JWT helper. Worth calling out in the plan so an implementer doesn't accidentally `setSessionCookie` an agent.

`b2b-keyes.md` line 26-27 says "Send verification code... Agent enters code." That doc is **vetted source of truth** per its header. The plan changes this to magic link without flagging that the vetted flow doc needs updating. **Update `b2b-keyes.md` and `b2b-bw.md` as part of this work, or the next reader is confused about which doc is current.**

### Live refresh on signup with 3s timeout: ⚠ wrong shape

The intent is right (don't onboard with stale bio/photo). The execution is wrong:

The magic-link landing page does **all** of these in one synchronous request: verify JWT → SQL select → DMG API call (3s budget) → SQL update → Airtable Roster create → Airtable Customer create → SQL update of `customer_record_id` → redirect.

That's at minimum 5 round trips on Vercel cold-start, 3 of them to external APIs (DMG, Airtable, Airtable). At p95 you are well over 3 seconds, and the redirect happens after Auto 1 has had time to fire (or not — race condition with portal load). If anything in that chain throws after Customer is created, you have an orphaned Customer with no `customer_record_id` set in Postgres → next click creates a duplicate.

Two options, pick one:

**Option A (simpler, recommended):** Drop the live refresh from the click path. The cron is daily; if a bio is 24h stale, the agent edits it on the "Confirm Your Information" form anyway. The pre-fill is "good enough" data that the agent confirms or corrects. You're optimizing for a value the user is about to overwrite. Keep it cached.

**Option B (if freshness genuinely matters):** Live refresh runs at email-lookup time (before sending the magic link), not at click time. Then the click path is JWT verify → select cached row → Airtable writes → redirect. Faster, fewer failure modes on the click path, and the user perceives the DMG latency as "we're checking our records" rather than "the link is slow."

Either way, **the Airtable Roster row + Customer row creation is the irreversible side effect and should be the only critical thing on the click path.** DMG refresh and `customer_record_id` Postgres update are best-effort/post-hoc.

### Stateless JWT, two browsers race: ⚠ idempotency check is incomplete

The plan says re-clicks are idempotent via `customer_record_id`. Walk through the actual race:

```
T=0   Browser A clicks link.
T=0   Browser B clicks link.
T=10  A: SELECT roster_agents → customer_record_id IS NULL.
T=10  B: SELECT roster_agents → customer_record_id IS NULL.
T=50  A: Airtable POST Roster row → succeeds.
T=51  B: Airtable POST Roster row → succeeds (Airtable does not enforce uniqueness).
T=400 A: Airtable POST Customer → succeeds.
T=410 B: Airtable POST Customer → succeeds.
T=450 A: UPDATE roster_agents SET customer_record_id = recA.
T=460 B: UPDATE roster_agents SET customer_record_id = recB. ← clobbers recA.
```

You now have two Customer records, two Roster rows, two Auto-1 task fan-outs (22 tasks for one agent), and Postgres pointing at the second one. The first is orphaned but discoverable to anyone who opened the portal in browser A.

Real-world likelihood: low. But "agent forwarded magic link to themselves on phone, clicked both" is a real human behavior.

Three ways to fix, ordered by simplicity:

1. **Postgres advisory lock or `SELECT ... FOR UPDATE` around the create-Customer step.** One DB call, idempotent. This is what I'd do.
2. **Single-use enforcement via `used_at` column on `roster_agents`.** Stateful, works, but adds a column for one purpose.
3. **Make JWT single-use via a `magic_links` table.** The most thorough; also the most code. Overkill for this risk.

**Decision required in plan:** pick (1) and write it down. Right now the plan says "idempotent via customer_record_id check" which is true under serial access and false under concurrent access.

### `private_email` match → "send to public_email instead": ⚠ masking is a leak

Current proposal: "we have you under {public_email} — want us to send the link there instead? (don't expose the alt email; show domain only or first-letter masked)."

The masking is fine, but two issues:

1. **Email enumeration.** If the brokerage roster has Jane at `jane@personal.com` (private) and `jane.smith@keyes.com` (public), a stranger entering `jane@personal.com` learns: (a) Jane works at Keyes, (b) her work email format is `j*****.s****@keyes.com`. That's PII leakage to anyone who can guess a personal email. The legacy app (per the docs) just sent the verification to whichever email they entered. Matching the safer behavior: **only ever send the link to the matched email itself**, never offer to redirect to a different address. If `private_email` matches, send to `private_email`. Done. Simpler, no leak.

2. **The "send instead" UX adds a click for ~zero benefit.** Agents who type their personal email are likely doing so on purpose (e.g., they prefer it). Just send the magic link there. The Customer record's `Contact Email` should be the verified email regardless.

**Recommendation:** Drop the "send to public_email instead" branch. Match on either email; send the magic link to the matched email. Update §3.3 mapping rule: `Contact Email = the email the agent verified with`.

### "Found in another brokerage" branch: ⚠ minor leak, simple fix

"You appear to be at {other brokerage}, contact support" leaks brokerage membership to anyone who can guess an email. For two brokerages, low value. For 3+, this becomes an org-relationship signal someone could scrape.

The behavior is well-intentioned ("don't let them sign up wrong"). But the actual risk of signing up wrong is small — they enter their email at `/b/keyes` because they think they're at Keyes; if they're actually at B&W, they likely already know it. The right behavior is the standard auth-flow answer: **same generic "we don't see you, contact support" message, regardless of whether they're in another brokerage.** Internally, log that this happened so support can route them. Don't surface it in the UI.

### Summary of §4.2 changes

1. Standardize 15-min TTL or justify the 30-min divergence.
2. Move live DMG refresh OFF the click path (do it at lookup time, or drop it).
3. Add Postgres-level concurrency control for Customer creation (advisory lock or SELECT FOR UPDATE).
4. Drop the cross-email "send instead" UX; send to the matched email.
5. Drop the cross-brokerage hint in the "not found" branch; log internally instead.
6. Update the vetted `b2b-keyes.md` and `b2b-bw.md` flow docs to match the magic-link change, OR explicitly note in the plan that those docs are now stale and will be updated as part of this work.

---

## §7 — Open questions, verdicts

**1. Offices flat vs joined.** **Verdict: resolve, ship flat.** Office data is small (~dozens), changes rarely, and the join is on the hot path. The author's instinct is right. The only reason to normalize would be if you needed office-level metadata that doesn't fit on the agent row — and you don't. Keep flat. Revisit when office count exceeds 1,000 across all brokerages, which is many years away.

**2. "Channel" exact string.** **Verdict: resolve before coding.** Per the plan's own rule, verify in Airtable. This is a 30-second check, not a question to leave open. Required value: `Customer.Channel = "Keyes"` produces Workflow Key `B2B-Keyes`. For B&W, current schema doc says Channel = `BW` → `B2B-BW`. The plan uses `"Baird & Warner"` as the brokerage slug human-name and `baird-warner` as URL slug — confirm Channel is `BW` not `Baird & Warner` before write.

**3. Single-use enforcement.** **Verdict: change the question.** The right question isn't "single-use vs re-clickable" — re-clickable within TTL is fine UX. The real question is "what happens under concurrent clicks?" Answer with the advisory-lock approach above. With that lock, concurrent clicks are safe and re-clickable behavior is preserved. No `used_at` column needed.

**4. Account types beyond `agent`.** **Verdict: resolve, filter at sync time.** The plan leans "sync all, filter at lookup." Disagree. DMG returns three types (`agent`, `office user`, `management`). LaunchPad's onboarding flow is built for **agents only** — workflow templates assume an agent. If an "office user" enters their email, they'll match, get a magic link, get a Customer record created with workflow B2B-Keyes, and end up with 13 inappropriate tasks. That's a worse failure than "we don't see you."

Filter at sync: store only `account_type = 'agent'` (and active=true). Saves DB rows, removes a footgun. If management ever needs to onboard, it's a separate workflow with its own template anyway.

(Counter: "policy in one place." But the policy IS at the LaunchPad onboarding boundary — non-agents simply aren't LaunchPad customers today.)

**5. Sales nudge UI.** **Verdict: punt, agreed.** Neon SQL console is fine until sales asks. Don't pre-build.

**6. Sunset of legacy app.** **Verdict: resolve, the proposed plan is fine.** 2-week parallel run, redirect, archive. Worth adding: **before sunset, run the new sync against the legacy data and verify row counts match** (already in §8 Phase 1.5). Good.

**7. Error monitoring.** **Verdict: resolve before launch.** This is the question that keeps biting projects. "Cron failure pages someone" must be wired before the cron goes live, not after. If Sentry isn't already in the project (it's not — checked package.json), the cheap path is: cron handler catches errors, sends a Resend email to a fixed `alerts@rejig.ai` address (or a Slack-via-email) with the brokerage and stack trace. 20 lines of code. Do not ship the cron without this.

---

## Cross-cutting concerns

### Roster table behavior change — ⚠ document it harder

This is the biggest documentation risk in the plan.

`production-schema.md` line 162-163 currently describes Roster as:
> Broker agent data synced from external APIs. Enterprise only. One row per agent.

The plan's behavior change: **only agents who verify get a Roster row.** That makes Roster nearly empty (hundreds, not thousands), which is a big semantic shift. A future reader of `production-schema.md` will assume Roster contains the bulk roster and write code/queries against it that silently return ~5% of expected results.

**Required:** As part of this work, update `production-schema.md` Table 4 and `architecture.md` to say something like:
> Roster contains only agents who have verified and started onboarding. Bulk DMG roster lives in Postgres (`roster_agents`). Roster → Customer one-time copy semantics unchanged.

Also update the existing `Roster API URL`/`Roster API Key`/`Roster Refresh Interval` fields on Brokerages — the plan keeps them but they're now misleading since the API URL and credentials live in code/env. Either delete the fields, or rename them to make their (now-vestigial) status clear, or add a note in the schema doc.

### Drizzle vs Prisma — ✓ Drizzle is right

For a 2-table schema with tight serverless requirements: Drizzle wins. Prisma's engine binary, cold-start cost, and codegen step are net negative at this size. Drizzle's "it's just SQL with types" model is the right fit. Approve.

(If the project ever grows to 10+ tables with complex relations, revisit. Not now.)

### Daily sync racing live refresh — ⚠ small, fixable

Walk through it: 06:00 UTC sync starts. Agent clicks magic link at 06:00:30. Click path runs live refresh, UPDATEs the row. Cron's UPSERT later in the same run overwrites with the older payload from the bulk fetch. **The agent's `customer_record_id` is preserved** (the plan correctly says step 7 preserves it), but `last_synced_at` and the JSONB payload are now stale by minutes.

Severity: low. The data is the same agent's data from the same source, minutes apart. Worst case the bio they just edited isn't... wait, they don't edit DMG data, they edit Customer fields. So actually this is fine — the Customer record is independent (one-time copy semantic), and the Postgres row is reference data only.

**One concrete change:** in the cron's UPSERT, also preserve `last_synced_at` if the existing value is newer than the cron's `sync_started_at`. One-line fix to ON CONFLICT clause. Cleaner audit trail.

If you go with my §4.2 recommendation to **move live refresh to lookup time (before sending magic link)**, the click path doesn't write to Postgres at all and this race goes away.

### Vercel Cron secret — ⚠ needs more detail than "verify the header"

The plan says "verify Vercel cron secret header." Vercel actually uses two mechanisms depending on configuration:

1. `Authorization: Bearer ${CRON_SECRET}` for routes called by Vercel Cron (auto-set by Vercel).
2. The `x-vercel-cron` header which only Vercel can set on cron-triggered invocations.

The plan should explicitly say which it uses. The standard pattern is:

```
if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) return 401;
```

Without this, the cron endpoints are public and anyone can DoS the DMG API by hitting `/api/cron/sync-roster/keyes` repeatedly. **Make the auth check the literal first line of every cron handler. Write that down in §6.**

Also: the plan says "Vercel auto-sets CRON_SECRET" — verify this. As of recent Vercel docs, you set `CRON_SECRET` yourself as an env var; Vercel sets the Authorization header from it. Don't rely on auto-magic without confirming.

### Preview environment / Neon branching — ⚠ one gotcha

Neon DB branching is great. The gotcha: **if your migration includes data (e.g., seeded brokerage rows or test agents), the branch starts from the parent's data.** That can be either what you want (preview deployments hit a realistic dataset) or a privacy concern (real agent emails in preview environments accessible to anyone with the preview URL).

For LaunchPad: roster contains real agent PII. Preview deployments likely shouldn't have access to production roster data. **Either** branch from a sanitized dev-roster Neon project (recommended) **or** explicitly accept that previews see production data and lock down preview URL access via Vercel Preview Deployment Protection.

Either choice is fine; just decide and document.

### Third-brokerage scaling — ⚠ make cron data-driven now

Two brokerages → two `vercel.json` cron entries. Adding the third means editing `vercel.json` + adding env vars + deploying. That's not terrible, but the plan claims "Adding brokerage #3 is a config change, not a code fork" (Goal #5 in §1). Today's design partially violates that goal: it requires a code/config change.

Cheap fix: one cron entry hitting `/api/cron/sync-roster-all`, which queries Brokerages from Airtable for all `Active` brokerages with `Roster API URL` set, then loops. Per-brokerage fan-out happens at runtime. Add a brokerage in Airtable + env vars for credentials → next cron picks it up. No deploy.

The staggering benefit (one DMG outage doesn't kill all syncs) is worth keeping, but you can stagger inside the loop with a sleep between brokerages, or use Promise.allSettled so one failure doesn't block others.

I'd push for this change now. Brokerage #3 is on the radar; making the cron data-driven from day one keeps the goal honest and is ~10 lines of code different from the per-brokerage approach.

---

## Top 3 changes I'd make

1. **Move the live DMG refresh and Airtable writes off the magic-link click path.** Either do the refresh at email-lookup time (before sending the magic link), or drop it entirely — the bio is about to be confirmed/edited by the agent anyway. The click path should be: verify JWT → take advisory lock → check `customer_record_id` → create Airtable rows → release lock → redirect. Simpler, faster, race-free, fewer failure modes.

2. **Document the Roster table behavior change loudly.** Update `docs/schema/production-schema.md` Table 4 and `docs/architecture.md` to state that Airtable Roster only contains verified/onboarding-started agents; the bulk roster lives in Postgres `roster_agents`. Also update the vetted `docs/flows/b2b-keyes.md` and `b2b-bw.md` to reflect magic-link (not 6-digit code) verification. Without this, future readers will trust the existing schema doc and write incorrect queries.

3. **Drop `roster_sync_log` Postgres table; use Airtable Events instead. Drop the cross-email and cross-brokerage UI hints; close the enumeration leaks. Make cron data-driven from Brokerages.** Three small simplifications that together remove ~50 lines of code, eliminate two minor PII leaks, and make brokerage #3 truly a config change. None require new architecture, just trimming.
