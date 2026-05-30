/**
 * Delta Media Group (DMG) roster source adapter.
 *
 * OAuth2 client_credentials → fetch users + offices → normalize into
 * `NormalizedRosterRow`. Mirrors the legacy Google Apps Script implementation
 * at `rejig-ai/dmg-users-extract/google-apps-script/DeltaAPI.gs` +
 * `Code.gs#processUserData / createUserRow`.
 *
 * Pure I/O + transform. Does NOT touch Postgres. Does NOT filter on
 * account_type / status — the sync engine owns that so per-brokerage
 * diagnostics (distinct statuses observed, non-agent counts) are preserved.
 *
 * See docs/integrations/dmg-roster-plan.md §4.1 (sync flow), §5 (adapter
 * interface).
 */
import type {
  NormalizedRosterRow,
  RosterSourceAdapter,
  SourceConfig,
} from '../types';

const DMG_BASE_URL = 'https://apis.deltagroup.com/v2';
const DMG_TOKEN_URL = `${DMG_BASE_URL}/auth`;
const DMG_SCOPE = 'users_read';

/**
 * Schema version pin for the normalized DMG payload. Bump this string when
 * the adapter changes its `sourceData` shape so downstream consumers reading
 * `source_data` can branch on it. Format: `dmg-v<api>-<YYYY-MM>`.
 */
const DMG_SOURCE_SCHEMA_VERSION = 'dmg-v2-2026-05';

// ─── DMG API payload shapes (best-effort; subset we actually read) ────────
//
// Inferred from the legacy GAS code in rejig-ai/dmg-users-extract/. The DMG
// API is undocumented externally; field names below mirror what Code.gs
// reads off `user.*` / `office.*`. Everything is optional because the legacy
// code defensively defaults each field to '' / null.

interface DmgUser {
  UserId: string | number;
  Status?: string;
  FirstName?: string;
  LastName?: string;
  DisplayName?: string;
  PublicEmail?: string;
  PrivateEmail?: string;
  CellPhone?: string;
  OfficePhone?: string;
  Username?: string;
  WebsiteURL?: string;
  StateLicensingInformation?: string;
  PhotoURL?: string;
  Bio?: string;
  MlsIds?: Array<{ MlsSourceId: string | number; MlsId: string }>;
  Offices?: Array<{ OfficeId: string | number; Primary?: string }>;
  [k: string]: unknown;
}

/** /mlsSource/ response row — MlsSourceId comes back as a string here even though the user payload encodes it as a number. */
type DmgMlsSource = { MlsSourceId: string; MlsName: string };

interface DmgOffice {
  OfficeId: string | number;
  DisplayName?: string;
  City?: string;
  State?: string;
  Address1?: string;
  Address2?: string;
  Address3?: string;
  OfficePhone?: string;
  [k: string]: unknown;
}

interface DmgUsersResponse {
  agent?: DmgUser[];
  'office user'?: DmgUser[];
  management?: DmgUser[];
  [k: string]: DmgUser[] | undefined;
}

// ─── OAuth + fetch helpers ────────────────────────────────────────────────

function credsFor(config: SourceConfig): { clientId: string; clientSecret: string } {
  const idKey = `${config.credEnvPrefix}_CLIENT_ID`;
  const secretKey = `${config.credEnvPrefix}_CLIENT_SECRET`;
  const clientId = process.env[idKey];
  const clientSecret = process.env[secretKey];
  if (!clientId || !clientSecret) {
    throw new Error(
      `[dmg adapter] Missing credentials: ${idKey} and/or ${secretKey} not set in env`,
    );
  }
  return { clientId, clientSecret };
}

async function getAccessToken(config: SourceConfig): Promise<string> {
  const { clientId, clientSecret } = credsFor(config);

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: DMG_SCOPE,
  });

  const res = await fetch(DMG_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `[dmg adapter] OAuth token request failed: ${res.status} ${res.statusText} ${text}`,
    );
  }

  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new Error('[dmg adapter] OAuth response missing access_token');
  }
  return data.access_token;
}

async function dmgGet<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${DMG_BASE_URL}${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `[dmg adapter] GET ${path} failed: ${res.status} ${res.statusText} ${text}`,
    );
  }
  return (await res.json()) as T;
}

// ─── Normalization ────────────────────────────────────────────────────────

/**
 * Format raw DMG `MlsIds[]` into the locked display string
 * `"MLS Name: id, id\nMLS Name: id, id"`. See
 * memory/mls_ids_display_format.md (decision 2026-05-20).
 *
 * DMG encodes each entry as `{MlsSourceId, MlsId: "<csv>"}` where the csv may
 * start with an empty value (e.g. `",276580753,277013181,N634516"`), so we
 * split + trim + drop empties. `lookup` resolves `MlsSourceId → MlsName`; on
 * miss we fall back to `MLS#{id}` so the agent still sees a parseable line.
 */
function formatMlsIds(
  mlsIds: unknown,
  lookup: Map<string, string>,
): string | null {
  if (!Array.isArray(mlsIds) || mlsIds.length === 0) return null;
  // Group unique ids per MLS name. DMG often repeats the same id (once per
  // office membership) and can split one MLS across multiple entries — dedup
  // within AND across entries so the agent sees "Beaches MLS: 12345" once.
  const bySource = new Map<string, Set<string>>();
  for (const entry of mlsIds) {
    if (!entry || typeof entry !== 'object') continue;
    const sourceId = String((entry as { MlsSourceId?: unknown }).MlsSourceId ?? '');
    const idStr = String((entry as { MlsId?: unknown }).MlsId ?? '');
    const ids = idStr.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    if (ids.length === 0) continue;
    const name = lookup.get(sourceId) ?? `MLS#${sourceId}`;
    if (!bySource.has(name)) bySource.set(name, new Set());
    const set = bySource.get(name)!;
    for (const id of ids) set.add(id);
  }
  if (bySource.size === 0) return null;
  return [...bySource.entries()]
    .map(([name, ids]) => `${name}: ${[...ids].join(', ')}`)
    .join('\n');
}

/**
 * Scrub a string for safe Postgres insertion: drop NULL bytes (text/jsonb
 * reject U+0000) and normalize invalid UTF-8 / lone surrogates to U+FFFD via a
 * Buffer round-trip (the pg wire encoder rejects them with error 22021). DMG
 * bios are HTML and occasionally carry bytes that aren't valid UTF-8.
 */
function scrubString(s: string): string {
  return Buffer.from(s, 'utf8').toString('utf8').replace(new RegExp(String.fromCharCode(0), 'g'), '');
}

/** Recursively scrub every string in a value (objects / arrays / strings). */
function deepScrub<T>(value: T): T {
  if (typeof value === 'string') return scrubString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => deepScrub(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepScrub(v);
    }
    return out as unknown as T;
  }
  return value;
}

function normalizeUser(
  user: DmgUser,
  accountType: string,
  officeMap: Map<string, DmgOffice>,
  mlsSourceMap: Map<string, string>,
): NormalizedRosterRow {
  // Pick primary office (matches GAS logic in Code.gs#processUserData).
  let primaryOfficeRef: { OfficeId: string | number; Primary?: string } | undefined;
  if (Array.isArray(user.Offices) && user.Offices.length > 0) {
    primaryOfficeRef =
      user.Offices.find((o) => o.Primary === 'yes') ?? user.Offices[0];
  }
  const primaryOfficeId = primaryOfficeRef
    ? String(primaryOfficeRef.OfficeId)
    : null;
  const matchedOffice =
    primaryOfficeId != null ? officeMap.get(primaryOfficeId) ?? null : null;

  // Format MLS IDs using the per-brokerage /mlsSource/ lookup. Display format
  // is locked: "MLS Name: id, id\n..." (see memory/mls_ids_display_format.md).
  const mlsIds = formatMlsIds(user.MlsIds, mlsSourceMap);

  // deepScrub: DMG payloads occasionally carry invalid UTF-8 / NULL bytes
  // (esp. in HTML Bio) that Postgres rejects on insert (error 22021). Scrub
  // every string — promoted columns AND the raw sourceData JSONB.
  return deepScrub({
    sourceUserId: String(user.UserId),
    accountType,
    status: user.Status ?? null,
    displayName: user.DisplayName ?? null,
    firstName: user.FirstName ?? null,
    lastName: user.LastName ?? null,
    publicEmail: user.PublicEmail ?? null,
    privateEmail: user.PrivateEmail ?? null,
    cellPhone: user.CellPhone ?? null,
    // Real WebsiteURL field from DMG; prepend https:// if missing protocol.
    // Legacy GAS missed this and synthesized {username}.keyes.com instead.
    website: user.WebsiteURL
      ? (user.WebsiteURL.startsWith('http://') || user.WebsiteURL.startsWith('https://')
          ? user.WebsiteURL
          : `https://${user.WebsiteURL}`)
      : null,
    license: user.StateLicensingInformation ?? null,
    photoUrl: user.PhotoURL ?? null,
    bio: user.Bio ?? null,
    mlsIds,
    primaryOfficeId,
    officeName: matchedOffice?.DisplayName ?? null,
    sourceData: {
      user,
      office: matchedOffice,
      mlsIdsRaw: Array.isArray(user.MlsIds) ? user.MlsIds : null,
    },
    sourceSchemaVersion: DMG_SOURCE_SCHEMA_VERSION,
  });
}

function buildOfficeMap(offices: DmgOffice[]): Map<string, DmgOffice> {
  const map = new Map<string, DmgOffice>();
  for (const o of offices) {
    if (o.OfficeId != null) map.set(String(o.OfficeId), o);
  }
  return map;
}

function buildMlsSourceMap(sources: DmgMlsSource[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of sources) {
    if (s?.MlsSourceId != null && s?.MlsName != null) {
      // Coerce to string — /mlsSource/ returns MlsSourceId as a string but
      // user.MlsIds[].MlsSourceId is a number; the map key must match the
      // shape we look up with.
      map.set(String(s.MlsSourceId), s.MlsName);
    }
  }
  return map;
}

/**
 * Fetch the per-brokerage MLS source list and build a lookup map. Treated as
 * non-fatal: if DMG returns non-OK, log a warning and proceed with an empty
 * map so `formatMlsIds` falls back to `MLS#{id}` placeholders rather than
 * failing the whole sync.
 */
async function fetchMlsSourceMap(token: string): Promise<Map<string, string>> {
  try {
    const sources = await dmgGet<DmgMlsSource[]>('/mlsSource/', token);
    return buildMlsSourceMap(Array.isArray(sources) ? sources : []);
  } catch (err) {
    console.warn(
      `[dmg adapter] /mlsSource/ fetch failed; falling back to MLS#{id} placeholders. ${err instanceof Error ? err.message : String(err)}`,
    );
    return new Map<string, string>();
  }
}

// ─── Public adapter ───────────────────────────────────────────────────────

export const dmgAdapter: RosterSourceAdapter = {
  async fetchAll(config: SourceConfig): Promise<NormalizedRosterRow[]> {
    const token = await getAccessToken(config);

    // Parallelize users + offices + mlsSource — independent endpoints. The
    // mls source map is an internal-to-the-adapter lookup table (see
    // memory/mls_ids_display_format.md); not part of the adapter interface.
    const [usersResp, officesResp, mlsSourceMap] = await Promise.all([
      dmgGet<DmgUsersResponse>('/users/', token),
      dmgGet<DmgOffice[]>('/users/offices/', token),
      fetchMlsSourceMap(token),
    ]);

    const officeMap = buildOfficeMap(officesResp ?? []);

    const rows: NormalizedRosterRow[] = [];

    // Walk every category the DMG response carries — `agent`, `office user`,
    // `management`, and anything new. Sync.ts is responsible for filtering
    // down to agents; the adapter stays faithful to the source.
    for (const [accountType, users] of Object.entries(usersResp ?? {})) {
      if (!Array.isArray(users)) continue;
      for (const user of users) {
        if (user == null || user.UserId == null) continue;
        rows.push(normalizeUser(user, accountType, officeMap, mlsSourceMap));
      }
    }

    return rows;
  },

  async fetchOne(
    config: SourceConfig,
    sourceUserId: string,
  ): Promise<NormalizedRosterRow | null> {
    const token = await getAccessToken(config);

    // DMG's single-user endpoint returns the user object directly (per
    // DeltaAPI.gs). It does NOT include the account-type categorization the
    // bulk endpoint provides; default to 'agent' since that's the only
    // category we care about post-filter. Office data needs a separate call.
    let user: DmgUser | null = null;
    try {
      user = await dmgGet<DmgUser>(`/users/${encodeURIComponent(sourceUserId)}/`, token);
    } catch (err) {
      // 404 → null (deleted from source); rethrow anything else.
      if (err instanceof Error && /\b404\b/.test(err.message)) return null;
      throw err;
    }
    if (!user || user.UserId == null) return null;

    // Fetch offices + mlsSource alongside the single user. Both are
    // best-effort: failures fall back to empty maps so a transient lookup
    // failure produces `MLS#{id}` placeholders rather than blocking the
    // single-user refresh path.
    const [offices, mlsSourceMap] = await Promise.all([
      dmgGet<DmgOffice[]>('/users/offices/', token).catch(
        () => [] as DmgOffice[],
      ),
      fetchMlsSourceMap(token),
    ]);
    const officeMap = buildOfficeMap(offices ?? []);

    return normalizeUser(user, 'agent', officeMap, mlsSourceMap);
  },
};
