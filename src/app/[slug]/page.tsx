/**
 * Brokerage landing page — bare top-level slug (e.g. /ipre, /keyes).
 *
 * Server component. Resolves the brokerage by `landing_page_slug` against an
 * allowlist (active brokerages only). Unknown slugs → notFound() so this
 * dynamic segment can't swallow 404s or shadow future top-level routes.
 * Next.js gives explicit segments (/admin, /workspace, /r, /signin, /auth,
 * /api) precedence over this catch dynamic segment regardless.
 *
 * Renders brokerage name + logo (master_logo_url if present) + the email /
 * hCaptcha verification form via the shared <LandingShell>.
 *
 * Per-brokerage branding lives in BROKERAGE_THEME (theme.ts) keyed by
 * landing_page_slug. Only brokerages with a wired palette get branded;
 * everyone else falls back to DEFAULT_THEME (neutral). To brand a new
 * brokerage, add a map entry — no other changes to this page or the form
 * are needed.
 *
 * The branded chrome is shared with the test-mode landing (/[slug]/test) via
 * <LandingShell> + theme.ts, so the two stay pixel-identical.
 *
 * See docs/integrations/dmg-roster-plan.md §4.2.
 */
import { notFound } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import * as schema from '@/db/schema';
import EmailForm from './EmailForm';
import LandingShell from './LandingShell';
import { themeForSlug } from './theme';

export const dynamic = 'force-dynamic';

export default async function BrokerageLandingPage(props: PageProps<'/[slug]'>) {
  const { slug: rawSlug } = await props.params;
  // Next.js 16 does NOT URL-decode dynamic route params. Slugs that contain
  // reserved characters (B&W lives at `/b&w` per memory `brokerage_landing_urls`,
  // which browsers send as `/b%26w`) need an explicit decode before any
  // DB / map lookup. Wrap in try/catch — a malformed sequence (e.g. `%ZZ`)
  // throws URIError; fall back to the raw form so the lookup just misses
  // and returns 404 instead of 500.
  let slug = rawSlug;
  try {
    slug = decodeURIComponent(rawSlug);
  } catch {
    /* fall through with raw slug */
  }

  const brokerage = await db.query.brokerages.findFirst({
    where: and(
      eq(schema.brokerages.landingPageSlug, slug),
      eq(schema.brokerages.active, true),
    ),
  });

  // Allowlist: only active brokerage slugs render. Everything else 404s.
  if (!brokerage) notFound();

  const theme = themeForSlug(slug);
  const siteKey = process.env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY ?? '';
  const tagline =
    brokerage.pricingTagline?.replace(/\{Name\}/g, brokerage.name) ?? '';

  return (
    <LandingShell
      slug={slug}
      brokerage={{
        name: brokerage.name,
        masterLogoUrl: brokerage.masterLogoUrl ?? null,
        tagline,
      }}
      theme={theme}
      form={<EmailForm slug={slug} siteKey={siteKey} theme={theme} />}
    />
  );
}
