/**
 * Roster adapter shared types.
 *
 * Multi-source roster integration per docs/integrations/dmg-roster-plan.md §5.
 * Each per-source adapter (src/lib/roster/sources/<source>.ts) implements
 * `RosterSourceAdapter` and normalizes its source's payload into
 * `NormalizedRosterRow` — the uniform shape the sync engine UPSERTs into
 * `brokerage_roster`.
 *
 * Adapter responsibilities: pure I/O + transform. No DB access. No filtering
 * (account_type / status filtering lives in sync.ts so the adapter remains
 * faithful to what the source returned and per-brokerage diagnostics are
 * possible).
 */

/**
 * Per-source JSONB config stored on `brokerages.source_config`.
 *
 * Today, every source we support reads its credentials from env vars keyed by
 * a per-brokerage prefix (so Keyes, B&W, IPRE each get their own DMG
 * client_id / client_secret pair):
 *
 *   process.env[`${credEnvPrefix}_CLIENT_ID`]
 *   process.env[`${credEnvPrefix}_CLIENT_SECRET`]
 *
 * e.g. credEnvPrefix = 'DMG_KEYES' reads DMG_KEYES_CLIENT_ID /
 * DMG_KEYES_CLIENT_SECRET. Future sources may extend this shape with
 * additional keys; keep the union narrow as we add them.
 */
export interface SourceConfig {
  credEnvPrefix: string;
}

/**
 * Normalized roster row produced by every adapter. Mirrors the promoted
 * columns on `brokerage_roster` plus the raw `sourceData` blob and a schema
 * version string the adapter pins.
 *
 * Why every promoted column is here: see plan §3.1 promotion rule. Nullable
 * everywhere except the natural-key fields (`sourceUserId`, `accountType`)
 * and the metadata fields (`sourceData`, `sourceSchemaVersion`).
 */
export interface NormalizedRosterRow {
  sourceUserId: string;
  accountType: string;
  status: string | null;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  publicEmail: string | null;
  privateEmail: string | null;
  cellPhone: string | null;
  website: string | null;
  license: string | null;
  photoUrl: string | null;
  bio: string | null;
  mlsIds: string | null;
  primaryOfficeId: string | null;
  officeName: string | null;
  /** Raw normalized source payload (user + matched office, etc.). Opaque to lookup/sync code. */
  sourceData: unknown;
  /** Forward-compat: which payload shape the adapter produced. */
  sourceSchemaVersion: string;
}

export interface RosterSourceAdapter {
  fetchAll(config: SourceConfig): Promise<NormalizedRosterRow[]>;
  fetchOne(
    config: SourceConfig,
    sourceUserId: string,
  ): Promise<NormalizedRosterRow | null>;
}
