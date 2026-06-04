# Keyes + B&W onboarding plan

**Status:** Locked 2026-06-04. Ready to execute phase-by-phase.

## Context

Both Keyes and Baird & Warner are live brokerages today, served via the legacy Google Script redirect. We're bringing new signups for both onto LaunchPad. D2C + IPRE are already in production on LaunchPad and must not be disrupted.

## Decisions locked with product (2026-06-04)

| Q | Answer |
|---|---|
| Backfill existing Keyes/BW customers into LP? | No — going forward only. |
| B2B-Keyes + B2B-BW workflow templates exist in DB? | Yes, previously tested. Phase C is verify-not-create. |
| Use `?test=fill` for smoke autofill? | Yes (already enabled globally via `LAUNCHPAD_ENABLE_TEST_ENDPOINTS=1`). |
| Order of go-live? | Together — one Google Script redirect change covers both. |
| HS ticket-creation trigger? | Keyes: Capture Payment Method. BW: Confirm Your Information. |
| Stripe state for Keyes? | Live products already exist; user will provide IDs. Phase B becomes "verify + update `stripe_plans` to point at live IDs" — likely no Stripe-side product creation needed. |
| BW Stripe? | None — payment mode is `invoice` (brokerage master agreement). |

## Risk frame

**Low overall risk because Google Script still owns Keyes/BW traffic.** No live agent hits LaunchPad until the redirect flip in Phase I. D2C + IPRE stay running throughout.

What still matters:
- **Shared-code touchpoints in Phase F** (`intake-handler.ts`, `activate-dependents.ts`, `db.ts STUCK_WORKFLOW_KEYS`) affect D2C + IPRE codepaths. Build + smoke locally before push. Architect-review recommended.
- **No Stripe key changes** (`STRIPE_LIVE_SECRET_KEY` already covers all live workflows).
- **No webhook config changes** (IPRE's live endpoint already subscribes to all events from the same Rejig live Stripe account that Keyes uses).
- **Cutover is user-side**: editing the Google Script redirect. LaunchPad has no flip day.

## Brand data scraped from legacy LPs (2026-06-04)

For reference. Final brand assets (esp. real brokerage fonts) will be provided separately by product owner.

### Keyes — confirmed 2026-06-04 from official brand book
- **Logo:** `https://z0rxtnzxdkzzt5wn.public.blob.vercel-storage.com/brokerage-logos/keyes-primary.png` (uploaded; on `brokerages.keyes.master_logo_url`)
- **Palette (Primary):**
  - **Everglade Green** `#044439` — primary brand color (CMYK 98/45/74/49, PMS 3308 C)
  - **Miami Sands** `#F3D8BE` — warm secondary (CMYK 2/17/26/0, PMS 475 C)
  - **Delray Beach** `#F7F3E5` — brand cream bg (CMYK 2/3/10/0, PMS P1-2 C)
  - Surface `#ffffff` (forms/cards on top of the Delray Beach cream)
- **Typography:**
  - **Headline (brand):** "The Picnic Club" — but it's a paid Fontpath retail font, not worth licensing for the LP.
  - **Headline (chosen):** **Fraunces** (Google Fonts) — modern display serif with editorial character + strong italic. Closest free match to Picnic Club's energy. Wired via `<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,400;0,600;1,400&display=swap">`.
  - **Subhead:** Plus Jakarta Sans, semi-bold, ALL CAPS, 13% letterspace, 30+ pt. **Google Fonts** (free).
  - **Body:** Plus Jakarta Sans, regular/medium, sentence case, -1% letterspace, 120-150% line height. **Google Fonts.**
- **Copy (legacy LP — adapt to LandingShell.tsx COPY_BY_SLUG pattern):**
  - h1: "Let's Set Up Your Social Media"
  - Subhead: *"Keyes is teaming up with Rejig.ai to help you manage and automate your social media marketing."*
  - 4 bullets: Verify your Keyes email · Review and update your profile · Start your free trial · Schedule your onboarding call
  - Closer: "We'll create your account and guide you through everything during onboarding."
  - Footer: *"Powered by Keyes Real Estate & Rejig.ai"*

### Baird & Warner — confirmed 2026-06-04 from official brand book
- **Logo:** `https://z0rxtnzxdkzzt5wn.public.blob.vercel-storage.com/brokerage-logos/b&w-primary.webp` (uploaded; on `brokerages.bw.master_logo_url`)
- **Palette (Primary):**
  - **Deep Lake** `#192D6B` — primary navy (CMYK 77/58/0/58, RGB 25/45/107). **Note:** different from the legacy LP which used `#003747` — that was wrong. Use the official brand book value.
  - **Amber Wheat** `#DCAE1D` — signature golden accent. The brand's warm, midwestern hue.
  - Surface `#ffffff`, neutral bg (Limestone, Sky Blue, Patina Green available as secondary accents)
- **Typography:**
  - **Brand font:** "BW Bow Tie" — proprietary custom sans-serif; brand book reserves it for corporate-only use, NOT licensed for digital/web.
  - **Chosen for LP:** Plus Jakarta Sans (Google Fonts) — single sans-serif family for headlines + body. Matches B&W's "supportive sans-serif" digital guidance + their own legacy LP already used it. Consistent with Keyes body font (one less font fetch overall).
- **Copy (legacy LP — adapt to LandingShell.tsx COPY_BY_SLUG pattern):**
  - h1: "Let's Set Up Your Social Media"
  - Subhead: *"Baird & Warner is teaming up with Rejig.ai to help you manage and automate your social media marketing."*
  - 3 bullets (no payment): Verify your Baird & Warner email · Review and update your profile · Schedule Your Onboarding Call
  - Closer: "We'll create your account and guide you through everything during onboarding."
  - Footer: *"Powered by Baird & Warner & Rejig.ai"*

### LP differences from LP-on-LaunchPad (don't port)
- Old LP uses 6-digit email verification codes. LP uses **hCaptcha + straight-in** per `brokerage_landing_auth.md`. Skip the code flow.
- Old LP has a single h1 + bullets layout. LP uses richer `LandingShell` structure (4 bullets, co-brand lockup, formIntro). **Adapt to LP structure** rather than literal port — product preference.

## Inputs needed from product owner

Collect ALL upfront before starting Phase A:

### Keyes
- [ ] Keyes **HubSpot Deal ID** (master Deal record on the HS Company)
- [ ] DMG `client_id` + `client_secret`
- [ ] Live Stripe **product ID** + **two price IDs** (monthly + quarterly)
- [ ] Master logo URL (or file to upload to Vercel Blob)
- [ ] Brand assets: primary color, accent color, fonts (Google Fonts or web-safe), landing copy, pricing tagline (with `{shortName}` token)

### B&W
- [ ] B&W **HubSpot Deal ID**
- [ ] DMG `client_id` + `client_secret`
- [ ] Master logo URL (or file)
- [ ] Brand assets: colors, fonts, landing copy, pricing tagline (note: no payment, so no `{shortName} Monthly/Quarterly` template needed — but tagline still uses tokens)

## Phased to-do list

### Phase A — Pre-flight verification (no deploys)
- [ ] Live-key check Keyes existing `stripe_plans` rows (`price_1TJQ…`) via `stripe.prices.retrieve()` — confirm sandbox vs live
- [ ] Inspect `workflow_templates` rows for `B2B-Keyes` + `B2B-BW` — confirm complete + correct
- [ ] Confirm `brokerages.keyes` + `brokerages.bw` rows exist with `landing_page_slug` + `default_workflow_key` set
- [ ] Confirm `brokerages.hubspot_company_id` already populated for both (per pending todo #23, Company IDs were set; only Deal IDs pending)

### Phase B — Keyes Stripe `stripe_plans` swap
*(Likely simpler than IPRE was: user has the live IDs, no product creation needed.)*
- [ ] User provides live Keyes product + price IDs
- [ ] Write `scripts/flip-to-live-stripe-keyes.ts` (clone IPRE flip script, swap constants)
- [ ] Run flip script (refuses unless `sk_live_*`)
- [ ] Verify post-swap: `dump-all-stripe-plans.ts` shows Keyes rows as LIVE

### Phase C — Workflow templates verify
- [ ] Run a template-vs-flow-doc diff for B2B-Keyes against `docs/flows/b2b-keyes.md`
- [ ] Same for B2B-BW against `docs/flows/b2b-bw.md`
- [ ] Confirm `{shortName}` tokens (not literal names) in copy fields
- [ ] If drift exists, decide per `template_drift_intent.md` whether to fix or leave

### Phase D — DMG roster pull
- [ ] Add `DMG_KEYES_CLIENT_ID` + `_SECRET` + `DMG_BAIRD_WARNER_CLIENT_ID` + `_SECRET` to:
  - `.env.local`
  - Vercel **Production** scope
  - Vercel **Preview** scope (so preview deploys can test too)
- [ ] Patch `scripts/diagnose-dmg.ts` PREFIX_BY_SLUG to include both
- [ ] Force-run roster sync for each via the cron's manual trigger or a direct script
- [ ] Inspect roster quality: `scripts/diagnose-roster-email-dups.ts keyes` + same for `bw`. Flag any shared-email collisions like IPRE had (pending todo #18).

### Phase E — HubSpot wiring
- [ ] `UPDATE brokerages SET hubspot_deal_id = '<from-user>' WHERE landing_page_slug = 'keyes'`
- [ ] Same for `bw`
- [ ] Verify `rejig_brokerage_channel` HS Contact property has enum options `b2b_keyes` + `b2b_bw` (per checklist)
- [ ] Code patch: `CHANNEL_CODE_TO_HUBSPOT_ENUM` in `intake-handler.ts` (bundled into Phase F deploy)

### Phase F — Shared-path code patches (single PR, single deploy)
- [ ] `src/lib/automations/activate-dependents.ts` — add to `INTAKE_PUSH_TRIGGER_TASK`:
  - `'B2B-Keyes': 'Capture Payment Method'`
  - `'B2B-BW': 'Confirm Your Information'`
- [ ] `src/lib/db.ts` — add `'B2B-Keyes'` + `'B2B-BW'` to `STUCK_WORKFLOW_KEYS`
- [ ] `src/lib/integrations/hubspot/intake-handler.ts` — add to `CHANNEL_CODE_TO_HUBSPOT_ENUM`:
  - `Keyes: 'b2b_keyes'`
  - `BW: 'b2b_bw'`
- [ ] **Architect review** (Plan agent) of all three patches before commit, per `feedback_architect_review_cross_cutting.md`
- [ ] Local: `npm run build` + `npm test` + manual D2C + IPRE smoke (admin add → portal → walk a few steps to confirm no regression)
- [ ] Single commit, push to `main`

### Phase G — Landing page + branding
- [ ] Upload Keyes logo to Vercel Blob → `brokerages.master_logo_url`
- [ ] Same for BW
- [ ] Per-brokerage styling on `/keyes` and `/b&w` (palette, fonts, copy) — likely small additive changes to `app/[slug]/page.tsx`
- [ ] Verify auth flow per `brokerage_landing_auth.md` (email + hCaptcha → straight in)

### Phase H — Smoke test in prod via main path
Google Script still owns real Keyes/BW traffic. Hit `/keyes` and `/b&w` directly:

- [ ] **Keyes smoke:**
  - [ ] Visit `/keyes`, enter a roster-known email, land on portal
  - [ ] Confirm Info → Capture Payment (your real card)
  - [ ] Verify: HS ticket created on Capture Payment completion, ticket has Contact + Company + Deal associations, stripe_customer_id populated on LP row
  - [ ] Verify internal alerts: `notifyCustomerCreated` to poorab@, `notifyTaskAssigned` to Mansi for Account Creator tasks
  - [ ] Cancel the subscription in Stripe Dashboard, refund if needed
- [ ] **BW smoke:**
  - [ ] Visit `/b&w`, enter a roster-known email, land on portal
  - [ ] Confirm Info (no payment task) → verify HS ticket created at Confirm Info completion
  - [ ] Walk through Schedule Onboarding → confirm Calls record + customer.callDate populated
- [ ] **Purge** the test customers after via `scripts/purge-test-customers.ts` pattern

### Phase I — Cutover (your action; no LP deploy)
- [ ] Update Google Script redirect: Keyes domain → `https://onboarding.rejig.ai/keyes`
- [ ] Update Google Script redirect: BW domain → `https://onboarding.rejig.ai/b&w`
- [ ] Monitor 24h of signups via `notifyCustomerCreated` alerts in poorab@ inbox + HS Pipeline
- [ ] **Rollback:** revert the Google Script changes; LaunchPad needs zero changes.

## Verification matrix

After Phase I, confirm:

| Check | Keyes | BW |
|---|---|---|
| Roster pre-pop fills intake form | ✓ | ✓ |
| Capture Payment captures real card (not sandbox) | ✓ | n/a |
| HS ticket created at commitment task | ✓ | ✓ |
| HS Contact + Company + Deal all linked | ✓ | ✓ |
| Schedule Onboarding embed → Calls row | ✓ | ✓ |
| Mansi (Account Creator) gets assignee email | ✓ | ✓ |
| poorab@ gets "new customer" alert | ✓ | ✓ |
| BCC poorab@ on welcome/design-ready/credentials | n/a (B2B no welcome) | n/a |
| `/admin/stuck` surfaces stalled agents | ✓ | ✓ |

## Anti-patterns to avoid (from `brokerage_onboarding_checklist`)

- Don't store literal brokerage names in workflow_templates copy — always `{shortName}` tokens
- Don't name Stripe products after a cadence ("Keyes - Monthly") — generic product, cadence on prices
- Don't forget to update `STUCK_WORKFLOW_KEYS` — `/admin/stuck` silently misses stalled agents otherwise

## What's NOT in scope

- Backfilling existing Keyes/BW customers (locked: forward-only)
- Marketing copy / SEO / SEM on the landing pages (separate concern)
- Cancellation flow for Keyes agents who change their mind post-Capture Payment (already covered by Stripe's standard portal flow; not LP-specific)
