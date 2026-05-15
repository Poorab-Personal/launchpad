# HubSpot Custom Cards Design

Status: Design proposal — 2026-05-15. Scope: 3 UI Extension cards inside the existing `launchpad-integration/` Developer Platform Project App.

## 1. Recommendation (TL;DR)

**Build cards #2 (Rejig engagement) and #3 (Ticket BI outputs). Defer card #1 (Stripe + subscription) to v1.1.**

Reasoning, specific to this codebase:

- The BI cron at `src/app/api/cron/bi/route.ts` already writes the seven `rejig_*` properties to HS Contact and three `rejig_recommended_action*` properties to HS Ticket. Those values render as labelless rows in the default HubSpot "About" sidebar today — semantically correct, visually useless. A card turns those existing properties into a glanceable block (color-coded urgency, grouped headings, "last-evaluated" timestamp). Pure presentation, no new data plumbing. Cards #2 and #3 are 80% of the value for 20% of the effort.

- Card #1 is the expensive one. We don't push Stripe billing state to HubSpot today (the audit deferred `rejig_payment_status` because one Contact-level property can't model multi-product subs — Core/Voice/Avatar). To show next-renewal-date and last-invoice-status the card has to call Stripe live via an LP-hosted endpoint. That means new code on the LP side (route + Stripe wrapper + auth gate), plus the same UI work. Worth it eventually — but ship #2 and #3 first to prove the deployment loop, then add #1.

**Why not just curate the HubSpot property layout?**

- HubSpot's "About" sidebar shows properties as flat label-value pairs. There are no group headings within a section, no conditional formatting (Watch/Critical can't be highlighted red), no inline action buttons, and no derived fields (e.g. "Posting trajectory: declining for 4 weeks" — derived from the raw `rejig_posting_trajectory` value + `rejig_recommended_action_set_at`). The BI outputs are CSM-facing and need contextual framing, not a raw enum string `power_user_waning`.

- A card also lets us cluster the right fields together. The current Contact has ~5 LP-relevant properties spread across 20+ native ones; CSMs scan a wall of fields. The Rejig engagement card is the explicit "Rejig says…" block.

- Cards are also the natural home for "Refresh now" and "Open in LP admin" actions when those become useful (post-v1).

**Sanity guardrail:** if CSMs tell us after a week of using #2 and #3 that they only ever glance at attention_reason on the kanban card and never open the record, kill #1 entirely. Don't build it speculatively.

## 2. Architecture

### Project structure inside `launchpad-integration/`

```
launchpad-integration/
├── hsproject.json                       (platformVersion 2026.03 — already set)
├── src/
│   └── app/
│       ├── app-hsmeta.json              (existing — needs permittedUrls additions, §5)
│       ├── webhooks/
│       │   └── webhooks-hsmeta.json     (unchanged)
│       ├── cards/                       ← NEW directory
│       │   ├── stripe-card-hsmeta.json
│       │   ├── StripeCard.jsx
│       │   ├── engagement-card-hsmeta.json
│       │   ├── EngagementCard.jsx
│       │   ├── bi-ticket-card-hsmeta.json
│       │   └── BiTicketCard.jsx
│       └── functions/                   ← NEW (only if backend-fronting is needed; see auth model §5)
```

- Cards live in `src/app/cards/` (flat directory)
- Each card has a paired `*-hsmeta.json` (config) + `*.jsx` (component)
- `uid` field must be unique within the project; type = `"card"`

### HubSpot SDK packages

```
@hubspot/ui-extensions           ^0.x   // <Text>, <Tile>, <Flex>, <Button>, etc
@hubspot/ui-extensions/crm       built-in  // CrmActionButton, CrmStageTracker
```

Components allowed in cards: only `@hubspot/ui-extensions` exports. No plain HTML/CSS, no `window`, no `window.fetch`. Network calls go through `hubspot.fetch` against allowlisted FQDNs declared in `app-hsmeta.json` → `config.permittedUrls.fetch`.

### Auth flow

The app is `distribution: "private"`, `auth.type: "static"`. The static token is HubSpot-side; we don't bring it into our cards.

The card-side `hubspot.fetch()` call gets two things automatically when targeting an LP-hosted URL:
1. The viewing user's HubSpot identity (portal ID, user ID, email) is included via headers HubSpot injects.
2. If `CLIENT_SECRET` is set on the app, requests are **signed** with HMAC headers — same scheme the webhook receiver should validate.

For HubSpot API calls FROM the card (e.g. reading another property the card needs), we do NOT need our static token — the card runs in HubSpot's environment and can talk to `https://api.hubapi.com` using the user's session. The `@hubspot/ui-extensions/crm` components hand us the current record's properties without an API call at all.

### Server cards vs client cards

UI Extension cards are React components rendered on the HubSpot record page. There's no "server card" type — but a card can:

- (a) **Read passively from the record's properties.** The `context` passed to the card includes the current Contact/Ticket and pre-fetched properties. No network call needed.
- (b) **Call an LP-hosted endpoint** via `hubspot.fetch(LP_URL)` to get fresh data.
- (c) **Call HubSpot's own APIs** (`api.hubapi.com`) via `hubspot.fetch` to fetch additional HS data.

| Card | Primary data path |
|---|---|
| #1 Stripe + subscription | Mostly (b) — Stripe Customer ID is read from the HS Contact property (a) as the key, then card calls LP-hosted `/api/cards/stripe-summary?stripeCustomerId=...` |
| #2 Rejig engagement | Mostly (a) — all the `rejig_*` properties already live on the Contact, written by BI cron. |
| #3 Ticket BI outputs | (a) only — `rejig_attention_reason`, `rejig_attention_set_at`, `rejig_recommended_action`, `rejig_recommended_action_urgency`, `rejig_recommended_action_set_at` are all on the Ticket. |

### App-functions: not needed for v1

Platform 2026.03 with `distribution: private` supports `app-function` components (serverless functions hosted inside HubSpot). LP already has Next.js routes; adding `/api/cards/*` endpoints there is consistent with the orchestrator pattern. Revisit `app-function` only if Vercel cold-start latency on `/api/cards/*` becomes a card-UX problem.

## 3. Per-card spec

### Card #1 — Contact: Stripe + Subscription

**Audience:** anyone at Rejig viewing a Contact — CSM checking why renewal hasn't auto-charged, sales rep verifying which product, support diagnosing payment.

**Where it appears:** Contact record middle column.

**Fields:**

| Field | Source | Freshness |
|---|---|---|
| Stripe Customer ID (linkable) | HS Contact property `stripe_customer_id` (a) | Real-time write — LP sets on Stripe customer create |
| Stripe Customer (dashboard link) | Derived: `https://dashboard.stripe.com/customers/{id}` | n/a — link |
| Subscriptions (one row per product) | LP backend (b) — `/api/cards/stripe-summary?contactId=...` returns the customer's `customer_subscriptions` rows (Core / Voice / Avatar) | Live read from LP DB |
| ─ Plan name | `customer_subscriptions.product` + `customers.selectedPlanName` | Same |
| ─ Status | `customer_subscriptions.status` | Same |
| ─ Started at | `customer_subscriptions.startedAt` | Same |
| ─ Next renewal date | NOT in LP DB — endpoint hits Stripe live: `subscription.current_period_end` | Real-time |
| ─ MRR | `customer_subscriptions.mrr` | Same |
| Last invoice status | NOT in LP DB — endpoint hits Stripe: `invoices.list({ customer, limit: 1 })` | Real-time |

**Why some fields are live-Stripe-not-LP-DB:** the LP `customer_subscriptions` table mirrors *subscription status* but not period-end or per-invoice state. For a card the CSM opens at the moment of confusion, one live Stripe call is the right answer. On Stripe timeout (5s), render the LP-DB values and a "Couldn't reach Stripe" note.

**Wireframe:**

```
┌─ Stripe & Subscriptions ──────────────────────── [Refresh] ┐
│                                                             │
│  Stripe customer:  cus_NXrV9k8…       [↗ Open in Stripe]   │
│                                                             │
│  ─ Core (Rejig Pro Monthly) ──────────────────────────────  │
│    Status:         Active                                   │
│    MRR:            $97.00                                   │
│    Started:        2025-11-12                               │
│    Next renewal:   2026-05-21  (7 days)                     │
│    Last invoice:   Paid — 2026-04-21  [↗ View invoice]      │
│                                                             │
│  ─ Voice (Voice Add-on Monthly) ───────────────────────────  │
│    Status:         Past due  ⚠                              │
│    MRR:            $29.00                                   │
│    Next renewal:   2026-05-14  (today)                      │
│    Last invoice:   Open — 2026-05-14  [↗ View invoice]      │
│                                                             │
│  ─ Avatar ─ (not subscribed)                                │
│                                                             │
│  [Open Customer in LP admin]                                │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Action buttons:**
- **Refresh** — re-runs the card's fetch.
- **Open in Stripe** — `https://dashboard.stripe.com/customers/{cus_id}` in new tab.
- **View invoice** (per row) — opens Stripe-hosted `invoice.hosted_invoice_url`.
- **Open Customer in LP admin** — `https://launchpad-indol-ten.vercel.app/admin/{customerId}` via `launchpad_customer_id` HS property.

**Stale-data handling:**
- Card hero shows "Live Stripe data fetched at HH:MM:SS".
- On Stripe timeout (5s), falls back to LP-DB values + banner.
- No caching beyond the per-render fetch.

---

### Card #2 — Contact: Rejig Engagement

**Audience:** anyone glancing at the Contact. The "what is this customer like as a Rejig user" block.

**Fields:** all from HS Contact properties already written weekly by the BI cron. No backend call required for v1.

| Field | Source property | Notes |
|---|---|---|
| Engagement profile | `rejig_engagement_profile` | One of 17 enum values from `EngagementProfile`. Card translates to human label + color hint. |
| Predicted outcome | `rejig_predicted_outcome` | One of 6 values. Color: green → orange → red. |
| Posting trajectory | `rejig_posting_trajectory` | One of 9 values; empty means insufficient data. |
| Last login | `rejig_last_login` | ISO datetime; render as relative + absolute. |
| Days since last post | `rejig_days_since_last_post` | Number. |
| Days until expiry | `rejig_days_until_expiry` | Number. Render as "Renews in N days" or "Expired N days ago". |
| Brokerage channel | `rejig_brokerage_channel` | Existing property. |
| No-show count | `onboarding_no_show_count` | Existing property; if `> 0`, surface prominently. |
| LP customer ID | `launchpad_customer_id` | Used as key for the "Open in LP admin" button. |

**Added value beyond just listing properties:**
- **"BI last evaluated"** timestamp — derive from `rejig_recommended_action_set_at` on associated Ticket.
- **Profile + outcome interpretation row.** Map `power_user_declining + likely_churn_in_30d` to "Was an active user, dropping off fast."
- **Color hint** on the whole card border: green if likely_renew, orange if intervention, red if churn predicted.

**Wireframe:**

```
┌─ Rejig Engagement ─────────────────────────────────────────┐
│                                                             │
│  [Channel: B2B - Keyes]                                     │
│                                                             │
│  Profile:          Power user, declining        🟠          │
│  Predicted:        Likely to churn in 30d       🔴          │
│  Trajectory:       Declining (4 weeks)                      │
│                                                             │
│  ─ Activity ────────────────────────────────────────────── │
│    Last login:         3 days ago    (2026-05-11)           │
│    Last post:          17 days ago                          │
│    Days until expiry:  41 days                              │
│    No-shows so far:    1                                    │
│                                                             │
│  ─ BI says: ───────────────────────────────────────────────│
│    Was an active user; post velocity dropped 60% over last │
│    4 weekly snapshots. Renewal is approaching.              │
│                                                             │
│  BI last evaluated: Mon 2026-05-12 11:08 UTC                │
│                                                             │
│  [Open Customer in LP admin]   [View signals (LP admin)]    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Action buttons:**
- **Open Customer in LP admin** — direct link.
- **View signals (LP admin)** — `/admin/{customerId}/signals` (TBD).
- **(Future)** "Re-run BI for this customer" — not in v1.

---

### Card #3 — Ticket: BI outputs (attention + recommended action)

**Audience:** CSMs working the Customer Journey Stages ticket queue.

**Where it appears:** Ticket record middle column. Renders on any ticket — empty states are fine.

**Fields:**

| Field | Source property | Notes |
|---|---|---|
| Pipeline stage | `hs_pipeline_stage` (a) | Color-coded by severity. |
| Attention reason | `rejig_attention_reason` | One of the 10 enum values. Human label + tooltip. |
| Attention set at | `rejig_attention_set_at` | Datetime; render as "Set 4 days ago" + absolute. |
| Recommended action | `rejig_recommended_action` | The `contentSummary` string from `action-library.ts`. |
| Action urgency | `rejig_recommended_action_urgency` | `today` / `this_week` / `monitor` — color hint. |
| Action set at | `rejig_recommended_action_set_at` | Freshness indicator. |
| Onboarding stage history (v1.1) | LP backend (b): `/api/cards/state-transitions?ticketId=...` | Live. |

**Wireframe (active attention case):**

```
┌─ Rejig BI: Why this ticket needs attention ────────────────┐
│                                                             │
│  Stage:           At Risk  🟠                                │
│  Reason:          Engagement drop, last 30 days             │
│  Since:           4 days ago  (2026-05-10 09:32 UTC)        │
│                                                             │
│  ─ Recommended action ─────────────────────────────────────│
│  URGENCY:  TODAY  🔴                                        │
│                                                             │
│  CSM personal call THIS WEEK; root-cause discovery         │
│  (forgot / hard / value)                                   │
│                                                             │
│  Set: 2 days ago  (2026-05-12 11:08 UTC)                    │
│                                                             │
│  ─ Recent stage history ───────────────────────────────────│
│    2026-05-10  Watch → At Risk        (lp_bi)               │
│    2026-04-29  Active → Watch         (lp_bi)               │
│    2026-04-15  Onboarding → Active    (hubspot_workflow)    │
│                                                             │
│  [Open Customer in LP admin]                                │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## 4. Gap analysis

### Deferred (2026-05-15): surfacing richer Rejig fields on Card #2

**Decision:** wait. Do not surface additional Rejig-API fields on the Engagement card (`listing_count`, `total_published_posts`, `video_posts`, `image_posts`, `content_type_breakdown`, `subscription_status`) until **Phase 9 (live Rejig API cron) is built**.

**Why deferred:**
- The data IS persisted in `customer_usage_signals` (via `src/lib/integrations/rejig/client.ts` + the 2026-05-11 Phase 5 snapshot import).
- BUT the live refresh cron isn't built yet. Surfacing numbers like "Total posts: 47" while the underlying data is a weeks-old snapshot misleads CSMs — they read it as live.
- Also outstanding: the card has no freshness indicator yet (no "Rejig data as of {date}" line). Until the snapshot/cron freshness is visible, adding more numeric fields amplifies the staleness problem.

**Pickup criteria — do all three when Phase 9 lands:**
1. Add "Rejig data as of {date}" line to `EngagementCard.jsx` sourced from the latest `customer_usage_signals.observedAt` for the contact's Rejig signals (not `rejig_recommended_action_set_at` — that's BI cron evaluation time, not data freshness).
2. Add 4 HS Contact properties via `setup-hubspot-properties.ts` + bootstrap rerun: `rejig_listing_count`, `rejig_total_posts`, `rejig_video_posts`, `rejig_image_posts`. BI cron writes them on its weekly run.
3. Surface in card as `Statistics` components (big-number style), not label/value rows.

**Out of scope when picked up:** `content_type_breakdown` (jsonb, doesn't model as a flat HS property) and `subscription_status` (lives in Stripe — belongs on Card #1). Save those for the LP-endpoint pattern in §5(b).

---

What the cards want that we don't currently capture / push to HS:

| Card | Gap | Recommended fix |
|---|---|---|
| #1 Stripe | `next_renewal_date` per subscription | Don't add HS property. Pull live from Stripe in `/api/cards/stripe-summary`. |
| #1 Stripe | Last invoice status + hosted URL per sub | Same — live from Stripe. |
| #1 Stripe | `customer_subscriptions` not surfaced to HS today | New LP endpoint `/api/cards/stripe-summary?contactId=...` joins HS `launchpad_customer_id` → LP `customer_subscriptions` → Stripe live. |
| #2 Engagement | Predicted-outcome reasoning string | v1: skip. v1.1: LP-fetch latest `customer_state_transitions.payload`. |
| #2 Engagement | Plain-English summary | Derive client-side in the card. |
| #2 Engagement | Total posts / video posts / image posts | v1: skip. v1.1: add `rejig_total_posts` + `rejig_video_posts` HS properties (cheap; BI cron has values). |
| #3 Ticket BI | Onboarding stage history | v1: skip. v1.1: LP-fetch `/api/cards/state-transitions`. |

## 5. Auth model

Two patterns for backend-needing cards:

### (a) Use HubSpot session — card calls `api.hubapi.com` directly
Works when all data is HS-native. Cards #2 and #3 fully — all data is HS properties.

### (b) Card calls LP-hosted endpoint
Needed for Card #1's live Stripe pull and v1.1 stage-history.

**Recommended auth pattern: HubSpot request-signing via `CLIENT_SECRET`.**

1. The app config in HubSpot has a `CLIENT_SECRET` env. Same value is added to LP's Vercel env as `HUBSPOT_CARD_CLIENT_SECRET`.
2. When the card calls `hubspot.fetch('https://launchpad-indol-ten.vercel.app/api/cards/stripe-summary?...')`, HubSpot injects request-signing headers:
   - `X-HubSpot-Signature-v3`: HMAC-SHA256 keyed by the shared secret
   - `X-HubSpot-Request-Timestamp`
   - `X-HubSpot-Source-App-Id`
   - User identity headers (portal ID + viewing user)
3. LP-side handler at `/api/cards/*`:
   - Verifies signature against `HUBSPOT_CARD_CLIENT_SECRET`
   - Verifies timestamp within 5 minutes
   - Verifies `X-HubSpot-Portal-Id` matches Rejig's portal ID (`44956899`)
   - Proceeds.

**Why this over a shared bearer token:**
- Shared token would be a static value the card carries, embedded in client-side code.
- Request signing is what HubSpot's local dev story already supports.
- Same primitive LP's webhook receiver should use.

### `app-hsmeta.json` changes

```json
{
  "config": {
    "permittedUrls": {
      "fetch": [
        "https://api.hubapi.com",
        "https://launchpad-indol-ten.vercel.app"   // NEW
      ]
    }
  }
}
```

LP `.env` additions:
```
HUBSPOT_CARD_CLIENT_SECRET=<copied from HubSpot app settings>
```

## 6. Effort estimate

| Card | Build hrs | Notes |
|---|---|---|
| #2 Rejig engagement | 4-6h | Pure render. Map 17 profile + 6 outcome + 9 trajectory codes to display labels + colors. |
| #3 Ticket BI | 3-5h | Smaller — fewer enum mappings. Empty-state for Active tickets. |
| #1 Stripe + sub | 8-12h | Card JSX (3h) + LP endpoint (3-4h) + auth gate helper (2h) + smoke test (2h). |

Total: ~2 days for #2 + #3 (recommended v1 scope). Add ~1.5 days for #1.

### Deploy steps

1. **Local dev:** `cd launchpad-integration && CLIENT_SECRET="<secret>" hs project dev`
2. **`local.json`** to proxy `https://launchpad-indol-ten.vercel.app` → `http://localhost:3000` during local dev.
3. **Upload to production:** `hs project upload` then `hs project deploy`.
4. **Add card to record page layout:** HubSpot UI → Settings → Objects → Contacts/Tickets → Record customization → drag the card onto the column. One-time per object per card.

### Risks

1. **`hubspot.fetch` allowlist + CSP behavior.** Missing `permittedUrls.fetch` fails silently with CSP error. Test in `hs project dev` first.
2. **Request-signing edge cases.** First time wiring HMAC verify on LP side — webhook receiver doesn't HMAC-verify currently. Worth tackling both at once.
3. **Stripe API timeouts.** 5-second `AbortController` timeout; fallback to LP-DB on slow.
4. **Property additions for v1.1.** Each new HS property requires bootstrap-script update + re-run.
5. **Card placement isn't versioned.** Step 4 is manual portal config. Add to deploy checklist.

### Suggested sequencing

1. Day 1: scaffold `src/app/cards/` + smoke-deploy a "Hello" card.
2. Day 1-2: Card #2 (engagement).
3. Day 2-3: Card #3 (ticket BI).
4. Day 3-4: drag both cards onto layouts; observe for 1 week.
5. Week 2 (if positive): Card #1 (Stripe) + LP endpoint + signing verifier.
6. v1.1: stage-history fetch, total-posts properties.

### Out of scope

- Building LP admin pages the cards link to.
- Mirroring `customer_state_transitions` into HubSpot as Custom Timeline Events.
- Per-CSM card customization.
- Multi-currency / international Stripe.
- A 4th card.
