import type { AirtableAttachment, ProductTier } from '@/types';

/**
 * Structured brand kit the designer fills during Create Designs, and the
 * source of every design field pushed to Rejig. Mirrors Rejig's Manage Brand
 * screen. Plan: docs/plans/rejig-account-sync.md.
 *
 * Pure module — no db / server-only imports — so the payload builder, vitest
 * and tsx scripts can all load it.
 */

/**
 * Roles that may edit a brand kit (Admin always passes the live role check).
 * The designer fills it; the Account Creator can fix it up before syncing.
 */
export const BRAND_KIT_EDITOR_ROLES = ['Designer', 'Senior Designer', 'Account Creator'] as const;

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

/** Logo slot keys in `BrandKit.logos`. */
export const LOGO_SLOTS = ['primary', 'black', 'white'] as const;
export type LogoSlot = (typeof LOGO_SLOTS)[number];

/** Everything the designer's form saves — logos are saved separately, per slot. */
export type BrandKitFields = Omit<BrandKit, 'logos' | 'updatedAt' | 'updatedBy'>;

const MAX_TEXT = 200;
const MAX_TAGS = 20;

function text(v: unknown, max = MAX_TEXT): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function bool(v: unknown): boolean {
  return v === true;
}

function positive(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 && n <= 1000 ? n : fallback;
}

function variants(v: unknown): LogoVariant[] {
  if (!Array.isArray(v)) return [];
  return v
    .slice(0, PALETTE_SLOTS)
    .map((x) => ((LOGO_VARIANTS as readonly unknown[]).includes(x) ? (x as LogoVariant) : 'logo'));
}

function option(v: unknown): RejigOption | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const value = text(o.value);
  return value ? { value, label: text(o.label) || value } : null;
}

function font(v: unknown): FontPick | undefined {
  const o = option(v);
  if (!o) return undefined;
  return { ...o, lineHeight: positive((v as Record<string, unknown>).lineHeight, 1) };
}

function sizesOf(v: unknown): LogoSizes {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return {
    facebookSquare: positive(o.facebookSquare, DEFAULT_LOGO_SIZES.facebookSquare),
    instagram: positive(o.instagram, DEFAULT_LOGO_SIZES.instagram),
  };
}

function tags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map((t) => text(t, 60)).filter(Boolean))].slice(0, MAX_TAGS);
}

function logo(v: unknown): AirtableAttachment | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const url = text(o.url, 2000);
  if (!url) return undefined;
  return { url, filename: text(o.filename) || undefined, uploadedAt: text(o.uploadedAt) || undefined };
}

/**
 * Coerce untrusted form input into the saved shape. Partial kits are fine —
 * the designer saves drafts; completeness is `brandKitMissing`'s job. Palette
 * entries are kept as typed (even half-typed hex) so the form round-trips.
 */
export function sanitizeBrandKitFields(input: unknown): BrandKitFields {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const fonts = (o.fonts && typeof o.fonts === 'object' ? o.fonts : {}) as Record<string, unknown>;
  return {
    palette: Array.isArray(o.palette) ? o.palette.slice(0, PALETTE_SLOTS).map((c) => text(c, 7)) : [],
    logoSelection: variants(o.logoSelection),
    teamLogoSelection: variants(o.teamLogoSelection),
    applyFixedLogoHeight: bool(o.applyFixedLogoHeight),
    applyCustomFont: bool(o.applyCustomFont),
    fonts: {
      primary: font(fonts.primary),
      secondary: font(fonts.secondary),
      tertiary: font(fonts.tertiary),
    },
    brandLogoSizes: sizesOf(o.brandLogoSizes),
    teamLogoSizes: sizesOf(o.teamLogoSizes),
    footerLabel: text(o.footerLabel),
    affiliation: option(o.affiliation),
    otherAffiliation: text(o.otherAffiliation),
    imageSearchTags: tags(o.imageSearchTags),
    videoSearchTags: tags(o.videoSearchTags),
  };
}

/** Read `customers.brand_kit` defensively. NULL / non-object → null. */
export function parseBrandKit(raw: unknown): BrandKit | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const logos = (o.logos && typeof o.logos === 'object' ? o.logos : {}) as Record<string, unknown>;
  return {
    ...sanitizeBrandKitFields(o),
    logos: { primary: logo(logos.primary), black: logo(logos.black), white: logo(logos.white) },
    updatedAt: text(o.updatedAt) || undefined,
    updatedBy: text(o.updatedBy) || undefined,
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
