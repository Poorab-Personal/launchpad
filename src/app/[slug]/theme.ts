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

  // Keyes — Floridian-inspired palette per official brand book.
  // Delray Beach cream bg + Everglade Green primary + Miami Sands accent.
  // Serif headline (Fraunces — Google Fonts substitute for Keyes' paid
  // "The Picnic Club" brand font).
  keyes: {
    bg: '#F7F3E5',            // Delray Beach
    surface: '#FFFFFF',
    primary: '#044439',       // Everglade Green
    primaryHover: '#033329',
    ink: '#1B2E35',
    accent: '#F3D8BE',        // Miami Sands
    serifHeadline: true,
    headlineFontVar: 'var(--font-fraunces)',
    headlineColor: '#044439', // Everglade Green — brand book headline color
  },

  // Baird & Warner — Deep Lake + Amber Wheat from official brand book.
  // Sans-serif throughout (B&W's proprietary "BW Bow Tie" is corporate-only;
  // brand book directs digital to clean supportive sans-serifs — we use
  // the existing Outfit fallback, very close to brand-recommended Plus
  // Jakarta Sans).
  //
  // Slug literally includes the ampersand to match legacy QR codes and
  // brokerage internal links — see memory `brokerage_landing_urls`.
  'b&w': {
    bg: '#F7F4EB',            // neutral warm cream
    surface: '#FFFFFF',
    primary: '#192D6B',       // Deep Lake
    primaryHover: '#101F4F',
    ink: '#1B2E35',
    accent: '#DCAE1D',        // Amber Wheat
    serifHeadline: false,
    headlineColor: '#192D6B', // Deep Lake — pops the headline with brand navy
  },
};

/** Resolve the brand theme for a slug, falling back to the neutral default. */
export function themeForSlug(slug: string): LandingTheme {
  return BROKERAGE_THEME[slug] ?? DEFAULT_THEME;
}
