/**
 * Persist a full, verbatim DMG roster pull for one brokerage — no DB, no
 * normalization, no filtering.
 *
 * Why this exists: `scripts/dmg-agent-*.ts` are stdout-only, so every ad-hoc
 * lookup evaporates when the terminal scrolls. This writes the raw payloads to
 * disk so the same pull can be queried repeatedly (fill rates, per-agent
 * checks, cross-brokerage comparison) without re-hitting DMG.
 *
 * Deliberately NOT `src/lib/roster/sync.ts`: that path requires a `brokerages`
 * row and writes `brokerage_roster`, which the live landing page, agent-lookup,
 * and the weekly cron all read. This is for prospect/evaluation brokerages that
 * have no business in the operational tables yet.
 *
 * Stores the three endpoints verbatim — the adapter's normalization is lossy by
 * design (it promotes ~14 fields and drops the rest), and the whole point here
 * is to see what DMG actually sends.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/dmg-roster-snapshot.ts --prefix DMG_COACH --label coach
 *   npx tsx --env-file=.env.local scripts/dmg-roster-snapshot.ts --prefix DMG_KEYES --label keyes
 *
 * Credentials: {PREFIX}_CLIENT_ID / {PREFIX}_CLIENT_SECRET from .env.local.
 * Output: scripts/data/dmg-snapshot-{label}-{YYYY-MM-DD}.json  (gitignored)
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'https://apis.deltagroup.com/v2';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function getToken(clientId: string, clientSecret: string): Promise<string> {
  const res = await fetch(`${BASE}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'users_read',
    }),
  });
  if (!res.ok) throw new Error(`Auth failed (${res.status}): ${await res.text()}`);
  const { access_token } = (await res.json()) as { access_token: string };
  return access_token;
}

async function get<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`GET ${path} failed (${res.status}): ${await res.text()}`);
  return (await res.json()) as T;
}

async function main() {
  const prefix = arg('--prefix');
  const label = arg('--label');
  if (!prefix || !label) {
    console.error(
      'Usage: npx tsx --env-file=.env.local scripts/dmg-roster-snapshot.ts --prefix DMG_COACH --label coach',
    );
    process.exit(1);
  }

  const clientId = process.env[`${prefix}_CLIENT_ID`];
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];
  if (!clientId || !clientSecret) {
    console.error(`Missing ${prefix}_CLIENT_ID / ${prefix}_CLIENT_SECRET in .env.local`);
    process.exit(1);
  }

  console.log(`Authenticating as ${prefix}…`);
  const token = await getToken(clientId, clientSecret);

  console.log('Fetching /users/, /users/offices/, /mlsSource/ …');
  const [users, offices, mlsSources] = await Promise.all([
    get<Record<string, unknown[]>>('/users/', token),
    get<unknown[]>('/users/offices/', token),
    // Non-fatal: same treatment the adapter gives it.
    get<unknown[]>('/mlsSource/', token).catch((e) => {
      console.warn(`  /mlsSource/ failed, continuing: ${e.message}`);
      return [] as unknown[];
    }),
  ]);

  // /users/ is keyed by account type ('agent', 'office user', 'management', …).
  const byType = Object.fromEntries(
    Object.entries(users ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0]),
  );
  const totalUsers = Object.values(byType).reduce((a, b) => a + b, 0);

  const fetchedAt = new Date().toISOString();
  const snapshot = {
    meta: {
      label,
      credEnvPrefix: prefix,
      fetchedAt,
      endpoints: ['/users/', '/users/offices/', '/mlsSource/'],
      counts: {
        usersByAccountType: byType,
        usersTotal: totalUsers,
        offices: Array.isArray(offices) ? offices.length : 0,
        mlsSources: Array.isArray(mlsSources) ? mlsSources.length : 0,
      },
      note: 'Verbatim DMG payloads. No normalization, no filtering, no DB write.',
    },
    users,
    offices,
    mlsSources,
  };

  const dir = join(process.cwd(), 'scripts', 'data');
  mkdirSync(dir, { recursive: true });
  const outPath = join(dir, `dmg-snapshot-${label}-${fetchedAt.slice(0, 10)}.json`);
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2), 'utf8');

  console.log('\nCounts:');
  for (const [type, n] of Object.entries(byType)) console.log(`  ${type}: ${n}`);
  console.log(`  offices: ${snapshot.meta.counts.offices}`);
  console.log(`  mlsSources: ${snapshot.meta.counts.mlsSources}`);
  console.log(`\nWrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
