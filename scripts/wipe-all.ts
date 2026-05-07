/**
 * Wipe ALL records from Customers, Tasks, Events, and Calls tables.
 * Leaves Team Members, Brokerages, Workflow Templates, Roster, and Settings intact.
 *
 * Usage: npx tsx scripts/wipe-all.ts
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const PAT = process.env.AIRTABLE_PAT!;
const BASE_ID = process.env.AIRTABLE_BASE_ID!;
const API = `https://api.airtable.com/v0/${BASE_ID}`;
const H = { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' };

let lastReq = 0;
async function throttle<T>(fn: () => Promise<T>): Promise<T> {
  const wait = Math.max(0, 220 - (Date.now() - lastReq));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastReq = Date.now();
  return fn();
}

async function fetchAll(table: string): Promise<any[]> {
  const all: any[] = [];
  let offset: string | undefined;
  do {
    const url = new URL(`${API}/${encodeURIComponent(table)}`);
    if (offset) url.searchParams.set('offset', offset);
    const res = await throttle(() => fetch(url.toString(), { headers: H }));
    if (!res.ok) throw new Error(`GET ${table}: ${res.status} ${await res.text()}`);
    const data = await res.json();
    all.push(...data.records);
    offset = data.offset;
  } while (offset);
  return all;
}

async function batchDelete(table: string, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10);
    const params = chunk.map((id) => `records[]=${id}`).join('&');
    const res = await throttle(() =>
      fetch(`${API}/${encodeURIComponent(table)}?${params}`, { method: 'DELETE', headers: H }),
    );
    if (!res.ok) throw new Error(`DELETE ${table}: ${res.status} ${await res.text()}`);
  }
}

async function main() {
  console.log('\n=== Wiping all records ===\n');

  // Order: Events, Tasks, Calls → Customers (delete dependent records first)
  for (const table of ['Events', 'Tasks', 'Calls', 'Customers']) {
    const records = await fetchAll(table);
    if (records.length === 0) {
      console.log(`  ${table}: empty.`);
      continue;
    }
    console.log(`  ${table}: deleting ${records.length} records...`);
    await batchDelete(table, records.map((r) => r.id));
  }

  console.log('\nDone. Customers, Tasks, Calls, and Events tables are empty.\n');
}

main().catch((err) => {
  console.error('\nFailed:', err);
  process.exit(1);
});
