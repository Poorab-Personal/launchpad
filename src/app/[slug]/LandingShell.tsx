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

export default function LandingShell({
  brokerage,
  theme,
  form,
  banner,
}: {
  brokerage: LandingShellBrokerage;
  theme: LandingTheme;
  /** The interactive verification form (prod EmailForm or TestEmailForm). */
  form: ReactNode;
  /** Optional slot above the form card (e.g. the TEST MODE banner). */
  banner?: ReactNode;
}) {
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
          <span className="text-xs" style={{ color: theme.ink, opacity: 0.5 }}>
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
            {brokerage.tagline ||
              'Enter your work email to verify your agent profile and begin onboarding.'}
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
            {form}
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
