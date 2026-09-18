/**
 * Backfill customer names left blank by the DMG empty-DisplayName bug.
 *
 * DMG returns `DisplayName` as an EMPTY STRING rather than omitting it, so the
 * old `rosterRow.displayName ?? matchedEmail` in agent-lookup produced '' —
 * `??` guards null, not ''. Fixed forward on 2026-09-18 by agentDisplayName();
 * this repairs the rows created before that.
 *
 * Resolves each blank name from the agent's roster row: "First Last", falling
 * back to the contact email (matching the fixed runtime behaviour exactly).
 * Matches roster rows via the brokerage_roster.customer_id bridge, then by
 * email within the same brokerage for rows whose bridge was never set.
 *
 * Also fills business_name where blank, since it came from the same source.
 * Does NOT touch HubSpot — existing tickets/contacts keep their names; see the
 * summary for which ones a human may want to rename there.
 *
 * SAFE BY DEFAULT: dry run prints the plan. Pass --confirm to write.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/backfill-blank-customer-names.ts
 *   npx tsx --env-file=.env.local scripts/backfill-blank-customer-names.ts --confirm
 */
import { db } from '@/db';
import * as schema from '@/db/schema';
import { eq, sql } from 'drizzle-orm';

const CONFIRM = process.argv.includes('--confirm');

function composed(first: string | null, last: string | null): string | null {
  const parts = [first?.trim(), last?.trim()].filter((p): p is string => Boolean(p));
  return parts.length ? parts.join(' ') : null;
}

async function main() {
  const blanks = await db.execute(sql`
    select c.id, c.name, c.business_name, c.contact_email, c.workflow_key, c.brokerage_id
    from customers c
    where (c.name is null or btrim(c.name) = '')
    order by c.created_at`);

  if (blanks.rows.length === 0) {
    console.log('No blank-name customers. Nothing to do.');
    return;
  }
  console.log(`Found ${blanks.rows.length} customer(s) with a blank name.\n`);

  type Plan = { id: string; email: string; wf: string; newName: string; newBiz: string | null; via: string };
  const plans: Plan[] = [];
  const unresolved: string[] = [];

  for (const r of blanks.rows as Array<Record<string, string | null>>) {
    const id = r.id as string;

    // 1. Preferred: the roster bridge.
    let roster = await db.query.brokerageRoster.findFirst({
      where: eq(schema.brokerageRoster.customerId, id),
      columns: { firstName: true, lastName: true, displayName: true },
    });
    let via = 'bridge';

    // 2. Fallback: email within the same brokerage (bridge never set).
    if (!roster && r.contact_email && r.brokerage_id) {
      const byEmail = await db.execute(sql`
        select first_name, last_name, display_name from brokerage_roster
        where brokerage_id = ${r.brokerage_id}
          and (lower(public_email) = lower(${r.contact_email})
            or lower(private_email) = lower(${r.contact_email}))
        limit 1`);
      if (byEmail.rows.length) {
        const b = byEmail.rows[0] as Record<string, string | null>;
        roster = { firstName: b.first_name, lastName: b.last_name, displayName: b.display_name } as typeof roster;
        via = 'email';
      }
    }

    const fromRoster =
      roster?.displayName?.trim() || composed(roster?.firstName ?? null, roster?.lastName ?? null);
    const newName = fromRoster || (r.contact_email ?? '');

    if (!newName) {
      unresolved.push(`${id} (${r.workflow_key})`);
      continue;
    }
    const bizBlank = !r.business_name || !String(r.business_name).trim();
    plans.push({
      id,
      email: r.contact_email ?? '(no email)',
      wf: r.workflow_key ?? '?',
      newName,
      newBiz: bizBlank ? newName : null,
      via: fromRoster ? via : 'email-fallback',
    });
  }

  for (const p of plans) {
    const biz = p.newBiz ? `  + business_name` : '';
    console.log(`  [${p.wf}] ${p.email}\n      name → "${p.newName}"  (via ${p.via})${biz}`);
  }
  if (unresolved.length) {
    console.log(`\n  ⚠ Unresolved (no roster row, no email): ${unresolved.join(', ')}`);
  }

  if (!CONFIRM) {
    console.log(`\nDRY RUN — nothing written. Re-run with --confirm to apply ${plans.length} update(s).`);
    return;
  }

  let n = 0;
  for (const p of plans) {
    await db
      .update(schema.customers)
      .set({ name: p.newName, ...(p.newBiz ? { businessName: p.newBiz } : {}) })
      .where(eq(schema.customers.id, p.id));
    n++;
  }
  console.log(`\n✅ Updated ${n} customer(s).`);
  console.log('   HubSpot was NOT touched — rename those contacts/tickets by hand if needed.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
