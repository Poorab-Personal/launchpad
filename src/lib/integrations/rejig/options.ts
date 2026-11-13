import type { RejigOption } from '@/lib/brand-kit';

/**
 * Option lists for the brand-kit dropdowns. Rejig owns these lists and the
 * values are identical in its dev and prod. The endpoints aren't built yet,
 * so these return placeholders; swap the bodies for a fetch when they ship.
 * Plan: docs/plans/rejig-account-sync.md (open question for Rejig: does the
 * list key on id or name? We store `{value, label}` so either works).
 */

// TODO(rejig-options): replace with Rejig's affiliation endpoint.
const PLACEHOLDER_AFFILIATIONS: RejigOption[] = [
  'Blank - Luxury',
  'Blank - Premium',
  'Baird & Warner',
  'Coach Realtors',
  'Illustrated Properties',
  'Keyes',
  'Ruhl & Ruhl',
].map((label) => ({ value: label, label }));

// TODO(rejig-options): replace with Rejig's font endpoint. Seeded from fonts
// seen in Rejig's Manage Brand screens and its sample payload.
const PLACEHOLDER_FONTS: RejigOption[] = [
  'BWBowTie',
  'DINNextLTPro',
  'Inter',
  'Lora',
  'Montserrat',
  'Open Sans',
  'ProximaNova',
].map((label) => ({ value: label, label }));

/** Whether the lists below are real Rejig data or placeholders. */
export const REJIG_OPTIONS_ARE_PLACEHOLDERS = true;

export async function getAffiliations(): Promise<RejigOption[]> {
  return PLACEHOLDER_AFFILIATIONS;
}

export async function getFonts(): Promise<RejigOption[]> {
  return PLACEHOLDER_FONTS;
}
