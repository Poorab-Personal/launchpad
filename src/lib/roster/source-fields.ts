/**
 * Shaping helpers for the raw `brokerage_roster.source_data` JSONB blob.
 *
 * Everything in `source_data` is the vendor payload verbatim (see
 * `src/lib/roster/sources/dmg.ts`), so nothing in it can be trusted to hold
 * the type its upstream interface claims. DMG in particular emits bare JSON
 * numbers wherever a value looks numeric — a suite line comes back as
 * `Address2: 201`, not `"201"`.
 *
 * That bit us on 2026-08-20: `office.Address2?.trim()` threw
 * `TypeError: e?.trim is not a function` for 83 Keyes/IPRE roster rows,
 * 500ing POST /api/agent-lookup and surfacing on the landing page as the
 * generic "Network error. Please try again." Optional chaining guards
 * null/undefined, not wrong types. Hence `text()`: every scalar read out of
 * `source_data` goes through it.
 */

export interface SourceOffice {
  Address1?: unknown;
  Address2?: unknown;
  Address3?: unknown;
  City?: unknown;
  State?: unknown;
}

export interface SourceRegion {
  RegionName?: unknown;
}

export interface RosterSourceData {
  office?: SourceOffice | null;
  user?: { Regions?: SourceRegion[] | null } | null;
}

/**
 * Coerce an untrusted `source_data` scalar to a trimmed, non-empty string.
 *
 * Strings and finite numbers pass through; everything else (objects, arrays,
 * booleans, null, NaN) becomes null rather than stringifying into garbage
 * like "[object Object]" in the middle of an agent's business address.
 */
export function text(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

/**
 * Minimal HTML → plain text. No existing util in the repo; DMG Bio is light
 * HTML (<p>, <br>, <strong>). Strip tags, decode a few common entities,
 * collapse whitespace. The agent confirms/edits on the intake form anyway.
 */
export function stripHtml(input: unknown): string | null {
  const raw = text(input);
  if (!raw) return null;
  const plain = raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return plain.length > 0 ? plain : null;
}

/** Join office address parts: "Address1 Address2 Address3, City, State". */
export function formatOfficeAddress(
  office: SourceOffice | null | undefined,
): string | null {
  if (!office) return null;
  const street = [office.Address1, office.Address2, office.Address3]
    .map(text)
    .filter((s): s is string => s !== null)
    .join(' ');
  const parts = [street, text(office.City), text(office.State)].filter(
    (s): s is string => Boolean(s && s.length),
  );
  const joined = parts.join(', ');
  return joined.length > 0 ? joined : null;
}

/** Region names joined, dropping internal regions (e.g. "Keyes Employees"). */
export function formatServiceAreas(
  regions: SourceRegion[] | null | undefined,
): string | null {
  if (!regions || regions.length === 0) return null;
  const names = regions
    .map((r) => text(r?.RegionName))
    .filter((n): n is string => n !== null)
    .filter((n) => !/employees/i.test(n));
  const joined = names.join(', ');
  return joined.length > 0 ? joined : null;
}
