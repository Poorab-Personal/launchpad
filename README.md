# LaunchPad

Rejig.ai's unified customer onboarding system. Replaces a stack of disconnected tools (HubSpot, Stripe, Calendly, email, Shortcut) with one Next.js + Postgres pipeline.

## Quick start

```bash
npm install
cp .env.example .env.local            # fill in real values
vercel env pull .env.local            # if linked to Vercel
npm run db:migrate                    # apply Drizzle migrations
npm run dev                           # http://localhost:3000
```

> ⚠️ **`.env.local` points at the production Neon database.** There is no local
> or staging DB. `npm run db:migrate`, `npm run db:studio` and every `scripts/`
> one-off write to real customer data. LaunchPad is not run locally in practice —
> changes are gated on `npm run build` and verified on the deploy via
> `/[slug]/test` (see `docs/plans/staging-environment.md`).

## Useful scripts

```bash
npm run dev                 # dev server (Turbopack)
npm run build               # production build
npm run lint                # ESLint
npm test                    # Vitest (Stripe webhook regression suite)

npm run db:test             # smoke: connect to Postgres + version()
npm run db:list             # tables + row counts + constraint summary
npm run db:generate         # BROKEN (stale snapshots + TTY prompt) — hand-author migrations instead
npm run db:migrate          # apply pending migrations
npm run db:studio           # Drizzle Studio (browse data)
```

## Docs

- `CLAUDE.md` — the codebase orientation. Read this first.
- `docs/architecture.md` — subsystems, data flow, automations
- `docs/schema/production-schema.md` — table-by-table reference
- `docs/flows/` — vetted onboarding flows. Start with `docs/flows/README.md`: it maps how the six workflows (D2C, Keyes, IPRE, BW, Coach, Ruhl) fork.
- `docs/plans/` — architecture plans (completed + pending)
- `docs/integrations/` — per-integration plans (DMG roster, engagement data, etc.)

## Deploy

`git push origin main` → Vercel auto-deploys via the GitHub integration. No CLI invocation needed.

## Stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind 4 · Drizzle ORM · Vercel Postgres (Neon) · Vercel Blob · Stripe · Resend · Vitest
