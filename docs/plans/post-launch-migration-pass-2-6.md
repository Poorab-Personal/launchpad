# LaunchPad Pass 2.6 Plan — Live API ingestion, conversations signal source, and observability deltas

Status: **Pass 2.6 augmentation of `docs/plans/post-launch-migration-pass-2-5.md`.** All Pass 2.5 framework stays — 5-layer pipeline, 17 profiles, 9 trajectory patterns, 6 outcome buckets, 15 action templates, 5-evaluator file structure, 9 HS properties. This pass refines §6 (importer), §12.4 (trajectory gating), §17 (snapshot-count table), §19 (open questions), §20 (risks); adds §21–§28 covering live API ingestion, conversation signals, admin Q&A foundations, and dashboard tile backlog. Do NOT touch the locked 10-value `attention_reason` enum. IPRE / demo-account handling stays out-of-scope.

---

## §21 — Live API ingestion (replaces Pass 2.5 §6 CSV importer plan)

Pass 2.5 §6 wrote against the 2026-05-11 CSV. The user now has API access; we've captured `scripts/data/rejig-snapshot-2026-05-14.json` (689 customers, gitignored). CSV is dropped from the plan as a legacy artifact — keep the file on disk for archaeology, but do not write a CSV-reading code path.

### 21.1 Authoritative identity key

`_id` (Mongo) is the canonical `rejigUserId`. **NOT** the email. Stable across snapshots even when business name / display name / email churn. The earlier "email-as-pivot" identity strategy in Pass 2 §6.2 stays for the LP-customer join (LP doesn't have `_id` on file yet — that's Phase 6 backfill), but for signal-row uniqueness inside `customer_usage_signals`, the importer should write `signal_value_jsonb._id` on every row so re-runs can dedupe on `_id` rather than email.

### 21.2 New API client interface

Design (do not implement here):

```
src/lib/integrations/rejig/client.ts

export type RejigAccount = {
  _id: string;
  account_name: string;
  email: string;
  business_name: string;
  display_business_name: string;
  domain_url: string;
  plan_expiry_date: string;            // ISO
  days_until_expiry: number;
  subscription_status: 'active' | 'trialing' | 'canceled' | 'deactivated';
  plan_key: string | null;
  stripe_subscription_id: string | null;
  is_manual: boolean;
  last_login: string | null;           // ISO or null
  listing_count: number;
  post_metrics: {
    total_published: number;
    video_posts: number;
    image_posts: number;
    days_since_last_post: number | null;
    content_type_breakdown: Record<string, number>;   // structured (was CSV string)
  };
};

export async function fetchAccountsSnapshot(opts?: {
  source?: 'api' | 'file';
  filePath?: string;                  // when source='file'
}): Promise<RejigAccount[]>;
```

Env vars expected (user owns the values — do not commit, do not hardcode):
- `REJIG_API_URL` — base URL, e.g. `https://api.rejig.ai`
- `REJIG_API_KEY` — bearer or x-api-key (verify auth scheme with user; flag in §27)
- `REJIG_API_PATH_ACCOUNTS` — path suffix for the snapshot endpoint, optional default

The client must support BOTH:
1. **File mode** — `fetchAccountsSnapshot({ source: 'file', filePath })` parses a local JSON snapshot. Used by Phase 5 importer for backfill + reproducible runs.
2. **Live mode** — `fetchAccountsSnapshot({ source: 'api' })` hits the API. Used by Phase 9 cron + ad-hoc admin runs.

Single response-parser shared by both paths — they return identical typed objects. This makes Phase 9 a thin wrapper around Phase 5 (the importer just changes its source).

### 21.3 Signal schema deltas

`rejig.total_published_posts` now captures `content_type_breakdown` as a structured object inside `signal_value_jsonb`. Pass 2 §6.1 had it as a parsed-from-string blob; that parsing layer is now deleted:

```jsonc
{
  "signal_type": "rejig.total_published_posts",
  "signal_value_numeric": 233,
  "signal_value_jsonb": {
    "videoPosts": 49,
    "imagePosts": 184,
    "contentTypeBreakdown": {
      "Holidays": 10, "Articles": 51, "Listings": 65,
      "RE Topics": 14, "Local News": 8, "Crafted by Me": 21,
      "Industry News": 54, "Market Updates": 10
    },
    "_id": "6736597bcfc528e7d24b8a56",
    "snapshotDate": "2026-05-14"
  }
}
```

Other 5 Rejig signal types unchanged from Pass 2 §6.1 except: every row's `signal_value_jsonb` now carries `_id` for cross-snapshot joins.

### 21.4 Snapshot file naming convention

Locked: `scripts/data/rejig-snapshot-YYYY-MM-DD.json` — one file per import; dated to the calendar day of the API call (UTC). Importer derives `snapshot_date` from filename (overridable via flag). Phase 9 live-mode skips file altogether.

### 21.5 Importer signature update

`scripts/import-rejig-snapshot.ts` (existing path from Pass 2 §6.2):

```
npx tsx scripts/import-rejig-snapshot.ts \
  [--source file|api] \
  [--file scripts/data/rejig-snapshot-2026-05-14.json] \
  [--apply] \
  [--limit N]
```

Default: `--source file --file <latest dated file in scripts/data/>`. The dry-run / apply / idempotency / batching mechanics from Pass 2 §6.2 are unchanged. The only delta is the source.

### 21.6 Phase 9 closer than originally thought

Pass 2 §6 framed Phase 5 (snapshot import) and Phase 9 (live ingestion) as separate efforts. With the API client interface above, Phase 9 collapses to:

1. Vercel cron at `0 12 * * *` (daily, 1h after BI cron's 11 UTC slot — so fresh signals exist before BI runs the next day, OR — better — flip the order: 9 fetches first at 10 UTC, 4 evaluates at 11 UTC).
2. Calls `fetchAccountsSnapshot({ source: 'api' })`.
3. Pipes results through the same importer pipeline as Phase 5.

Recommended sequencing tweak: ship Phase 5 (file mode) first to validate the importer pipeline against `rejig-snapshot-2026-05-14.json`. Phase 9 (API mode) becomes a flag flip + cron entry once `REJIG_API_URL`/`REJIG_API_KEY` are wired. Estimate Phase 9 down from "future work" to ~0.5 day on top of Phase 5.

---

## §22 — No BI gating on data quality (revises Pass 2.5 §12.4 + §17 + §20 risk #10)

### 22.1 User decision

> "the 2 customers having less data could be a real issue. If it's a data issue (API doesn't run well) - I will want to know and flag. I do not want to add gates/checks for BI... I'll take a false positive on a potential churn and be surprised if it is a data issue. We'll then fix the data issue... and if it still happens a lot, we can put gates in later phases."

The 3-day delta surfaced two anomalies:
- `lisa@treugroup.com`: `total_published` 107 → 4 (Δ −103)
- `sold@sellingwellington.com`: 34 → 0

These are physically impossible (lifetime post counts only grow). Either the API view is wrong, or the customer was deleted-and-recreated upstream. We do NOT block BI on this.

### 22.2 Revisions to Pass 2.5

**§12.4 trajectory detector** — REMOVE the "requires ≥3 snapshots over ≥7 days before non-`insufficient_data` returns" gate. Detection runs on whatever data is available. Confidence is downgraded (see §26 below) but firing is not blocked.

**§20 risk #10** — Mitigation rewritten:

> "Trajectory detection runs on whatever snapshot count is present. Confidence is surfaced via `signal_value_jsonb.confidence` (`low` at N=1, `medium` at N=2-3, `high` at N≥4). False positives flowing through to CSM action queues are accepted as the data-quality canary."

**Phase 4 BI rules** — no gate added. If a regression-derived signal trips a `near_certain_churn` outcome, the CSM finding it weird IS the data-quality signal we want.

### 22.3 New event-log surface: `Data Quality Anomaly` (OBSERVABILITY, not GATING)

A lightweight detector runs inside the snapshot importer (Phase 5 + Phase 9). After ingestion, for each customer where a prior snapshot exists:

```
if currentSnapshot.total_published < previousSnapshot.total_published:
   write to activity_log (or customer_state_transitions with change_source='lp_data_quality') a row:
     event_type: 'Data Quality Anomaly'
     payload: { _id, email, field: 'total_published', prev: 107, curr: 4, delta: -103,
                prev_snapshot_date, curr_snapshot_date }
```

Surfaces in:
1. **Admin Activity Log** section (existing route in the admin app — confirm path; if no activity log table exists yet, write to a new `data_quality_events` table; one column for `event_type`, one jsonb for payload).
2. **Phase 4-Polish dashboard tile #6** (see §25).
3. Optional Slack ping (deferred — not Phase 4).

Detector is loose: any monotonic-growth field (`total_published`, `video_posts`, `image_posts`, `listing_count` — though listings CAN decrease, so exclude) triggers an event when it shrinks. No blocking. No retry. CSMs / admin notice the event count weekly.

---

## §23 — Intercom / HubSpot Conversations as a new BI signal source (biggest delta)

The user surfaced: "Intercom conversations via API or better yet HS has these." This adds a new ingestion track to the BI pipeline. It augments Layer 3 (predictor) and Layer 4 (actions), without changing the 5-layer architecture or evaluator file count.

### 23.1 Decision: PULL from HubSpot Conversations API (preferred over Intercom direct)

Rationale:
- HS auth + scopes are already wired; the integration uses a static developer token (`HUBSPOT_STATIC_TOKEN`).
- If Rejig already runs Intercom synced into HubSpot Conversations Inbox, the data flows through HS for free.
- Single read path is leaner than maintaining a parallel Intercom OAuth + token-refresh integration.
- Future support tools (HS Service Hub Tickets, FB Messenger threads) come through the same API.

Tradeoffs to acknowledge:
- **HubSpot Conversations API surface is uneven.** Two distinct APIs are involved:
  1. **Conversations Inbox API** (`/conversations/v3/conversations/threads`, `/messages`) — gives threads, messages, status (`OPEN`/`CLOSED`), channel (`EMAIL`/`LIVE_CHAT`/`FB_MESSENGER`/`WHATSAPP`/`THIRD_PARTY`). Scope: `conversations.read`. (Some inbox endpoints have been beta-flagged historically — verify current GA status before relying on listing + filter semantics.)
  2. **CRM Objects API** for the `conversation` object — gives associations to Contacts via standard CRM associations. Scope: `crm.objects.conversations.read` (verify exact scope token; may also accept `tickets`-style legacy scope on older portals).
- **Intercom-via-HS coverage** is not universal — depends on whether the Rejig Intercom integration is configured to sync into HS Inbox (vs sitting standalone in Intercom). **Flag for user verification (§27 Q-new).**

### 23.2 New signal types (canonical list — extends Pass 2.5 §12.3 / Pass 2 §6.1 vocabulary)

| signal_type | Source | observed_at | numeric value | jsonb shape |
|---|---|---|---|---|
| `intercom.conversations_count_30d` | `hs_conversations_pull` | snapshot date | thread count in trailing 30d | `{threads: int, channels: ["EMAIL","LIVE_CHAT",...], topTopics: [str], _id}` |
| `intercom.last_contact_at` | `hs_conversations_pull` | actual last conversation timestamp | null | `{conversationId, channel, subject, _id}` |
| `intercom.unresolved_threads` | `hs_conversations_pull` | snapshot date | unresolved thread count | `{threadIds: [str], oldestUnresolvedAt: ISO, _id}` |
| `intercom.first_contact_at` | `hs_conversations_pull` | first ever conversation | null | `{conversationId, _id}` |
| `intercom.avg_sentiment_30d` (**v2 — not computed in v1**) | future LLM job | snapshot date | -1.0 to +1.0 | `{n_threads, sample_text_hashes, model_version}` |

The `intercom.` namespace prefix is preserved (the user explicitly said Intercom-style signals — even though we pull through HS — because the source-of-record is Intercom for support semantics).

`intercom.avg_sentiment_30d` is documented now and added to the canonical vocabulary; populated only when LLM-enrichment lands (referenced under `docs/integrations/hubspot-integration.md` §"v2 BI: LLM-enriched analysis"). NOT computed in v1.

### 23.3 Integration into the 5-layer framework

**Layer 1 (Profile classifier).** Do NOT split `power_user` into `power_user_quiet` vs `power_user_active_support` for v1. Two reasons:
1. Conversation count is multi-snapshot (30d rolling) — not single-snapshot like the other profile inputs.
2. The split adds 1+ profiles; we already have 17 at the cardinality cap. Defer.

The profile classifier stays exactly as in Pass 2.5 §11. Conversation signals enter at Layer 3.

**Layer 3 (Outcome predictor) — NEW PREDICATE.** Add to `outcome-predictor.ts`:

```
// New rule inside computeOutcome():
if (signals.intercom.unresolved_threads >= 3 &&
    (trajectory.pattern in ['declining','oscillating_2','oscillating_3','terminally_declining']
     || profile in ['power_user_declining','steady_user_declining','paying_but_absent'])) {
  return 'likely_churn_in_30d';  // upgrade from whatever the base would have been
}

// And a softer rule:
if (signals.intercom.unresolved_threads >= 2 && outcomeSoFar === 'likely_renew') {
  return 'likely_renew_after_intervention';   // downgrade health
}
```

Order: these run AFTER the base outcome compute, as an upgrade pass. Documented in the predictor's pluggable-interface contract: hard signals can monotonically worsen the outcome but not improve it.

**Layer 4 (Action recommender) — 3 NEW TEMPLATES.** Extends Pass 2.5 §14.1 table from 15 → 18 templates:

| # | Trigger | Action type | Content | Urgency |
|---:|---|---|---|---|
| A16 | `likely_renew_after_intervention` + `intercom.unresolved_threads >= 2` | `csm_call` + `email_template` | "Personal CSM call; lead with 'I see you've been hitting walls in support — let me help directly'" | `this_week` |
| A17 | `likely_churn_in_60d` OR `likely_churn_in_30d` + `intercom.unresolved_threads >= 3` | `csm_call` | "URGENT outreach; multiple unresolved threads — likely frustrated; consider co-founder escalation" | `today` |
| A18 | `never_adopted` + `intercom.conversations_count_30d == 0` | `loom_send` + `task_create` | "No support history, no adoption — cold outreach via Loom; first-touch warmth important" | `this_week` |

Library ordering: A16/A17/A18 insert into the existing first-match-wins library at positions interleaved by urgency (A17 next to A12; A16 next to A8; A18 next to A4). Test asserts urgency monotonicity holds.

`A17` co-founder escalation: leave the boolean off for v1 — surfacing the recommendation via property is enough; A17 escalation behavior decided in §27 Q-new.

**Layer 5 (State mapper).** Unchanged. Conversation signals never directly drive state; they drive outcome, which drives state. Single funnel.

### 23.4 Implementation shape

```
src/lib/integrations/hubspot/conversations.ts
  fetchConversationsForContact(contactId, sinceISO) → ConversationSummary[]
    // Two API calls: list threads filtered by associatedObjectId=contactId + latestMessageTimestamp >= sinceISO,
    // then OPTIONALLY hydrate top topics from message bodies (deferred to v2 LLM job).

src/lib/bi/signal-ingestion/hs-conversations.ts
  pullForCustomer(customer) → number  // returns count of signals written
    // For each customer with hubspotContactId:
    //   summaries = fetchConversationsForContact(contactId, NOW() - 30d)
    //   compute: count_30d, unresolved_threads (status='OPEN'),
    //            last_contact_at (max latestMessageTimestamp),
    //            first_contact_at (cached after first pull; from a separate "all-time" query)
    //   insert 4 signals via the same idempotent path the Rejig importer uses
```

### 23.5 Cadence

**Daily, aligned with the BI cron.** No real-time webhook needed for v1 — none of the 18 action templates require sub-day responsiveness. Order in the cron pipeline:
1. Rejig snapshot pull (Phase 9 — §21)
2. HS Conversations pull (this section — §23)
3. Trajectory recomputation (§12.4 — runs on whatever data exists per §22)
4. BI evaluator pass (5-layer pipeline)
5. HubSpot property push

For low-volume tenants (<5 conversations/month/customer median), weekly cadence might be sufficient. **§27 Q-new** asks user to confirm cadence — recommendation: daily for v1, monitor volume in week 1 and consider weekly if it produces no meaningful churn signal density.

### 23.6 HubSpot scope addition

`launchpad-integration/src/app/app-hsmeta.json` `requiredScopes` array currently has 8 entries. Add (under Phase 4 sub-task):

```
"conversations.read"
```

And likely also:

```
"crm.objects.conversations.read"
```

— required for the CRM-object-based association lookup (contactId → conversationIds). **Exact scope name needs verification (§27 Q-new).** If granting requires an OAuth-app re-install (private apps usually do), pair this with the existing 9-property setup pass so the user re-authorizes once, not twice.

---

## §24 — Phase 11 admin Q&A reference architecture (deferred — design only)

User surfaced as distant future: "Even build an AI layer that can munge data and through an admin interface answer questions — how is agent x doing?"

### 24.1 Foundation status

Already in place via this plan:
- All BI outputs land in Postgres tables (`customers`, `customer_state_transitions`, `customer_usage_signals`, the new `data_quality_events`).
- All cardinalities are bounded — 17 profiles, 6 outcomes, 18 actions, 10 attention reasons, 9 trajectory patterns, ~25 signal types.
- All semantics are queryable in plain SQL.

This satisfies the foundational requirement: **all BI outputs should be Postgres-queryable in plain SQL by an AI agent later.** Locked here so future schema changes preserve this property.

### 24.2 Reference architecture (Phase 11+)

Out-of-band admin endpoint `/api/admin/qa` taking `{ question: string }`, returning `{ answer: string, sourceQueries: SQL[], rows: any[] }`.

Implementation options (do not choose now):
1. **Anthropic MCP Postgres server** — read-only role; the agent picks tool calls; LP just wraps the agent loop.
2. **Hand-rolled tool wrapper** — predefined query templates ("get latest BI state for customer where email=X") with parameter substitution. Safer; less flexible.
3. **Direct LLM agent with schema-aware prompt** — Claude given the schema + example queries, generating SQL each turn. Most flexible; needs strict guardrails.

### 24.3 Locked constraints for Phase 11

- **Read-only Postgres role** (`launchpad_readonly`) — created at infra time; agent runs as this role; no INSERT/UPDATE/DELETE possible at the DB layer regardless of prompt.
- **Statement timeout** (5s default).
- **Customer-data redaction** for non-admin viewers — agent prompt includes the requestor's role; pre-filters or masks PII.
- **Audit log** — every NL question + generated SQL + result preview is written to an `admin_qa_audit` table (one row per question).

Phase 11 is the implementation pass. Phase 4 sets the foundation by writing structured, schema-stable outputs. No work required in this plan beyond keeping that promise.

---

## §25 — Phase 4-Polish admin dashboard tiles

Phase 4 core ships the BI cron + 9 properties. Once it's writing data, admin dashboards get richer. This sub-phase ("Phase 4-Polish") rides after Phase 4 core lands. Implementer backlog:

| # | Tile | Source query | Notes |
|---:|---|---|---|
| 1 | **Cohort grid (17 × 6)** | `SELECT engagementProfile, predictedOutcome, count(*) FROM customers WHERE onboardingState IS NOT NULL GROUP BY 1,2` | 102-cell grid; click-through to filtered customer list view. Sparsely populated — render only non-empty cells |
| 2 | **Brokerage health** | per-brokerage at-risk % from `rejig_brokerage_channel` + `onboardingState` | Surfaces `unique`/`arcrealty` distress (Pass 2.5 §18.2). Sortable column |
| 3 | **Action queue** | customers WHERE `rejig_recommended_action_urgency = 'today'` | Sortable by `rejig_recommended_action_set_at` (oldest first); CSMs work this daily |
| 4 | **Trend chart — engagement_drop_30d** | weekly count of customers in `engagement_drop_30d` over last 12 weeks | From `customer_state_transitions` — count distinct `customer_id` per ISO-week where `attentionReason='engagement_drop_30d'` was active. Line chart |
| 5 | **Time-to-launch funnel** | Pre-Onboarding → Onboarding Scheduled → Active → Watch/Active per-week conversion % | From transitions; week-cohorted (customer enters Pre-Onboarding in week W, % reaching Active by W+1, W+2, ...). Stacked-bar chart |
| 6 | **Data quality alerts** | count of post-count regressions in last 7 days | From `data_quality_events` (§22.3). Just the number; click-through to a flat list of `{email, prev, curr, snapshot_dates}` |

None of these ship with Phase 4 core. Spec'd here as the next-up backlog. Estimate: 2-3 days of admin-UI work after core is live and verified.

---

## §26 — Updated single-snapshot vs multi-snapshot behavior (replaces Pass 2.5 §17)

Per §22, the trajectory gate is removed. Updated table:

| Layer | At N=1 snapshot | At N=2 snapshots | At N=4-6 | At N=21+ |
|---|---|---|---|---|
| Profile (1) | Fully functional | Same | Same | Same |
| Trajectory (2) | First decline detectable (single-snapshot deltas vs whatever `observed_at` gap exists). `confidence='low'` written to jsonb. | Pattern detection live (`ramping`/`declining`/`steady`). `confidence='medium'`. | Cycle pairs detectable (`oscillating_2`). `confidence='medium'`. | Full cycle detection reliable (`oscillating_3`, `oscillating_4plus`, `terminally_declining`). `confidence='high'` |
| Outcome (3) | Layer-1-driven + (any) trajectory pattern allowed. False positives accepted as data-quality canary | Marginally better | High confidence on healthy/declining | Founder's "3rd peter-out" fires reliably |
| Action (4) | All 18 templates available; A8/A9/A12/A13/A17 fire on low confidence but still surface | Same | Same | Same |
| State (5) | Fully functional | Same | Same | Same |

Confidence is surfaced via `derived.posting_trajectory.signal_value_jsonb.confidence` and mirrored to the Layer 3 outcome predictor's input. The action recommender does NOT filter by confidence in v1 — false positives are intentional (per §22). If after 4 weeks of operation the false-positive rate is unbearable, gate Tier-B HS Task auto-creation on `confidence='high'` — but properties always write regardless.

---

## §27 — Updated open questions (replaces Pass 2.5 §19)

### Carried forward from Pass 2.5

- **Q-2.5-2** `rejig_engagement_profile` cardinality (17 values) — OK with this many? Recommendation: ship 17; review at 30 days.
- **Q-2.5-4** HS Task auto-creation aggression (Tier B). Recommendation: properties-only initially, flip Tier B on after 1 week of property-only.
- **Q-2.5-5** Customer-visible profile labels? Recommendation: NO — internal-only.
- **Q-2.5-8** Cohort-level brokerage-distress alert threshold. Recommendation: 50% of brokerage in `*_declining`/`paying_but_absent` for ≥7d → alert.
- **Q-2.5-9** Action library ownership (PR-gated changes). Confirm.
- **Q-2.5-10** Profile churn dampening (48h hysteresis). Confirm.

### Struck (resolved by Pass 2.6)

- ~~**Q-2.5-1** out-of-scope brokerages~~ — user said handle separately (Revision 3).
- ~~**Q-2.5-3** trajectory threshold sensitivity~~ — user said no data-quality gates; thresholds stand as designed, false positives accepted (Revision 2).
- ~~**Q-2.5-6** multi-snapshot enablement gate~~ — user said no gates (Revision 2).
- ~~**Q-2.5-7** `LP_HUBSPOT_APP_ID` discrepancy~~ — verified `39386685` is correct (Pass 2.5 §19 already resolved).

### New (Pass 2.6)

- **Q-2.6-1** Live API auth scheme — bearer / header API key / OAuth? Endpoint URL + path for the accounts snapshot? **Needs user input.** Plan assumes `REJIG_API_URL` + `REJIG_API_KEY` bearer; revise if different.
- **Q-2.6-2** HubSpot Conversations API scope name — exact scope token for the v3 Inbox + CRM-object reads. Likely `conversations.read` + `crm.objects.conversations.read`. **Needs verification from HubSpot Developer Portal** before app-hsmeta.json is edited. Cross-confirm that the static-token integration supports these scopes.
- **Q-2.6-3** Intercom-via-HS sync confirmation — is Rejig's Intercom integration configured to sync conversations into HubSpot Conversations Inbox? If NO, this entire §23 source needs to switch to direct Intercom OAuth + API integration (out-of-scope for this pass; flag as Phase 4.5 if needed). **Needs user verification.**
- **Q-2.6-4** HS Conversations pull cadence — daily or weekly? Recommendation: daily for v1, monitor volume in week 1, possibly weekly thereafter. **Confirm daily?**
- **Q-2.6-5** Action templates A16-A18 — are these the right CSM interventions for support-frustrated customers? Should A17 escalate to direct co-founder outreach (and how do we signal that — a flag on the action, a routed HS task assignee, a separate property)? **Needs user input.**
- **Q-2.6-6** `data_quality_events` table location — new table, or piggyback on `customer_state_transitions` with `change_source='lp_data_quality'`? Recommendation: new dedicated table to keep transition log clean. **Confirm separate table?**

---

## §28 — Net delta from Pass 2.5

| Pass 2.5 | Pass 2.6 disposition |
|---|---|
| 5-layer pipeline (Profile → Trajectory → Predicted Outcome → Recommended Action → State) | KEEP unchanged |
| 17 engagement profiles | KEEP unchanged |
| 9 trajectory patterns + "petering out" mapping | KEEP; remove the ≥3-snapshot / ≥7-day gate (§22) |
| 6 outcome buckets | KEEP unchanged |
| 15 action templates | EXTEND to 18 — add A16/A17/A18 (§23.3) |
| 5-evaluator file structure | KEEP unchanged (1 new ingestion file added at `src/lib/bi/signal-ingestion/hs-conversations.ts` — NOT a new evaluator) |
| 9 HS Contact/Ticket properties | KEEP unchanged |
| 12 signal_types in vocabulary | EXTEND to 16 — add 4 `intercom.*` types (§23.2); `intercom.avg_sentiment_30d` declared as v2-only |
| `customer_usage_signals` schema | UNCHANGED — `_id` rides inside existing `signal_value_jsonb` |
| Pass 2.5 §6 CSV importer plan | REPLACE with §21 live API client + JSON importer |
| Pass 2.5 §17 snapshot-count table | REPLACE with §26 — confidence-graduated, no gating |
| Pass 2.5 §19 open questions (10) | 6 carry, 4 struck, 6 new (§27) |
| Pass 2.5 §20 risks (15) | KEEP; risk #10 mitigation rewritten (§22.2) |
| Phase 4 admin dashboard scope | EXTEND — Phase 4-Polish backlog with 6 tiles (§25) |
| Phase 11 admin Q&A | NEW reference architecture, design-only (§24) |
| HubSpot app scopes | EXTEND — add `conversations.read` + `crm.objects.conversations.read` to `app-hsmeta.json` (§23.6) — exact token verification pending Q-2.6-2 |

**Net effort delta from Pass 2.5:** ~+1.5-2 days (HS Conversations integration ~1d; live API client + JSON importer ~0.5d; data-quality event detector ~0.25d; dashboard backlog deferred — does not gate Phase 4 ship). Pass 2.5 was ~9-10 days; Pass 2.6 is ~10.5-12 days total. Phase 4-Polish tiles add another 2-3 days but ride after Phase 4 ships.

### Critical Files for Implementation

- `/Users/poorabshah/dev/rejig-ai/launchdeck/src/lib/integrations/rejig/client.ts` (NEW — Rejig API client with file/api dual mode; §21.2)
- `/Users/poorabshah/dev/rejig-ai/launchdeck/scripts/import-rejig-snapshot.ts` (UPDATE — JSON-source default, optional `--source api` flag; §21.5)
- `/Users/poorabshah/dev/rejig-ai/launchdeck/src/lib/integrations/hubspot/conversations.ts` (NEW — HS Conversations API client; §23.4)
- `/Users/poorabshah/dev/rejig-ai/launchdeck/src/lib/bi/signal-ingestion/hs-conversations.ts` (NEW — derives 4 `intercom.*` signals; §23.4)
- `/Users/poorabshah/dev/rejig-ai/launchdeck/src/lib/bi/outcome-predictor.ts` (UPDATE — add unresolved-threads upgrade pass; §23.3 Layer 3)
- `/Users/poorabshah/dev/rejig-ai/launchdeck/src/lib/bi/action-library.ts` (UPDATE — add A16/A17/A18; §23.3 Layer 4)
- `/Users/poorabshah/dev/rejig-ai/launchdeck/launchpad-integration/src/app/app-hsmeta.json` (UPDATE — add Conversations scopes; §23.6)
