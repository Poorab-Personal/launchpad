/**
 * Audit customers stuck pre-Launched — specifically:
 *   1. Stuck in design approval (task "Review & Approve Your Brand Kit"
 *      Active, or stuck in a revision round) — waiting on the customer.
 *   2. Haven't booked their onboarding call (task "Schedule Your Onboarding
 *      Call" Active, callBooked = false) — approved designs but no call.
 *
 * D2C-Standard is the primary target (that's the flow with a design-approval
 * gate before call booking), but the query isn't hardcoded to it — any
 * customer with those task names stuck Active shows up.
 *
 * Excludes environment @> '{test}' customers and Launched customers.
 *
 * Usage: npx tsx scripts/audit-stuck-customers.ts [--include-test]
 */
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { db } from '@/db';
import * as schema from '@/db/schema';

const DESIGN_APPROVAL_TASK = 'Review & Approve Your Brand Kit';
const SCHEDULE_CALL_TASK = 'Schedule Your Onboarding Call';

function daysSince(d: Date | null): number {
  if (!d) return 0;
  return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
}

async function main() {
  const includeTest = process.argv.includes('--include-test');

  const allCustomers = await db.query.customers.findMany({
    where: ne(schema.customers.currentStage, 'Launched'),
  });

  const customers = includeTest
    ? allCustomers
    : allCustomers.filter((c) => !c.environment?.includes('test'));

  const customerIds = customers.map((c) => c.id);
  if (customerIds.length === 0) {
    console.log('No non-Launched customers found.');
    process.exit(0);
  }

  const relevantTasks = await db
    .select()
    .from(schema.tasks)
    .where(
      and(
        inArray(schema.tasks.customerId, customerIds),
        eq(schema.tasks.status, 'Active'),
      ),
    );

  const tasksByCustomer = new Map<string, typeof relevantTasks>();
  for (const t of relevantTasks) {
    const arr = tasksByCustomer.get(t.customerId) ?? [];
    arr.push(t);
    tasksByCustomer.set(t.customerId, arr);
  }

  type Row = {
    customer: (typeof customers)[number];
    task: (typeof relevantTasks)[number];
    bucket: 'design_approval' | 'no_call_booked';
  };

  const rows: Row[] = [];

  for (const c of customers) {
    const active = tasksByCustomer.get(c.id) ?? [];
    for (const t of active) {
      if (t.taskName === DESIGN_APPROVAL_TASK || /^Review & Approve Your Brand Kit/.test(t.taskName)) {
        rows.push({ customer: c, task: t, bucket: 'design_approval' });
      } else if (t.taskName === SCHEDULE_CALL_TASK) {
        rows.push({ customer: c, task: t, bucket: 'no_call_booked' });
      }
    }
  }

  rows.sort((a, b) => daysSince(b.task.activatedAt) - daysSince(a.task.activatedAt));

  const designRows = rows.filter((r) => r.bucket === 'design_approval');
  const callRows = rows.filter((r) => r.bucket === 'no_call_booked');

  console.log(`=== Stuck at Design Approval (${designRows.length}) ===`);
  console.log('Waiting on customer to Approve or Request Changes on their brand kit proof.\n');
  for (const r of designRows) {
    const c = r.customer;
    const d = daysSince(r.task.activatedAt);
    console.log(
      `  ${d.toString().padStart(3)}d  ${c.name.padEnd(30)} ${c.workflowKey.padEnd(14)} rev#${c.designRevisionCount}  ${c.contactEmail}  /r/${c.accessToken}`,
    );
  }

  console.log(`\n=== Stuck — Haven't Booked Onboarding Call (${callRows.length}) ===`);
  console.log('Design approved, waiting on customer to book their Calendly onboarding call.\n');
  for (const r of callRows) {
    const c = r.customer;
    const d = daysSince(r.task.activatedAt);
    console.log(
      `  ${d.toString().padStart(3)}d  ${c.name.padEnd(30)} ${c.workflowKey.padEnd(14)} callBooked=${c.callBooked}  ${c.contactEmail}  /r/${c.accessToken}`,
    );
  }

  console.log(`\nTotal customers scanned: ${customers.length} (non-Launched${includeTest ? '' : ', excl. test'})`);
  console.log(`Stuck total: ${rows.length} (${designRows.length} design-approval, ${callRows.length} no-call-booked)`);

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
