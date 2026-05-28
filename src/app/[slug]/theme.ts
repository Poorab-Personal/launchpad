/**
 * Per-brokerage landing palettes, keyed by `landing_page_slug`.
 *
 * Factored out of `[slug]/page.tsx` so the real landing and the /[slug]/test
 * landing resolve the SAME brand theme (no styling fork). To brand a new
 * brokerage, add a map entry here — no page/form changes needed.
 *
 * See docs/integrations/dmg-roster-plan.md §4.2.
 */
import type { LandingTheme } from './EmailForm';

// Neutral default — used by any brokerage without a branded palette wired.
export const DEFAULT_THEME: LandingTheme = {
  bg: '#F7F4EB',
  surface: '#ffffff',
  primary: '#6C4AB6',
  primaryHover: '#5a3d9c',
  ink: '#1B2E35',
  accent: '#E0DEE4',
  serifHeadline: false,
};

// Only IPRE is branded for now; Keyes / B&W stay neutral until wired here.
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

/** Resolve the brand theme for a slug, falling back to the neutral default. */
export function themeForSlug(slug: string): LandingTheme {
  return BROKERAGE_THEME[slug] ?? DEFAULT_THEME;
}
