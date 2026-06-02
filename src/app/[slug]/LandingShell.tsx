/**
 * Shared brokerage landing layout.
 *
 * Factored out of `[slug]/page.tsx` so the real landing (/ipre) and the
 * test-mode landing (/ipre/test) render the IDENTICAL branded chrome — top
 * bar + logo, eyebrow, headline, tagline, the bordered form card, and footer
 * — without forking the styling. The only difference between the two pages is
 * the `form` node passed in (the prod EmailForm vs the two-field test form)
 * and the optional `banner` slot (the 🧪 TEST MODE banner).
 *
 * Server component — no client state lives here; the interactive form is the
 * child node. The theme map + DEFAULT_THEME live alongside this in `theme.ts`.
 *
 * See docs/integrations/dmg-roster-plan.md §4.2.
 */
import type { ReactNode } from 'react';
import type { LandingTheme } from './EmailForm';

interface LandingShellBrokerage {
  name: string;
  masterLogoUrl: string | null;
  /** Pre-resolved tagline ({Name} already substituted), or '' for the default. */
  tagline: string;
}

/** Brokerage-specific landing copy. Carries the marketing-flyer narrative
 *  forward to the LP (offer, partnership framing, what-happens-next steps).
 *  Hardcoded per slug for now — when Keyes/B&W go live, add their entries.
 *  For unknown slugs, falls back to the generic copy in the renderer below. */
const COPY_BY_SLUG: Record<
  string,
  {
    h1: string;
    /** Headline-adjacent value promise. Reads as a tagline. */
    subhead: string;
    /** Smaller intro inside the form card — explains what the email
     *  field is for so the agent knows the next step. */
    formIntro: string;
    bullets: Array<{ strong: string; rest: string }>;
  }
> = {
  ipre: {
    h1: 'Activate your Rejig.ai account',
    subhead: 'Your AI-powered social media assistant.',
    formIntro:
      'Verify your IPRE email to access your pre-filled profile. 30-day free trial — no charge today.',
    bullets: [
      // Sharpened to disambiguate "verify" (email-matching only) from
      // "review" (the profile step). Bullet 2 makes the IPRE-roster pre-fill
      // explicit at the moment it matters — when the agent is about to see
      // their pre-populated form.
      { strong: 'Verify your IPRE email', rest: '— no password, no signup' },
      {
        strong: 'Review your pre-filled IPRE profile & save your card',
        rest: '— first 30 days free, no charge today',
      },
      { strong: 'Book your onboarding call', rest: '— 30 minutes with our team' },
      {
        strong: "We'll design your brand kit",
        rest: '— ready before your onboarding call',
      },
    ],
  },
};

export default function LandingShell({
  slug,
  brokerage,
  theme,
  form,
  banner,
}: {
  slug: string;
  brokerage: LandingShellBrokerage;
  theme: LandingTheme;
  /** The interactive verification form (prod EmailForm or TestEmailForm). */
  form: ReactNode;
  /** Optional slot above the form card (e.g. the TEST MODE banner). */
  banner?: ReactNode;
}) {
  const copy = COPY_BY_SLUG[slug];
  const headlineFontFamily = theme.serifHeadline
    ? 'var(--font-cormorant), Georgia, "Times New Roman", serif'
    : 'var(--font-outfit), sans-serif';

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{ backgroundColor: theme.bg, color: theme.ink }}
    >
      {/* Top bar — co-brand lockup (Rejig × Brokerage), matches the flyer.
          Earlier this used opposite-corner logos, which read as "two
          separate companies" rather than a partnership. Centered with an
          oversized × between is the visual cue the marketing flyer
          establishes; we carry it through here for continuity. */}
      <header
        className="border-b"
        style={{
          backgroundColor: theme.surface,
          borderColor: `${theme.accent}66`,
        }}
      >
        <div className="mx-auto max-w-3xl px-4 sm:px-6 py-4 flex items-center justify-center gap-4">
          {/* Brokerage logo first (the agent's home brand), then × Rejig.
              Mirrors the marketing flyer's "ILLUSTRATED PROPERTIES × rejig.ai"
              order so QR-scan continuity is preserved. */}
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
            className="text-2xl font-light"
            style={{ color: theme.ink, opacity: 0.35 }}
            aria-hidden="true"
          >
            ×
          </span>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="https://rejig.ai/wp-content/themes/rejigchild/assets/images/rejig-logo-1.png"
            alt="Rejig.ai"
            className="h-8 w-auto max-w-[140px] object-contain"
          />
        </div>
      </header>

      {/* Main */}
      <main className="flex-1 flex items-center justify-center px-4 py-12 sm:py-16">
        <div className="w-full max-w-md">
          {/* Eyebrow intentionally removed when a slug has wired copy — the
              top-bar co-brand lockup already establishes the partnership.
              For unknown slugs (Keyes / B&W until their entries are added),
              render the brokerage name as the eyebrow so they still get
              some visual hierarchy. */}
          {!copy && (
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
          )}

          <h1
            className={`text-center text-3xl sm:text-4xl leading-tight ${copy ? '' : 'mt-3'}`}
            style={{
              color: theme.ink,
              fontFamily: headlineFontFamily,
              fontWeight: theme.serifHeadline ? 600 : 700,
            }}
          >
            {copy?.h1 ?? 'Welcome to your Rejig onboarding'}
          </h1>

          <p
            className="mt-3 text-center text-sm sm:text-base"
            style={{ color: theme.ink, opacity: 0.7 }}
          >
            {copy?.subhead ??
              (brokerage.tagline ||
                'Enter your work email to verify your agent profile and begin onboarding.')}
          </p>

          {banner ? <div className="mt-6">{banner}</div> : null}

          <div
            className="mt-8 rounded-2xl border shadow-sm p-6 sm:p-8"
            style={{
              backgroundColor: theme.surface,
              borderColor: `${theme.accent}80`,
              boxShadow: '0 1px 3px rgba(0, 40, 63, 0.06)',
            }}
          >
            {copy?.formIntro && (
              <p
                className="mb-5 text-center text-xs sm:text-sm leading-relaxed"
                style={{ color: theme.ink, opacity: 0.65 }}
              >
                {copy.formIntro}
              </p>
            )}
            {form}
          </div>

          {/* Trust line — kept verbatim. */}
          <p
            className="mt-6 text-center text-xs"
            style={{ color: theme.ink, opacity: 0.45 }}
          >
            We use your email only to match you against your brokerage roster.
          </p>

          {/* "Here's what happens next" — only renders when the brokerage has
              flyer-aligned copy wired in COPY_BY_SLUG. Keeps the LP feeling
              consistent with the marketing flyer's promise. */}
          {copy?.bullets && (
            <div
              className="mt-8 rounded-2xl border p-5 sm:p-6"
              style={{
                backgroundColor: theme.surface,
                borderColor: `${theme.accent}66`,
              }}
            >
              <p
                className="text-[11px] font-semibold uppercase tracking-wider"
                style={{ color: theme.primary, letterSpacing: '0.14em' }}
              >
                Here&apos;s what happens next
              </p>
              <ol
                className="mt-4 space-y-3 text-sm"
                style={{ color: theme.ink }}
              >
                {copy.bullets.map((b, i) => (
                  <li key={i} className="flex gap-3">
                    <span
                      className="flex-shrink-0 inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold"
                      style={{
                        backgroundColor: `${theme.primary}1A`,
                        color: theme.primary,
                      }}
                    >
                      {i + 1}
                    </span>
                    <span className="leading-relaxed">
                      <span className="font-semibold">{b.strong}</span>{' '}
                      <span style={{ opacity: 0.7 }}>{b.rest}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
