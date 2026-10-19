import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

/**
 * Ruhl pilot → launch: add the onboarding booking task, switch to invoice
 * billing, wire the managed-cc address, and backfill service options.
 *
 * B2B-RUHL was seeded as B2B-BW minus the booking task and with
 * payment_mode='none' (scripts/seed-ruhl-launch.ts, 2026-07-25 — intake form
 * only, no Stripe, no onboarding call). Both were pilot decisions. This brings
 * it in line with B2B-BW.
 *
 *   1. Insert "Schedule Your Onboarding Call" at stage 1, task order 2
 *      (matching B2B-BW), and bump Create Designs to task order 3.
 *   2. payment_mode 'none' → 'invoice' across all B2B-RUHL template rows.
 *   3. Ruhl brokerage: default_calendly_url + managed_cc_email.
 *   4. Backfill customers.service_option for the 15 agents who submitted.
 *
 * Only agents who actually submitted the intake form are backfilled. The three
 * who landed without submitting stay NULL — we never asked them, and NULL is
 * the honest reading.
 *
 * Templates generate tasks at customer-create time, so step 1 affects only
 * agents created from here on. The 15 existing agents keep their task lists.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/ruhl-launch-service-options.ts
 *   npx tsx --env-file=.env.local scripts/ruhl-launch-service-options.ts --apply
 */

const RUHL_BROKERAGE_ID = 'b6e138ee-63b4-400f-9f88-8643ea3e22f9';
const BOOKING_TASK = 'Schedule Your Onboarding Call';
const ONBOARDING_URL = 'https://meetings-na2.hubspot.com/poorab/social-media-onboarding';
const MANAGED_CC = 'marketing@ruhlhomes.com';

/** Source: Ruhl's enrollment tracker + user confirmation 2026-10-18. */
const SELF_MANAGED = [
  'Mary Schoon', 'Megan Stopulos', 'Bob Kelly', 'Carrie Lamb',
  'Sara Carlson', 'Jeramy Jennings', 'Laura Custis', 'Ashley Block',
  'Hannah Peart', 'Kenny Hora', 'Christina Rader',
];
const BROKERAGE_MANAGED = ['Rachel Anderson', 'Otto Nobis', 'Nathan Stout', 'Joni Paaske'];

async function main() {
  const apply = process.argv.includes('--apply');
  const { db } = await import('../src/db');
  const s = await import('../src/db/schema');
  const { eq, and, inArray } = await import('drizzle-orm');

  console.log(`\nMode: ${apply ? 'APPLY' : 'DRY-RUN'}\n`);

  // ── 1. Booking task ──────────────────────────────────────────────────────
  console.log('1. B2B-RUHL template: add booking task');
  const existing = await db.select({ id: s.workflowTemplates.id })
    .from(s.workflowTemplates)
    .where(and(eq(s.workflowTemplates.workflowKey, 'B2B-RUHL'),
               eq(s.workflowTemplates.taskTitle, BOOKING_TASK)));

  if (existing.length) {
    console.log('   already present — skipping (idempotent)');
  } else {
    const [bw] = await db.select().from(s.workflowTemplates)
      .where(and(eq(s.workflowTemplates.workflowKey, 'B2B-BW'),
                 eq(s.workflowTemplates.taskTitle, BOOKING_TASK)));
    if (!bw) throw new Error('B2B-BW booking template row not found — cannot clone.');

    const { id: _drop, ...rest } = bw as Record<string, unknown> & { id: string };
    const row = { ...rest, workflowKey: 'B2B-RUHL', embedUrl: ONBOARDING_URL, paymentMode: 'invoice' };
    console.log(`   clone from B2B-BW → stage="${bw.stage}" order=${bw.stageOrder}.${bw.taskOrder} dep="${bw.dependsOn}"`);
    console.log(`   and bump "Create Designs" task_order 2 → 3`);
    if (apply) {
      await db.update(s.workflowTemplates).set({ taskOrder: 3 })
        .where(and(eq(s.workflowTemplates.workflowKey, 'B2B-RUHL'),
                   eq(s.workflowTemplates.taskTitle, 'Create Designs')));
      await db.insert(s.workflowTemplates).values(row as never);
    }
  }

  // ── 2. payment_mode ──────────────────────────────────────────────────────
  console.log('\n2. B2B-RUHL payment_mode → invoice');
  const pm = await db.select({ n: s.workflowTemplates.taskTitle, m: s.workflowTemplates.paymentMode })
    .from(s.workflowTemplates).where(eq(s.workflowTemplates.workflowKey, 'B2B-RUHL'));
  console.log(`   ${pm.length} row(s), currently: ${[...new Set(pm.map(x => x.m))].join(', ')}`);
  if (apply) {
    await db.update(s.workflowTemplates).set({ paymentMode: 'invoice' })
      .where(eq(s.workflowTemplates.workflowKey, 'B2B-RUHL'));
  }

  // ── 3. Brokerage config ──────────────────────────────────────────────────
  console.log('\n3. Ruhl brokerage config');
  console.log(`   default_calendly_url → ${ONBOARDING_URL}`);
  console.log(`   managed_cc_email     → ${MANAGED_CC}`);
  if (apply) {
    await db.update(s.brokerages)
      .set({ defaultCalendlyUrl: ONBOARDING_URL, managedCcEmail: MANAGED_CC })
      .where(eq(s.brokerages.id, RUHL_BROKERAGE_ID));
  }

  // ── 4. Backfill service_option ───────────────────────────────────────────
  console.log('\n4. Backfill customers.service_option');
  const cust = await db.select({ id: s.customers.id, name: s.customers.name, so: s.customers.serviceOption })
    .from(s.customers).where(eq(s.customers.brokerageId, RUHL_BROKERAGE_ID));

  const byName = new Map(cust.map(c => [c.name, c]));
  let set = 0;
  const missing: string[] = [];
  for (const [list, value] of [[SELF_MANAGED, 'Self-Managed'], [BROKERAGE_MANAGED, 'Brokerage-Managed']] as const) {
    for (const name of list) {
      const c = byName.get(name);
      if (!c) { missing.push(name); continue; }
      if (c.so === value) continue;
      console.log(`   ${name.padEnd(20)} ${c.so ?? 'NULL'} → ${value}`);
      set++;
      if (apply) {
        await db.update(s.customers).set({ serviceOption: value }).where(eq(s.customers.id, c.id));
      }
    }
  }
  const untouched = cust.filter(c => !SELF_MANAGED.includes(c.name) && !BROKERAGE_MANAGED.includes(c.name));
  console.log(`   to set: ${set}  |  left NULL (never submitted): ${untouched.map(c => c.name).join(', ') || 'none'}`);
  if (missing.length) console.log(`   ⚠ NOT FOUND in LP: ${missing.join(', ')}`);

  console.log(`\n${apply ? 'APPLIED.' : 'Dry run — re-run with --apply to write.'}\n`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
