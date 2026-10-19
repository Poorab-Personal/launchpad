import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

/**
 * Ruhl roster vs LaunchPad: who has actually SUBMITTED the intake form.
 *
 * "Submitted" = the B2B-RUHL intake task ('Confirm Your Information') is
 * Completed — the same event that fires the Slack intake alert
 * (SLACK_INTAKE_TRIGGER_TASK in activate-dependents.ts). Landing on the page
 * and creating a customer row does NOT count.
 *
 * Usage: npx tsx scripts/ruhl-submission-status.ts
 */

const RUHL_BROKERAGE_ID = 'b6e138ee-63b4-400f-9f88-8643ea3e22f9';
const INTAKE_TASK = 'Confirm Your Information';

async function main() {
  const { db } = await import('../src/db');
  const schema = await import('../src/db/schema');
  const { eq, and } = await import('drizzle-orm');

  const rows = await db
    .select({
      id: schema.customers.id,
      name: schema.customers.name,
      email: schema.customers.contactEmail,
      createdAt: schema.customers.createdAt,
      currentStage: schema.customers.currentStage,
      onboardingState: schema.customers.onboardingState,
      accountCreated: schema.customers.accountCreated,
      credentialsSent: schema.customers.credentialsSent,
    })
    .from(schema.customers)
    .where(eq(schema.customers.brokerageId, RUHL_BROKERAGE_ID));

  const out: Array<{
    name: string;
    email: string | null;
    created: Date | null;
    submitted: Date | null;
    stage: string | null;
    hs: string | null;
    acct: boolean | null;
  }> = [];

  for (const c of rows) {
    const t = await db
      .select({ status: schema.tasks.status, completedAt: schema.tasks.completedAt })
      .from(schema.tasks)
      .where(and(eq(schema.tasks.customerId, c.id), eq(schema.tasks.taskName, INTAKE_TASK)));

    const intake = t[0];
    out.push({
      name: c.name,
      email: c.email,
      created: c.createdAt,
      submitted: intake?.status === 'Completed' ? (intake.completedAt ?? null) : null,
      stage: c.currentStage,
      hs: c.onboardingState,
      acct: c.accountCreated,
    });
  }

  const fmt = (d: Date | null) =>
    d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '—';

  const submitted = out.filter((r) => r.submitted).sort((a, b) => +a.submitted! - +b.submitted!);
  const landed = out.filter((r) => !r.submitted).sort((a, b) => +(a.created ?? 0) - +(b.created ?? 0));

  console.log(`\n=== SUBMITTED (${submitted.length}) — intake form completed, Slack alert fired ===\n`);
  for (const r of submitted) {
    console.log(
      `  ${r.name.padEnd(24)} ${fmt(r.submitted).padEnd(18)} ${(r.stage ?? '-').padEnd(26)} HS=${(r.hs ?? '-').padEnd(14)} acct=${r.acct ? 'Y' : 'n'}`,
    );
  }

  console.log(`\n=== LANDED ONLY (${landed.length}) — row exists, never submitted ===\n`);
  for (const r of landed) {
    console.log(`  ${r.name.padEnd(24)} created ${fmt(r.created).padEnd(18)} ${(r.email ?? '-')}`);
  }

  console.log(`\nTotal Ruhl rows in LP: ${out.length}\n`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
