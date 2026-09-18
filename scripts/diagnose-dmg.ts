/**
 * Diagnostic — calls DMG /users/ + /users/offices/ for a single brokerage,
 * dumps raw payload + field-key inventory.
 *
 * Goal: see exactly what DMG returns so we can map it accurately to the
 * intake-form fields (instead of trusting the legacy GAS code's subset).
 *
 * Read-only. Writes nothing to DB. Does not commit.
 *
 * Usage:  npx tsx scripts/diagnose-dmg.ts keyes
 *         npx tsx scripts/diagnose-dmg.ts bw
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const PREFIX_BY_SLUG: Record<string, string> = {
  'keyes': 'DMG_KEYES',
  'bw': 'DMG_BAIRD_WARNER',
  'coach': 'DMG_COACH',
};

async function main() {
  const slug = process.argv[2] ?? 'keyes';
  const prefix = PREFIX_BY_SLUG[slug];
  if (!prefix) {
    console.error(`Unknown slug: ${slug}. Known: ${Object.keys(PREFIX_BY_SLUG).join(', ')}`);
    process.exit(1);
  }

  const clientId = process.env[`${prefix}_CLIENT_ID`];
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];
  if (!clientId || !clientSecret) {
    console.error(`Missing ${prefix}_CLIENT_ID or ${prefix}_CLIENT_SECRET in .env.local`);
    process.exit(1);
  }

  console.log(`\n→ Brokerage: ${slug}  (env prefix: ${prefix})\n`);

  // 1. OAuth
  const tokenRes = await fetch('https://apis.deltagroup.com/v2/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'users_read',
    }),
  });
  if (!tokenRes.ok) {
    console.error(`Auth failed (${tokenRes.status}): ${await tokenRes.text()}`);
    process.exit(1);
  }
  const { access_token } = (await tokenRes.json()) as { access_token: string };
  console.log('OAuth: OK');

  // 2. Users
  const usersRes = await fetch('https://apis.deltagroup.com/v2/users/', {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!usersRes.ok) {
    console.error(`Users fetch failed (${usersRes.status}): ${await usersRes.text()}`);
    process.exit(1);
  }
  const usersData = (await usersRes.json()) as Record<string, unknown[]>;

  // 3. Offices
  const officesRes = await fetch('https://apis.deltagroup.com/v2/users/offices/', {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!officesRes.ok) {
    console.error(`Offices fetch failed (${officesRes.status}): ${await officesRes.text()}`);
    process.exit(1);
  }
  const officesData = await officesRes.json();

  // 3b. MLS sources (the lookup table we need for MlsSourceId → name)
  const mlsRes = await fetch('https://apis.deltagroup.com/v2/mlsSource/', {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  console.log(`\n=== /mlsSource/ status: ${mlsRes.status} ===`);
  if (mlsRes.ok) {
    const mlsData = await mlsRes.json();
    console.log(JSON.stringify(mlsData, null, 2));
  } else {
    console.log(await mlsRes.text());
  }

  // 4. Top-level shape
  console.log('\n=== USERS TOP-LEVEL ===');
  console.log('keys:', Object.keys(usersData));
  for (const k of Object.keys(usersData)) {
    const v = usersData[k];
    console.log(`  ${k}: ${Array.isArray(v) ? `array len=${v.length}` : typeof v}`);
  }

  // 5. First agent (raw)
  const agents = (usersData.agent ?? []) as Record<string, unknown>[];
  console.log(`\n=== FIRST AGENT (raw JSON) ===`);
  console.log(JSON.stringify(agents[0], null, 2));

  // 6. Field-key inventory across first 50 agents
  const keyTypeSamples = new Map<string, Set<string>>();
  for (const u of agents.slice(0, 50)) {
    for (const k of Object.keys(u)) {
      const t = u[k] === null ? 'null'
        : Array.isArray(u[k]) ? `array(${u[k] && (u[k] as unknown[]).length > 0 ? typeof (u[k] as unknown[])[0] : 'empty'})`
        : typeof u[k];
      if (!keyTypeSamples.has(k)) keyTypeSamples.set(k, new Set());
      keyTypeSamples.get(k)!.add(t);
    }
  }
  console.log(`\n=== AGENT FIELD KEYS (across first 50 agents) ===`);
  for (const k of [...keyTypeSamples.keys()].sort()) {
    console.log(`  ${k.padEnd(35)}  types: ${[...keyTypeSamples.get(k)!].join(' | ')}`);
  }

  // 7. Offices
  const offices = Array.isArray(officesData) ? officesData : ((officesData as { offices?: unknown[] }).offices ?? []);
  console.log(`\n=== OFFICES TOP-LEVEL ===`);
  console.log(`  type: ${Array.isArray(officesData) ? 'array' : typeof officesData}`);
  console.log(`  length: ${(offices as unknown[]).length}`);

  if ((offices as unknown[]).length > 0) {
    console.log(`\n=== FIRST OFFICE (raw JSON) ===`);
    console.log(JSON.stringify((offices as unknown[])[0], null, 2));

    const officeKeyTypes = new Map<string, Set<string>>();
    for (const o of (offices as Record<string, unknown>[]).slice(0, 20)) {
      for (const k of Object.keys(o)) {
        const t = o[k] === null ? 'null'
          : Array.isArray(o[k]) ? `array(${o[k] && (o[k] as unknown[]).length > 0 ? typeof (o[k] as unknown[])[0] : 'empty'})`
          : typeof o[k];
        if (!officeKeyTypes.has(k)) officeKeyTypes.set(k, new Set());
        officeKeyTypes.get(k)!.add(t);
      }
    }
    console.log(`\n=== OFFICE FIELD KEYS (across first 20 offices) ===`);
    for (const k of [...officeKeyTypes.keys()].sort()) {
      console.log(`  ${k.padEnd(35)}  types: ${[...officeKeyTypes.get(k)!].join(' | ')}`);
    }
  }

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
