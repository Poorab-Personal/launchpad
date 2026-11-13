# Rejig Account Sync + Structured Brand Kit

Status: DRAFT — plan only, no code. Written 2026-11-12.

## Problem

The `Create Customer Account` task today is copy-paste. The Account Creator opens
the customer in `/workspace`, copies each intake field out of the "Intake Form
Details" panel, and pastes it into Rejig's admin. Brand-kit details are worse:
the designer posts them into Internal Notes as free text and screenshots
(palette hex codes, "Luxury Account", footer label, logo variants), and the
Account Creator re-keys them.

Rejig now exposes a staging endpoint. LaunchPad POSTs one customer as JSON;
Rejig holds it in a temporary table; the Account Creator opens it in Rejig's
"Create Account (New)" screen, adjusts anything, and clicks Create Account
there. Rejig copies the image URLs at create time.

## Scope

1. **Structured brand kit** filled by the designer during `Create Designs`
   (replaces the Internal Notes screenshots).
2. **Sync to Rejig Dev / Sync to Rejig Prod** buttons for the Account Creator
   (and Admin) on the `Create Customer Account` task.
3. **Agent first / last name** resolution, since LaunchPad only stores `name`.

Out of scope: syncing anything back from Rejig. Rejig will not call us back. The
Account Creator still clicks **Mark Account Created** after creating the account
in Rejig (that also sends the customer the credentials email downstream).

## Decisions already made (with the user, 2026-11-12)

| # | Decision |
|---|---|
| D1 | Brand kit lives **per customer**, filled by the designer. No brokerage-level defaults for now — designers almost always upload right-sized logos, and agent logos are often combined with the brokerage logo. |
| D2 | Designer owns: logos, palette, logo selection, team logo selection, fonts, toggles, logo sizes, `account_type`, `footer_label`, `affiliation`, search tags. Account Creator presses Sync, and can also edit the kit to fix it up before syncing (decided 2026-11-12). |
| D3 | `account_type` is designer-entered. LaunchPad does not know it: `customers.product_tier` (Premium/Luxury enum) exists but is NULL on all 964 customers, and plan names don't encode a tier. We reuse `product_tier` rather than add a column. |
| D4 | **Block `Create Designs` completion until the brand kit's required fields are filled** (applies to D2C too). Empty data must not be pushed. |
| D5 | Sync does NOT complete any task. Mark Account Created stays manual. |
| D6 | Both roles (Account Creator, Admin) see both buttons. Prod requires an explicit confirm. |
| D7 | Prod LaunchPad customers are pushed to **Rejig Dev** for testing. Data is low-PII; accepted. |
| D8 | `source_customer_id` = LaunchPad `customers.id` (UUID), same in both environments. |
| D9 | Names: **no backfill**. Existing customers already have Rejig accounts. Resolve at sync time; expose editable First/Last fields to the Account Creator, flagged red when the value was guessed. |
| D10 | Affiliation + font option lists come from Rejig endpoints (not yet built). Stub them until then. Values are identical in Rejig dev and prod. |
| D11 | Free-text fields (`topics`, `monthly_market_reports`, `neighborhood_news`, `hashtags`) go as **strings**. |
| D12 | Logo "use dark / use light" checkboxes are not needed — presence of the URL is enough. |

## JSON payload

Endpoint: `POST {BASE}/onboarding/source/customers`, header `X-Service-API-Key`.
Dev base: `https://devapi.rejig.ai`. Prod base: TBD (likely `https://api.rejig.ai`).

Responses: `200 {success, data:{customer_id, domain, outcome}}`;
`409 CUSTOMER_LOCKED` (account already created in Rejig — corrections happen in
Rejig); `409 DOMAIN_ALREADY_EXISTS`; `400 VALIDATION_ERROR` (missing/invalid
`website`); `401` bad key.

### Field mapping

Source legend: **C** = existing customer column, **R** = brokerage_roster,
**B** = brokerages row, **K** = new brand kit (designer), **S** = sync panel
(Account Creator).

| JSON field | Source | Notes |
|---|---|---|
| `source_customer_id` | C `id` | D8 |
| `first_name`, `last_name` | S → R → split(`name`) | See "Names" |
| `business_name` | C `businessName` | fallback `name` |
| `website` | C `website` | **required by Rejig** — sync blocked if empty |
| `phone` | C `phone` | |
| `business_address` | C `businessAddress` | |
| `signin_email` | C `contactEmail` | |
| `platform_email` | C `platformEmail` | |
| `other_emails` | C `otherEmails` | text → array (split on comma/newline); null if empty |
| `license_number` | C `licenseNumber` | |
| `managed_by` | C `serviceOption` | `Self-Managed` → `"Agent (self-managed)"`; `Brokerage-Managed` → `"{brokerage short_name} Marketing Team"`; null when unset. Confirm strings with Rejig. |
| `mls_ids` | C `mlsIds` | |
| `bio` | C `bio` | |
| `monthly_market_reports` | C `serviceAreas` | string (D11) |
| `neighborhood_news` | C `localContentAreas` | string |
| `topics` | C `topics` | string |
| `hashtags` | C `hashtags` | string |
| `review_sources` | C `reviewSources` | array → labels joined `", "` |
| `google_business_name` | C `gmbName` | |
| `google_place_id` | — | null (Rejig resolves in its Reviews panel) |
| `zillow` | C `zillowProfile` | |
| `customer_type` | C `type` | `"B2B"` / `"D2C"` |
| `associated_brokerage` | B `rejig_broker_id` | Rejig's broker id (`keyes`, `baird`). null for D2C. `broker` is not sent (Rejig is removing it). |
| `account_type` | K → C `productTier` | D3 |
| `industry` | constant `"Realtor"` | All current customers are agents. |
| `footer_label` | K | Designer text, e.g. `Keyes-Kristi-Dye-Footer`. It is a body field (the "endpoint" in Riccardo's screenshot is the same POST). |
| `affiliation` | K | from Rejig affiliation list (stubbed) |
| `other_affiliation` | K | free text, optional |
| `blog_page_url` | — | null for now (brokerage-level later if wanted) |
| `image_custom_search_tags` | K | string[]; free-text chips until Rejig confirms (open Q2) |
| `video_custom_search_tags` | K | string[] |
| `pick_specific_to_search_tag` | — | null — Rejig's "enforce narrow search tag" lives in their create panel |
| `generate_brand_template` | — | null |
| `profile_image_url` | C `agentPhoto[0].url` | |
| `logo_url` | K primary logo | |
| `logo_black_url` | K black logo (for light backgrounds) | |
| `logo_white_url` | K white logo (for dark backgrounds) | |
| `domain_color_palette` | K | exactly 5 hex strings |
| `derived_logos` | K | 5 × `logo` \| `logo_black` \| `logo_white`, one per palette slot |
| `font` | K | 3 × `{type, font, line_height}`; omit/null when custom font off |
| `brand_logo_sizes` | K | `{facebook_square, instagram}` default 100/100 (Rejig's UI defaults) |
| `team_logo_sizes` | K | same shape |

### New fields LaunchPad will send — Rejig needs to add

```json
"apply_custom_font": true,
"apply_fixed_logo_height": false,
"team_derived_logos": ["logo_white", "logo", "logo_black", "logo", "logo_black"]
```

`team_derived_logos` mirrors `derived_logos` for Rejig's "Team Logo Selection" row.

## Names

LaunchPad stores only `name`, and for teams it's the business ("The Zeuner Team"),
not the agent ("Shari Zeuner"). `brokerage_roster.first_name/last_name` (from
DMG) is the reliable source for roster-linked B2B customers.

Resolution at sync-panel render, in order:
1. `customers.first_name/last_name` if set (Account Creator edited earlier)
2. `brokerage_roster` row where `customer_id = customer.id`
3. Split `name` on first whitespace — **flagged red: "Guessed from name, please check"**

The fields are editable in the sync panel. On sync, whatever was sent is
persisted to two new nullable columns `customers.first_name/last_name` so a
re-sync doesn't make them retype. No backfill (D9).

## Brand kit

### Storage

One nullable `customers.brand_kit jsonb` (CHECK: object), validated by a
hand-written validator in `src/lib/brand-kit.ts` (zod is only a transitive
dependency — don't lean on it), plus reuse of `customers.product_tier` for
account type. Saves accept partial data (draft); completeness is computed on
read by a pure `brandKitMissing(brandKit, productTier): string[]`. Rationale: it mirrors an external contract, is read and written as a
unit, and is never filtered on. Images are Vercel Blob objects in the same
`{url, filename, size, contentType}` shape as other attachments.

```ts
type BrandKit = {
  logos: { primary?: Attachment; black?: Attachment; white?: Attachment };
  palette: string[];                  // 5 hex
  logoSelection: LogoVariant[];       // 5
  teamLogoSelection: LogoVariant[];   // 5
  applyFixedLogoHeight: boolean;
  applyCustomFont: boolean;
  fonts: { primary?: FontPick; secondary?: FontPick; tertiary?: FontPick };
  brandLogoSizes: { facebookSquare: number; instagram: number };
  teamLogoSizes:  { facebookSquare: number; instagram: number };
  footerLabel: string;
  affiliation: { value: string; label: string } | null;
  otherAffiliation: string;
  imageSearchTags: string[];
  videoSearchTags: string[];
  updatedAt: string; updatedBy: string;
};
type LogoVariant = 'logo' | 'logo_black' | 'logo_white';
type FontPick = { value: string; label: string; lineHeight: number };
```

Affiliation/font store `{value, label}` so we survive whether Rejig turns out
to key on id or name.

### Required for Create Designs completion (D4) and for Sync

- Primary logo
- 5 palette colours + 5 logo selections + 5 team logo selections
- Account type
- Footer label
- Affiliation
- If Apply Custom Font = yes → all three fonts + line heights

Optional: black / white logos, other affiliation, search tags, sizes (default 100).

Confirmed by the user 2026-11-12: black and white logos stay optional.

### Designer UI

New "Brand Kit" card on `/workspace/customers/[id]`, laid out like Rejig's
Manage Brand screen so the designer sees the same thing the Account Creator
will: three logo tiles (Primary / Black / White), Primary Theme palette with
a hex input + swatch per slot and a logo dropdown beneath each, Team Logo
Selection row, Apply Fixed Logo Height toggle, Brand Fonts with toggle,
font dropdowns and line heights, Brand / Team Logo Sizes, then Account type,
Footer label, Affiliation, Search tags.

Editable by Designer, Senior Designer, Account Creator and Admin at any time
(D2C revisions can change it later). Read-only for everyone else.

Placement and modes (agreed 2026-11-12 from a preview): the card sits between
"Sent to Customer" and "Intake Form Details". It opens as the full editor only
when the viewer can edit and the kit is incomplete; otherwise it shows a
compact summary (logos, palette with each chosen logo, fonts, account fields)
with an Edit button for editors. The `Create Designs` action panel
shows a completeness checklist and disables Upload & Mark Complete until it's
complete.

Logo uploads get their **own** sign route,
`src/app/api/workspace/brand-kit/sign/route.ts`, modelled on
`notes/sign` (authorised per customer, not per task). Do NOT reuse
`design-proof/sign`: it requires an assigned Active task (the card must be
editable any time), allows PDFs, and its finalize sibling appends to
`designDrafts` and completes the task.

- Content types: png / jpeg / webp only (SVG only if Rejig confirms it can copy it).
- Path prefix `brand-kit/{customerId}/`.
- Persisted by a `saveBrandKitLogo` server action → db.ts helper that asserts
  the URL host ends in `.public.blob.vercel-storage.com` (Rejig fetches
  whatever we send) and writes `jsonb_set(brand_kit, '{logos,<slot>}', …)`.
- The form save merges every field **except** `logos` (top-level `||`), so a
  form save after an upload can't clobber a logo.

### Where the D4 gate lives

Create Designs can be completed four ways: the design-proof finalize route,
the `markTaskComplete` server action, the **unauthenticated**
`PATCH /api/tasks/[taskId]` (portal uses it), and any direct
`updateTaskStatus` caller. So the gate is a backstop **inside
`updateTaskFields` and `updateTaskStatus`** in `src/lib/db.ts`: when status
becomes `Completed` and the task is `Create Designs`, check
`brandKitMissing()` and throw `TaskCompletionBlockedError(missing)`. Callers
map it to 409 / `{ok:false}`. A single constant turns the gate on (P4 is a
one-line change).

The design-proof finalize route must **also** check up front, before writing
`designDrafts` — otherwise drafts land, completion throws, and each retry
re-appends them.

Revise Design rounds are **not** gated: the kit was already gated at Create
Designs, and the sync pre-flight is the final backstop. (Verified: all six
live workflows have a Create Designs task.)

### Option lists (live, 2026-11-12)

`src/lib/integrations/rejig/options.ts` reads Rejig's lists, from prod when
`REJIG_ONBOARDING_PROD_API_KEY` is set (else dev), cached one day:

- Affiliations: `GET /rejig-auth/industries`. Only affiliations whose
  `industrie_id` is the `Realtor` industry; stored and sent by **name**
  (Rejig maps it to its id).
- Fonts: `GET /generator/get_font_list`. One row per weight/style, collapsed
  to one option per **`fontFamily`**, which is what's sent.

Both pickers are searchable and only fetched for brand-kit editors. A failed
fetch isn't cached; the card says the list couldn't load.

### Brokerage id

`brokerages.rejig_broker_id` (migration 0029) is sent as
`associated_brokerage` (Rejig is removing the `broker` field): a text
slug that is the same in Rejig dev and prod (`keyes`, `baird`, `ipre`, `ruhl`,
`coach`). We pick it for a new brokerage and send it to Rejig. NULL blocks the
sync for that brokerage's agents.

## Sync

### Security

- **Keys in env, URLs in code.** Base URLs are hardcoded constants (the
  existing Rejig client records a doubled-path 404 from putting a URL in env).
  Env vars, server-only: `REJIG_ONBOARDING_DEV_API_KEY` (Production + Preview +
  `.env.local`) and `REJIG_ONBOARDING_PROD_API_KEY` (**Production only** —
  Preview builds share the prod DB, so a branch build must never reach Rejig
  prod). Added by the user via `vercel env add`; never pasted in chat or
  committed.
- A server action does the POST. Role check reads the **DB**, not the
  session: `session.role` is `roles[0]` frozen at sign-in for 30 days, falls
  back to `'Account Creator'` for empty roles, and ignores `active`. So:
  `getTeamMemberById(session.memberId)` → require `active` and `roles`
  containing `Account Creator` or `Admin`. Same pattern for brand-kit writes
  (`Designer`, `Senior Designer`, `Admin`). No assignment check.
- Prod additionally refuses while view-as is active, and unless
  `process.env.VERCEL_ENV === 'production'`.
- Environment chosen server-side from an enum (`'dev' | 'prod'`). The client
  never sends a URL.
- **Prod is off until the key exists.** If `REJIG_ONBOARDING_PROD_API_KEY` is
  unset, the Prod button renders disabled ("Not configured"). The prod URL is
  still TBD, so P5 also needs a one-line code change — two locks.
- The sync panel is its **own card**, not inside `TaskActionPanel` (that only
  renders for the assignee's Active task). Shown when the effective role is
  Account Creator or Admin.
- `PATCH /api/customers/[id]` is unauthenticated (portal form uses it):
  **remove `productTier` from its `ALLOWED` list** (nothing in the portal sends
  it) and never add `brandKit`/`firstName`/`lastName` there.
- Rejig's `customer_id` response is a **staging** id — store it only in
  `rejig_sync_attempts`, never in `customers.rejig_user_id`.
- Prod confirm: modal that names the customer and makes them type `PROD`.
- 15s fetch timeout; response body truncated before logging; API key never
  logged.

### Audit

New table `rejig_sync_attempts`:
`id, customer_id FK (cascade), environment text CHECK IN ('dev','prod'),
outcome text (TS const: created|updated|locked|domain_exists|
validation_error|auth_error|network_error), http_status int, rejig_code text,
rejig_customer_id text, payload jsonb, response jsonb (truncated),
duration_ms int, actor_team_member_id FK (set null), created_at`. Index
`(customer_id, environment, created_at DESC)`. A row is written on every
attempt, including timeouts (`AbortSignal.timeout(15000)`). Client disables
the button while in flight. No server-side claim: a second push just updates
the staged record (verified against Rejig dev).

Name lookup uses `brokerage_roster WHERE customer_id = $1 AND deleted_at IS NULL
ORDER BY last_synced_at DESC LIMIT 1` (customer_id isn't unique); the
migration adds a partial index on it.

Full migration SQL: see "Migration 0028" below.

Plus an `events` row ("Synced to Rejig Prod — created") so it shows on the
customer timeline.

Panel shows the last sync per environment ("Dev: created 2h ago by Matt",
"Prod: never").

### Pre-flight

The sync panel lists missing required items (website, names, brand kit
completeness) and disables both buttons until they're resolved. Server
re-validates; client checks are only for display.

### Error copy

| Response | Shown |
|---|---|
| 200 | "Sent to Rejig {env}. Open Create Account (New) in Rejig to finish." |
| 409 CUSTOMER_LOCKED | "This account was already created in Rejig. Make changes in Rejig." |
| 409 DOMAIN_ALREADY_EXISTS | "Rejig already has an account for {website}." |
| 400 | Rejig's message verbatim |
| 401 | "Rejig rejected the API key — tell an admin." |

## Phases

Each phase is its own deploy. All on `main` (no branch needed: the tree is
clean, and prod is locked by a missing env var rather than by a branch).

| Phase | Ships | Live-system impact |
|---|---|---|
| P0 | This doc + architect review. Send Rejig the open questions + the 3 new fields. | none (doc commit stays local) |
| P1 | `src/lib/rejig-sync/payload.ts` (pure builder + validator) + vitest tests + `scripts/rejig-sync-preview.ts <customerId> [--send-dev]` | none — no UI. Lets us lock the contract against Rejig dev using real prod customers before building UI. |
| P2 | Migration: `brand_kit`, `first_name`, `last_name`, `rejig_sync_attempts`. Brand Kit card for designers, **non-blocking**. | Designers see a new card. Nothing gated yet. |
| P3 | Sync panel on `Create Customer Account`: names, pre-flight, Dev button, history. Prod button visible but disabled. | Account Creator gets the Dev button. |
| P4 | Flip D4: `Create Designs` requires a complete brand kit. | Behaviour change for designers — announce first; in-flight tasks are affected. |
| P5 | Real affiliation/font endpoints replace stubs (done with P3), `broker_id`; prod URL confirmed → Prod button live. | Prod pushes begin. |

P4 is separate from P2 so designers aren't blocked mid-task the day the card
appears. In P3, expect most customers to show the Dev button disabled by
pre-flight until designers have filled kits — say so when announcing.

**P2 deploy order:** run `npm run db:migrate` against prod **before** pushing
the P2 code. Drizzle names every schema column in its selects/inserts, so code
ahead of the DB breaks every customers query (seen before with
`design_feedback`). The migration is additive, so migrating first is safe.

**Consumers to update with the new columns:** `src/db/schema/customers.ts`,
new `src/db/schema/rejigSyncAttempts.ts` + `schema/index.ts` export,
`Customer` in `src/types/index.ts`, `mapDbCustomer` in `src/lib/db.ts`
(defensive parse), the full `Customer` fixture in
`tests/webhooks/stripe.test.ts` (else the build's typecheck fails),
CLAUDE.md data-model table, `docs/schema/production-schema.md`.

Commits: stage paths explicitly (the repo has many untracked docs/scripts);
never `git add -A`.

### Migration 0028 (draft)

```sql
ALTER TABLE "customers" ADD COLUMN "brand_kit" jsonb;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_brand_kit_is_object"
  CHECK ("brand_kit" IS NULL OR jsonb_typeof("brand_kit") = 'object');--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "first_name" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "last_name" text;--> statement-breakpoint
CREATE TABLE "rejig_sync_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "customer_id" uuid NOT NULL,
  "environment" text NOT NULL,
  "outcome" text NOT NULL,
  "http_status" integer,
  "rejig_code" text,
  "rejig_customer_id" text,
  "payload" jsonb NOT NULL,
  "response" jsonb,
  "duration_ms" integer,
  "actor_team_member_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "rejig_sync_attempts_environment_check" CHECK ("environment" IN ('dev', 'prod'))
);--> statement-breakpoint
ALTER TABLE "rejig_sync_attempts" ADD CONSTRAINT "rejig_sync_attempts_customer_id_customers_id_fk"
  FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "rejig_sync_attempts" ADD CONSTRAINT "rejig_sync_attempts_actor_team_member_id_team_members_id_fk"
  FOREIGN KEY ("actor_team_member_id") REFERENCES "public"."team_members"("id") ON DELETE set null;--> statement-breakpoint
CREATE INDEX "rsa_customer_env_created_idx" ON "rejig_sync_attempts" ("customer_id", "environment", "created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_brokerage_roster_customer_id" ON "brokerage_roster" ("customer_id") WHERE "customer_id" IS NOT NULL;
```

Journal: append `{ "idx": 28, "version": "7", "when": <now ms, > 0027's>,
"tag": "0028_rejig_account_sync", "breakpoints": true }`.

## Testing

LaunchPad isn't run locally (prod DB in `.env.local`, see memory). Plan:

1. **Unit** (vitest): payload builder against fixture customers — B2B
   roster-linked, B2B no-roster, D2C, brokerage-managed, empty optional fields,
   name-split flagging, `other_emails` splitting, `null` vs `""`.
2. **Contract** (P1 script, local → Rejig dev): build payloads for ~5 real
   customers (one per brokerage + one D2C), print them, then `--send-dev`.
   The script is strictly read-only on LaunchPad (no audit rows, no name
   writes), `--send-dev` is hardwired to the dev URL and never loads the prod
   key, and `--brand-kit fixture.json` supplies a kit (real kits don't exist
   until P2). `payload.ts` stays free of `server-only` imports so vitest and
   tsx can load it.
   Riccardo confirms they render correctly in Rejig's Create Account (New).
   Re-send one to observe the second-push behaviour.
3. **In-app** (after P3 deploy): Account Creator syncs a `/[slug]/test`
   customer to Rejig dev from prod LaunchPad.
4. Prod stays locked (no env var) until 1–3 are signed off.

## Open questions

For Rejig:
1. ~~Second push before account creation?~~ **Answered by test 2026-11-12:**
   HTTP 200, `outcome: "updated"`, same staging `customer_id`. Re-sync is a
   safe overwrite — no server-side claim needed, client in-flight disable only.
2. Search tags: free text, or do they need to match existing tags (their UI
   shows counts like `luxury (317)`)? If the latter, we need a tag-list endpoint.
3. Affiliation + font endpoints: ETA and response shape. Do they key on id or name?
4. Add `apply_custom_font`, `apply_fixed_logo_height`, `team_derived_logos`.
5. `brand_logo_sizes.instagram` — is that the "Instagram 4_5" field?
6. Exact expected strings for `managed_by`, `associated_brokerage`, `broker`.
7. ~~Prod base URL.~~ **Answered 2026-11-12:** same paths on `api.rejig.ai`.
8. ~~Brokerage id field.~~ `associated_brokerage` = broker id; `broker` removed.
9. ~~Affiliation / font value.~~ Affiliation name; font `fontFamily`. Realtor
   affiliations only.
10. Add Coach (`coach`) to the **dev** broker list — Rejig will add.

For the user: none open. Confirmed 2026-11-12 — the required set above stands
(black / white logos optional), and `industry` is always `"Realtor"`.

Env status: `REJIG_ONBOARDING_DEV_API_KEY` is in `.env.local`. A
`REJIG_ONBOARDING_DEV_URL` was also added there; per the review, code
hardcodes the dev URL and ignores it, and that var does not go to Vercel.
Vercel vars are added together with the prod key before P3/P5.
