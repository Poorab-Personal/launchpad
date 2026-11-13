import type { AirtableAttachment, ProductTier } from '@/types';

/**
 * Structured brand kit the designer fills during Create Designs, and the
 * source of every design field pushed to Rejig. Mirrors Rejig's Manage Brand
 * screen. Plan: docs/plans/rejig-account-sync.md.
 *
 * Pure module — no db / server-only imports — so the payload builder, vitest
 * and tsx scripts can all load it.
 */

export const LOGO_VARIANTS = ['logo', 'logo_black', 'logo_white'] as const;
export type LogoVariant = (typeof LOGO_VARIANTS)[number];

/** Rejig's palette and both logo-selection rows are always five slots. */
export const PALETTE_SLOTS = 5;

/** Rejig's Brand / Team Logo Sizes inputs default to 100. */
export const DEFAULT_LOGO_SIZES: LogoSizes = { facebookSquare: 100, instagram: 100 };

export type LogoSizes = { facebookSquare: number; instagram: number };

/**
 * An option picked from a Rejig-provided list (affiliations, fonts). Stored
 * as value + label because we don't yet know whether Rejig keys on id or name.
 */
export type RejigOption = { value: string; label: string };

export type FontPick = RejigOption & { lineHeight: number };

export type BrandKit = {
  logos: {
    primary?: AirtableAttachment;
    /** Dark logo, for light backgrounds → logo_black_url. */
    black?: AirtableAttachment;
    /** Light logo, for dark backgrounds → logo_white_url. */
    white?: AirtableAttachment;
  };
  palette: string[];
  logoSelection: LogoVariant[];
  teamLogoSelection: LogoVariant[];
  applyFixedLogoHeight: boolean;
  applyCustomFont: boolean;
  fonts: { primary?: FontPick; secondary?: FontPick; tertiary?: FontPick };
  brandLogoSizes: LogoSizes;
  teamLogoSizes: LogoSizes;
  footerLabel: string;
  affiliation: RejigOption | null;
  otherAffiliation: string;
  imageSearchTags: string[];
  videoSearchTags: string[];
  updatedAt?: string;
  updatedBy?: string;
};

export function emptyBrandKit(): BrandKit {
  return {
    logos: {},
    palette: [],
    logoSelection: [],
    teamLogoSelection: [],
    applyFixedLogoHeight: false,
    applyCustomFont: false,
    fonts: {},
    brandLogoSizes: { ...DEFAULT_LOGO_SIZES },
    teamLogoSizes: { ...DEFAULT_LOGO_SIZES },
    footerLabel: '',
    affiliation: null,
    otherAffiliation: '',
    imageSearchTags: [],
    videoSearchTags: [],
  };
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(value: string): boolean {
  return HEX_RE.test(value);
}

function isFullSelection(sel: LogoVariant[] | undefined): boolean {
  return (
    Array.isArray(sel) &&
    sel.length === PALETTE_SLOTS &&
    sel.every((v) => (LOGO_VARIANTS as readonly string[]).includes(v))
  );
}

function isCompleteFont(f: FontPick | undefined): boolean {
  return !!f && f.value.trim() !== '' && Number.isFinite(f.lineHeight) && f.lineHeight > 0;
}

/**
 * What's still missing before the kit can be pushed to Rejig (and, once the
 * gate is on, before Create Designs can complete). Empty array = complete.
 *
 * Black / white logos, other affiliation, search tags and sizes are optional
 * (confirmed 2026-11-12). Fonts are required only when Apply Custom Font is on.
 */
export function brandKitMissing(
  kit: BrandKit | null | undefined,
  productTier: ProductTier | null | undefined,
): string[] {
  const missing: string[] = [];
  if (!kit) {
    return [
      'Primary logo',
      'Palette (5 colours)',
      'Logo selection',
      'Team logo selection',
      ...(productTier ? [] : ['Account type']),
      'Footer label',
      'Affiliation',
    ];
  }
  if (!kit.logos?.primary?.url) missing.push('Primary logo');
  if (
    !Array.isArray(kit.palette) ||
    kit.palette.length !== PALETTE_SLOTS ||
    !kit.palette.every(isHexColor)
  ) {
    missing.push('Palette (5 colours)');
  }
  if (!isFullSelection(kit.logoSelection)) missing.push('Logo selection');
  if (!isFullSelection(kit.teamLogoSelection)) missing.push('Team logo selection');
  if (!productTier) missing.push('Account type');
  if (!kit.footerLabel?.trim()) missing.push('Footer label');
  if (!kit.affiliation?.value?.trim()) missing.push('Affiliation');
  if (kit.applyCustomFont) {
    const { primary, secondary, tertiary } = kit.fonts ?? {};
    if (!isCompleteFont(primary) || !isCompleteFont(secondary) || !isCompleteFont(tertiary)) {
      missing.push('Fonts + line heights');
    }
  }
  return missing;
}
