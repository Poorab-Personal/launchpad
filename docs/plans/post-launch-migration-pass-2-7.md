# LaunchPad Pass 2.7 Plan — User locks + cadence + scope reductions

Status: **Pass 2.7 finalization layer on top of Pass 2.6.** All Pass 2.5/2.6 framework stays. This is the FINAL plan-doc before execution; resolves all open questions and locks user-confirmed decisions 2026-05-14.

## §29 — Locked decisions

### 29.1 Rejig API client — API-only, no file mode

User decision:
> "Let's only rely on API that gets called on vercle...no need for file...we won't do that."

**Pass 2.6 §21.2 superseded.** The `RejigClient` interface is API-only:

```ts
src/lib/integrations/rejig/client.ts

export type RejigAccount = { /* same shape as Pass 2.6 */ };

export async function fetchAccountsSnapshot(): Promise<RejigAccount[]>;
```

**Env vars:**
- `REJIG_API_URL` — base, defaults to `https://api.rejig.ai`
- `REJIG_API_KEY` — value sent as `X-Service-API-Key` header (NOT bearer; auth scheme confirmed by user)

**Endpoint:** `${REJIG_API_URL}/dashboard/admin/account-list`. Returns `{status, code, data: RejigAccount[]}` per the captured 2026-05-14 sample.

**Vercel deployment requirement:** `REJIG_API_KEY` env var must be added to Vercel production env before BI cron can run on Vercel. Currently in `.env.local` only — local-dev path works today; cron deployment is gated on the env-var add. **Q-2.6-1 RESOLVED.**

The `scripts/data/rejig-snapshot-2026-05-14.json` file stays on disk for archival reference but is NOT a code path.

### 29.2 BI cadence — WEEKLY (not daily)

User decision:
> "Weekly should be fine - it's not that active. wondering if the BI is also weekly..(sort of hey CSM, it's Monday - here's the status, forecasted churn, etc...and they tackle it...if this changes daily and tickets jump around that too could be frustrating...)"

**Pass 2.5/2.6 daily cron schedule changes to weekly.** Locked:

- **Monday 10:00 UTC** — Rejig snapshot fetch (replaces Pass 2.6 §21.6 daily)
- **Monday 11:00 UTC** — BI evaluator cron (was daily 11 UTC; now weekly)
- Stripe signals stay **event-driven** (webhook continues writing in real-time — no change there)

Rationale:
- Rejig signals (login, posts, listings) don't change meaningfully day-to-day for most customers
- Weekly BI gives steadier ticket states — no daily flipping between Watch/Active that frustrates CSMs
- Aligns with a "Monday morning digest" CSM workflow
- Stripe webhooks still drive real-time payment-related state changes (Critical state from payment_failed fires when the event arrives, not weekly)

**Phase 4-Polish trend chart (Pass 2.6 §25 tile #4)** — already weekly, no change.

**Trajectory framework (Pass 2.5 §12.4)** — with weekly snapshots, 6 snapshots = 6 weeks of history. "Petering out" detection works on the original cadence (≥3 cycles → `oscillating_3` → CSM call). Real petering out happens over weeks, not days; this is the right granularity.

### 29.3 Conversations / Intercom signal source — DEFERRED

User decision:
> "Let's phase that - add that on later - just to reduce scope"

**Pass 2.6 §23 entirely DEFERRED to a future phase (Phase 4.5 or later).** All of:
- `intercom.conversations_count_30d`, `intercom.last_contact_at`, `intercom.unresolved_threads`, `intercom.first_contact_at` signal types
- Action templates A16, A17, A18
- The `outcome-predictor.ts` unresolved-threads upgrade pass
- HubSpot Conversations API client + scope addition

Pass 2.6 framework documents the design so it's drop-in when we activate. **Intercom-via-HS confirmed integrated** (user confirmed 2026-05-14: "Intercom app is installed in HS"), so the HS-pull approach will work whenever we activate. **Q-2.6-3 RESOLVED.**

**Action library stays at 15 templates (A1-A15) for v1.** A16-A18 are documented but not implemented.

### 29.4 Threshold provenance + tunability

User question:
> "where do we get the 'dials' >=50 and days_since...14...etc. come from? aka what if our values are wrong or need to be tweaked or are these based on some dry runs (if so, we only have 2 snapshots)."

**Threshold derivation transparency.** The Pass 2.5 §11.2 profile thresholds were picked from the 2026-05-11 snapshot's histogram distributions in Pass 2.5 §1 (data-derived natural shoulders, not guessed). The 5 main thresholds and their rationale:

| Threshold | Where derived | Rationale |
|---|---|---|
| `posts >= 50` | Pass 2.5 §1.7 histogram | Heavy-user cutoff. 51-100 bucket: 89 customers. 101+ bucket: 133. The two together = 222 heavy adopters; the under-50 cohort drops off there. |
| `posts < 6` (light-user) | Pass 2.5 §1.7 | The 1-5 cohort (101 customers) plus 0-post (90) is the "barely-using" tail. 6+ is meaningful adoption. |
| `days_since_login <= 14` | Pass 2.5 §1.5 | The ≤7d bucket has 413 customers (60.6%); the 8-14d bucket has 73. Together = "currently engaged." Drops to 40 in 15-30d. |
| `days_since_last_post > 30` | Pass 2.5 §1.6 | Same shoulder pattern. ≤7: 381; 8-14: 46; 15-30: 39; 31-60: 31. The 30-day mark is the natural break. |
| `listing_count >= 3` (listings-only) | Pass 2.5 §1.8 | The 1-3 cohort is 261 (most agents have at least one active listing). 4+ separates "listing-active" agents. 3 is the floor for the "has inventory" signal. |

**Tunability — all thresholds locked in a single constant module:**

```
src/lib/bi/thresholds.ts

export const PROFILE_THRESHOLDS_V1 = {
  posts_power_user_floor: 50,           // §1.7 — heavy-user cutoff
  posts_light_user_ceiling: 5,           // §1.7 — light-user tail
  posts_steady_user_floor: 6,            // §1.7 — meaningful adoption floor
  days_since_login_engaged_ceiling: 14,  // §1.5 — currently-engaged threshold
  days_since_last_post_declining_floor: 30,  // §1.6 — declining threshold
  listing_count_active_floor: 3,         // §1.8 — listing-active floor
  video_non_adopter_posts_floor: 10,     // feature-specific
  power_user_waning_login_ceiling: 14,   // same as engaged_ceiling
} as const;

export type ProfileThresholdsVersion = 'V1' | 'V2';        // V2 reserved for post-tune
```

**Re-tune review schedule:**
- **Week 1 post-launch:** validate cohort distribution holds (no profile >40%, every profile ≥1 customer)
- **Week 4:** with 4 weekly snapshots ingested, replay last 4 snapshots through classifier. If any profile drifts >20% in count, retune.
- **Re-tune process:** propose `PROFILE_THRESHOLDS_V2`, A/B against current values on the 4-week snapshot history, ship via constant swap.

**Honesty: thresholds are data-derived from ONE snapshot.** That's not a lot. Pass 2.5 §20 risk #12 ("Algorithm staleness — single-snapshot thresholds") is real. Mitigation: ship V1, observe for 4 weeks, retune. Not gating; just iterating. **Q-5 RESOLVED.**

### 29.5 Escalation routing

User decision:
> "Yes, escalation to coufounder is fine (or LP admin)"

**Pass 2.6 §23.3 A17 escalation** — when activated (Phase 4.5+), routes the HS Task assignee to **LP admin (poorab@rejig.ai)** rather than the customer's assigned CSM. Implemented via Task creation with explicit `hubspot_owner_id` override.

Documented now; not active in v1 since Conversations are deferred. **Q-2.6-5 PARTIALLY RESOLVED** (escalation target locked; activation pending Conversations integration).

### 29.6 `data_quality_events` — separate table

User decision: "go with architect"

**Pass 2.6 §22.3 architect recommendation accepted.** New table:

```sql
CREATE TABLE data_quality_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid REFERENCES customers(id) ON DELETE CASCADE,
  event_type text NOT NULL,                  -- 'post_count_regression', 'video_count_regression', etc.
  payload jsonb NOT NULL,                    -- { field, prev, curr, delta, prev_snapshot_date, curr_snapshot_date, _id, email }
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX dq_events_observed_idx ON data_quality_events (observed_at);
CREATE INDEX dq_events_customer_idx ON data_quality_events (customer_id);
```

Kept separate from `customer_state_transitions` to keep the transition log clean (only stage moves there). **Q-2.6-6 RESOLVED.**

### 29.7 Other Pass 2.5/2.6 questions — defaults locked

User said earlier ("I'll take a false positive on a potential churn and be surprised if it is a data issue. We'll then fix the data issue") — applying the same "no over-engineering" lens to the remaining carry-forward questions:

- **Q-2.5-2** 17-profile enum cardinality → SHIP 17; review at 30 days. **LOCKED.**
- **Q-2.5-4** Tier-B Task auto-creation → Properties-only for v1 launch; flip Tier B on after 1 week if CSMs want it. **LOCKED.**
- **Q-2.5-5** Customer-visible profile labels → NO, internal-only. **LOCKED.**
- **Q-2.5-8** Cohort alert threshold → 50% of brokerage in `*_declining`/`paying_but_absent` for ≥2 weeks (was 7 days; bumped to 2 weeks given weekly cadence). **LOCKED.**
- **Q-2.5-9** Action library ownership → LP product owner; PR-gated changes. **LOCKED.**
- **Q-2.5-10** Profile churn dampening → 1-week hysteresis (was 48h; bumped given weekly cadence — a profile change must persist across 2 consecutive weekly snapshots before being persisted to `customers.engagementProfile`). **LOCKED.**

## §30 — Final implementation sequence

Net effort delta from Pass 2.6: **−1 day** (Conversations deferred, file-mode dropped, weekly cadence simplifies cron).

| Sub-phase | Work | Effort |
|---|---|---|
| **4a** | `applyStateTransition` helper + `updateTicketProperties` HS helper + signal_type taxonomy lock + `PROFILE_THRESHOLDS_V1` constant module | 0.5 day |
| **5a** | Rejig API client (API-only) + `scripts/import-rejig-snapshot.ts` (live API fetch via `X-Service-API-Key`) — dry-run, --apply, idempotent | 0.75 day |
| **5a.1** | Import the 2026-05-14 snapshot to staging DB. Verify ~660 matched + ~30 orphan signal cohorts | 0.25 day |
| **4b** | 5 evaluator files: `profile-classifier.ts`, `trajectory-job.ts`, `outcome-predictor.ts`, `action-recommender.ts`, `state-mapper.ts`. Action library has 15 templates (A1-A15). Cron handler at `/api/cron/bi/route.ts`. Vercel cron config: weekly Monday 11 UTC. | 2 days |
| **4b.1** | Unit tests per evaluator + integration test against the imported snapshot | 1 day |
| **5b** | Add 9 HS Contact/Ticket properties (user manual setup in HS UI) + `contact-metadata-push.ts` integration | 0.5 day |
| **4c** | Smoke test: run BI manually via curl; verify 5-10 spot-check customers; verify HS property writes; flip Vercel cron live | 1 day |
| **Phase 4-Polish** (deferred — rides after Phase 4 core ships) | 6 admin dashboard tiles (Pass 2.6 §25) | +2-3 days, post-launch |

**Total Phase 4 + 5 v1 core: ~6 days.** Phase 4-Polish + Conversations integration are post-launch.

## §31 — Vercel env-var checklist (user action)

Before Phase 4c can flip the cron live:

| Env var | Where | Status |
|---|---|---|
| `REJIG_API_URL` (`https://api.rejig.ai`) | Vercel Production | NEEDS USER ADD |
| `REJIG_API_KEY` (your `X-Service-API-Key` value) | Vercel Production | NEEDS USER ADD |
| `CRON_SECRET` (for /api/cron/bi auth) | Vercel Production | NEEDS USER ADD (Phase 4b decides format) |

`HUBSPOT_STATIC_TOKEN`, `STRIPE_SECRET_KEY`, `RESEND_API_KEY`, etc. — already set.

## §32 — Open questions remaining

None. All locked. Proceeding to Phase 4a execution upon user go-ahead.

---

**Reference docs (full plan stack):**
- `docs/plans/post-launch-migration.md` — Pass 1 (10-phase scaffold)
- `docs/plans/post-launch-migration-pass-2.md` — Pass 2 (data analysis + initial rules)
- `docs/plans/post-launch-migration-pass-2-5.md` — Pass 2.5 (5-layer framework)
- `docs/plans/post-launch-migration-pass-2-6.md` — Pass 2.6 (live API + Conversations design + observability)
- `docs/plans/post-launch-migration-pass-2-7.md` — this doc (locks + cadence + scope reductions)
