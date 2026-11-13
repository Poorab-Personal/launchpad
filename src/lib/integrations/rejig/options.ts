import { unstable_cache } from 'next/cache';
import type { RejigOption } from '@/lib/brand-kit';

/**
 * Option lists for the brand-kit pickers, owned by Rejig. Read from Rejig
 * prod (the lists the Account Creator builds accounts from), falling back to
 * dev when prod has no key or fails (Rejig says the lists are identical; on
 * 2026-11-12 the prod key got 401 on both). Cached for a day; a failed fetch isn't
 * cached and the picker shows whatever is already saved.
 * Plan: docs/plans/rejig-account-sync.md.
 *
 * Stored as `{value, label}`, value being what Rejig wants in the payload
 * (confirmed by Rejig 2026-11-12):
 *   - affiliation: the name ("Century 21"); Rejig maps it to its own id.
 *   - font: the `fontFamily` ("ABeeZee"). The list has one row per
 *     weight/style, so we collapse it to one option per family.
 */

const BASES = {
  prod: { url: 'https://api.rejig.ai', keyVar: 'REJIG_ONBOARDING_PROD_API_KEY' },
  dev: { url: 'https://devapi.rejig.ai', keyVar: 'REJIG_ONBOARDING_DEV_API_KEY' },
} as const;

const TIMEOUT_MS = 15_000;
const ONE_DAY = 86_400;
const INDUSTRY = 'realtor';

async function getRejig(path: string): Promise<unknown> {
  const errors: string[] = [];
  for (const [env, base] of [['prod', BASES.prod], ['dev', BASES.dev]] as const) {
    const apiKey = process.env[base.keyVar];
    if (!apiKey) continue;
    try {
      const res = await fetch(`${base.url}${path}`, {
        headers: { 'X-Service-API-Key': apiKey, Accept: 'application/json' },
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return await res.json();
      errors.push(`${env} HTTP ${res.status}`);
    } catch (err) {
      errors.push(`${env} ${err instanceof Error ? err.message : String(err)}`);
    }
    if (env === 'prod') console.warn(`Rejig ${path}: prod failed (${errors.at(-1)}), trying dev`);
  }
  throw new Error(`Rejig ${path} unavailable: ${errors.join('; ') || 'no API key configured'}`);
}

function rows(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [];
}

function s(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function byLabel(a: RejigOption, b: RejigOption): number {
  return a.label.localeCompare(b.label);
}

/** Pure: Rejig's industries response → Realtor affiliations, by name. Realtor only, per Rejig. */
export function parseAffiliations(body: unknown): RejigOption[] {
  const root = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const data = (root.data && typeof root.data === 'object' ? root.data : {}) as Record<string, unknown>;
  const affiliations = rows(data.affiliations ?? root.affiliations);
  const industries = rows(data.industries ?? root.industries);

  const realtorIds = new Set(
    industries.filter((i) => s(i.industrie).toLowerCase() === INDUSTRY).map((i) => s(i._id)),
  );
  const realtor = affiliations.filter((a) => realtorIds.has(s(a.industrie_id)));

  const names = [...new Set(realtor.map((a) => s(a.name)).filter(Boolean))];
  return names.map((name) => ({ value: name, label: name })).sort(byLabel);
}

/** Pure: Rejig's font list → one option per font family. */
export function parseFonts(body: unknown): RejigOption[] {
  const root = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const families = [...new Set(rows(root.data).map((f) => s(f.fontFamily)).filter(Boolean))];
  return families.map((family) => ({ value: family, label: family })).sort(byLabel);
}

const cachedAffiliations = unstable_cache(
  async () => {
    const list = parseAffiliations(await getRejig('/rejig-auth/industries'));
    if (list.length === 0) throw new Error('Rejig returned no affiliations');
    return list;
  },
  ['rejig-affiliations-v2'],
  { revalidate: ONE_DAY },
);

const cachedFonts = unstable_cache(
  async () => {
    const list = parseFonts(await getRejig('/generator/get_font_list'));
    if (list.length === 0) throw new Error('Rejig returned no fonts');
    return list;
  },
  ['rejig-fonts-v2'],
  { revalidate: ONE_DAY },
);

/** Empty on failure — the picker then offers only the saved value. */
export async function getAffiliations(): Promise<RejigOption[]> {
  try {
    return await cachedAffiliations();
  } catch (err) {
    console.warn('Rejig affiliations unavailable:', err);
    return [];
  }
}

export async function getFonts(): Promise<RejigOption[]> {
  try {
    return await cachedFonts();
  } catch (err) {
    console.warn('Rejig fonts unavailable:', err);
    return [];
  }
}
