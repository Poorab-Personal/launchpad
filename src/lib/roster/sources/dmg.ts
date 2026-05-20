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
  StateLicensingInformation?: string;
  PhotoURL?: string;
  Bio?: string;
  MlsIds?: string[];
  Offices?: Array<{ OfficeId: string | number; Primary?: string }>;
  [k: string]: unknown;
}

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

function normalizeUser(
  user: DmgUser,
  accountType: string,
  officeMap: Map<string, DmgOffice>,
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

  // MLS IDs: legacy stored as JSON string; preserve that shape so downstream
  // (customers.mls_ids text column) gets the same payload it used to.
  const mlsIds =
    Array.isArray(user.MlsIds) && user.MlsIds.length > 0
      ? JSON.stringify(user.MlsIds)
      : null;

  // DMG does NOT return a Website field. The legacy Keyes Apps Script
  // synthesized `https://{username}.keyes.com` because Keyes maps each agent's
  // Username to a subdomain page on their site — a Keyes-specific quirk
  // (verified absent from the Baird & Warner GAS app). Don't fabricate URLs at
  // sync time. The agent's actual website is confirmed/edited on the intake
  // form. If a brokerage later wants to default-fill the field from Username,
  // that's a per-brokerage intake-form enrichment, not adapter logic.
  // The raw Username is still preserved in sourceData for that future use.

  return {
    sourceUserId: String(user.UserId),
    accountType,
    status: user.Status ?? null,
    displayName: user.DisplayName ?? null,
    firstName: user.FirstName ?? null,
    lastName: user.LastName ?? null,
    publicEmail: user.PublicEmail ?? null,
    privateEmail: user.PrivateEmail ?? null,
    cellPhone: user.CellPhone ?? null,
    website: null,
    license: user.StateLicensingInformation ?? null,
    photoUrl: user.PhotoURL ?? null,
    bio: user.Bio ?? null,
    mlsIds,
    primaryOfficeId,
    officeName: matchedOffice?.DisplayName ?? null,
    sourceData: { user, office: matchedOffice },
    sourceSchemaVersion: DMG_SOURCE_SCHEMA_VERSION,
  };
}

function buildOfficeMap(offices: DmgOffice[]): Map<string, DmgOffice> {
  const map = new Map<string, DmgOffice>();
  for (const o of offices) {
    if (o.OfficeId != null) map.set(String(o.OfficeId), o);
  }
  return map;
}

// ─── Public adapter ───────────────────────────────────────────────────────

export const dmgAdapter: RosterSourceAdapter = {
  async fetchAll(config: SourceConfig): Promise<NormalizedRosterRow[]> {
    const token = await getAccessToken(config);

    // Parallelize users + offices — independent endpoints.
    const [usersResp, officesResp] = await Promise.all([
      dmgGet<DmgUsersResponse>('/users/', token),
      dmgGet<DmgOffice[]>('/users/offices/', token),
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
        rows.push(normalizeUser(user, accountType, officeMap));
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

    const offices = await dmgGet<DmgOffice[]>('/users/offices/', token).catch(
      () => [] as DmgOffice[],
    );
    const officeMap = buildOfficeMap(offices ?? []);

    return normalizeUser(user, 'agent', officeMap);
  },
};
