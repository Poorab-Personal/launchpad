import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

/**
 * Offboard Mario and Luis, and move every onboarding booking link off Mario's
 * personal HubSpot meeting URL onto the shared Rejig one.
 *
 * Mario's link still returns 200, so the failure mode is silent: an agent books,
 * gets a confirmation, and nobody joins. That makes this urgent even though
 * nothing is visibly broken.
 *
 * Scope (data only — no deploy needed):
 *   1. team_members.active = false for Mario + Luis.
 *      Verified safe: both have 0 customers as CSM and 0 open tasks. Every
 *      assignee lookup filters on active = true (db.ts:1200-1240), so they drop
 *      out of routing with no orphans. Mansi becomes the sole Account Creator.
 *      Rows are kept, not deleted — Luis has 2 completed tasks holding the FK.
 *   2. brokerages.default_calendly_url  — 3 rows (Keyes, IPRE, B&W).
 *   3. workflow_templates.embed_url     — 5 booking rows (D2C/Keyes/IPRE/BW/Coach).
 *
 * DELIBERATELY OUT OF SCOPE: the 86 already-created open `tasks.embed_url`
 * rows. generate-tasks.ts:214 copies the URL onto each task at customer-create
 * time, so this run only fixes customers created from here on. Leaving the
 * backlog is the user's call (2026-10-18) — those bookings are likely stalled
 * for unrelated reasons and get revisited separately.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/offboard-mario-luis.ts          # dry-run
 *   npx tsx --env-file=.env.local scripts/offboard-mario-luis.ts --apply
 */

const OLD_URL = 'https://meetings-na2.hubspot.com/mario-giron/onboarding-meeting-link';
const NEW_URL = 'https://meetings-na2.hubspot.com/poorab/social-media-onboarding';
const OFFBOARD = ['mario@rejig.ai', 'luis@rejig.ai'];

async function main() {
  const apply = process.argv.includes('--apply');
  const { db } = await import('../src/db');
  const s = await import('../src/db/schema');
  const { eq, and, inArray, sql } = await import('drizzle-orm');

  console.log(`\nMode: ${apply ? 'APPLY' : 'DRY-RUN'}\n`);

  // ── 1. Deactivate ────────────────────────────────────────────────────────
  console.log('1. Deactivate team members');
  const people = await db.select().from(s.teamMembers).where(inArray(s.teamMembers.email, OFFBOARD));
  for (const p of people as Array<{ id: string; name: string; email: string; active: boolean }>) {
    const csmCount = (await db.select({ id: s.customers.id }).from(s.customers)
      .where(eq(s.customers.csmTeamMemberId, p.id))).length;
    const openTasks = (await db.select({ id: s.tasks.id }).from(s.tasks)
      .where(and(eq(s.tasks.assignedToTeamMemberId, p.id), inArray(s.tasks.status, ['Active', 'Draft'])))).length;

    if (csmCount > 0 || openTasks > 0) {
      console.log(`   ✗ ${p.name}: REFUSING — ${csmCount} customers as CSM, ${openTasks} open tasks. Reassign first.`);
      continue;
    }
    console.log(`   ${p.name.padEnd(8)} active=${p.active} → false   (0 CSM customers, 0 open tasks)`);
    if (apply) {
      await db.update(s.teamMembers).set({ active: false }).where(eq(s.teamMembers.id, p.id));
    }
  }

  // ── 2. Brokerage booking links ───────────────────────────────────────────
  console.log('\n2. brokerages.default_calendly_url');
  const brs = await db.select({ id: s.brokerages.id, n: s.brokerages.name, cal: s.brokerages.defaultCalendlyUrl })
    .from(s.brokerages).where(eq(s.brokerages.defaultCalendlyUrl, OLD_URL));
  for (const b of brs) console.log(`   ${String(b.n).padEnd(36)} → new link`);
  console.log(`   (${brs.length} row(s))`);
  if (apply && brs.length) {
    await db.update(s.brokerages).set({ defaultCalendlyUrl: NEW_URL })
      .where(eq(s.brokerages.defaultCalendlyUrl, OLD_URL));
  }

  // ── 3. Template booking links ────────────────────────────────────────────
  console.log('\n3. workflow_templates.embed_url');
  const tpl = await db.select({ wk: s.workflowTemplates.workflowKey, n: s.workflowTemplates.taskTitle })
    .from(s.workflowTemplates).where(eq(s.workflowTemplates.embedUrl, OLD_URL));
  for (const t of tpl) console.log(`   ${t.wk.padEnd(14)} ${t.n}`);
  console.log(`   (${tpl.length} row(s))`);
  if (apply && tpl.length) {
    await db.update(s.workflowTemplates).set({ embedUrl: NEW_URL })
      .where(eq(s.workflowTemplates.embedUrl, OLD_URL));
  }

  // ── Untouched, for visibility ────────────────────────────────────────────
  const openTaskRows = await db.select({ id: s.tasks.id }).from(s.tasks)
    .where(and(eq(s.tasks.embedUrl, OLD_URL), inArray(s.tasks.status, ['Active', 'Draft'])));
  console.log(`\n   NOT TOUCHED: ${openTaskRows.length} open tasks.embed_url rows still on the old link (by decision).`);

  console.log(`\n${apply ? 'APPLIED.' : 'Dry run — re-run with --apply to write.'}\n`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
