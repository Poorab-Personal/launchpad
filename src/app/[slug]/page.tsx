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
 * hCaptcha verification form.
 *
 * Per-brokerage branding lives in BROKERAGE_THEME keyed by landing_page_slug.
 * Only brokerages with a wired palette get branded; everyone else falls back
 * to DEFAULT_THEME (neutral). To brand a new brokerage, add a map entry — no
 * other changes to this page or the form are needed.
 *
 * See docs/integrations/dmg-roster-plan.md §4.2.
 */
import { notFound } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import * as schema from '@/db/schema';
import EmailForm, { type LandingTheme } from './EmailForm';

export const dynamic = 'force-dynamic';

// Neutral default — used by any brokerage without a branded palette wired.
const DEFAULT_THEME: LandingTheme = {
  bg: '#F7F4EB',
  surface: '#ffffff',
  primary: '#6C4AB6',
  primaryHover: '#5a3d9c',
  ink: '#1B2E35',
  accent: '#E0DEE4',
  serifHeadline: false,
};

// Per-brokerage palettes, keyed by landing_page_slug. Only IPRE is branded
// for now; Keyes / B&W stay neutral until their brands are wired here.
const BROKERAGE_THEME: Record<string, LandingTheme> = {
  // IPRE (Illustrated Properties) — Inland Greens palette.
  // Ivory cream bg + Jade primary + Ocean ink + Sage accent. Serif headline
  // (Cormorant Garamond, a web substitute for IPRE's "Morion").
  ipre: {
    bg: '#F2ECDD',
    surface: '#FBF8F0',
    primary: '#095354',
    primaryHover: '#003E46',
    ink: '#00283F',
    accent: '#92ADAC',
    serifHeadline: true,
  },
};

export default async function BrokerageLandingPage(props: PageProps<'/[slug]'>) {
  const { slug } = await props.params;

  const brokerage = await db.query.brokerages.findFirst({
    where: and(
      eq(schema.brokerages.landingPageSlug, slug),
      eq(schema.brokerages.active, true),
    ),
  });

  // Allowlist: only active brokerage slugs render. Everything else 404s.
  if (!brokerage) notFound();

  const theme = BROKERAGE_THEME[slug] ?? DEFAULT_THEME;
  const siteKey = process.env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY ?? '';
  const tagline =
    brokerage.pricingTagline?.replace(/\{Name\}/g, brokerage.name) ?? '';

  const headlineFontFamily = theme.serifHeadline
    ? 'var(--font-cormorant), Georgia, "Times New Roman", serif'
    : 'var(--font-outfit), sans-serif';

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{ backgroundColor: theme.bg, color: theme.ink }}
    >
      {/* Top bar */}
      <header
        className="border-b"
        style={{
          backgroundColor: theme.surface,
          borderColor: `${theme.accent}66`,
        }}
      >
        <div className="mx-auto max-w-3xl px-4 sm:px-6 py-4 flex items-center justify-between">
          {brokerage.masterLogoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={brokerage.masterLogoUrl}
              alt={brokerage.name}
              className="h-10 max-w-[220px] object-contain"
            />
          ) : (
            <span className="text-lg font-semibold" style={{ color: theme.ink }}>
              {brokerage.name}
            </span>
          )}
          <span
            className="text-xs"
            style={{ color: theme.ink, opacity: 0.5 }}
          >
            Powered by Rejig.ai
          </span>
        </div>
      </header>

      {/* Main */}
      <main className="flex-1 flex items-center justify-center px-4 py-12 sm:py-16">
        <div className="w-full max-w-md">
          {/* Eyebrow — Termina substitute: uppercase + wide tracking */}
          <p
            className="text-center text-[11px] sm:text-xs font-semibold uppercase"
            style={{
              color: theme.primary,
              letterSpacing: '0.18em',
              fontFamily: 'var(--font-outfit), sans-serif',
            }}
          >
            {brokerage.name}
          </p>

          <h1
            className="mt-3 text-center text-3xl sm:text-4xl leading-tight"
            style={{
              color: theme.ink,
              fontFamily: headlineFontFamily,
              fontWeight: theme.serifHeadline ? 600 : 700,
            }}
          >
            Welcome to your Rejig onboarding
          </h1>

          <p
            className="mt-3 text-center text-sm sm:text-base"
            style={{ color: theme.ink, opacity: 0.7 }}
          >
            {tagline ||
              'Enter your work email to verify your agent profile and begin onboarding.'}
          </p>

          <div
            className="mt-8 rounded-2xl border shadow-sm p-6 sm:p-8"
            style={{
              backgroundColor: theme.surface,
              borderColor: `${theme.accent}80`,
              boxShadow: '0 1px 3px rgba(0, 40, 63, 0.06)',
            }}
          >
            <EmailForm slug={slug} siteKey={siteKey} theme={theme} />
          </div>

          <p
            className="mt-6 text-center text-xs"
            style={{ color: theme.ink, opacity: 0.45 }}
          >
            We use your email only to match you against your brokerage roster.
          </p>
        </div>
      </main>
    </div>
  );
}
