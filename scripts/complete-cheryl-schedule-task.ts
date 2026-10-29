import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

/**
 * Cheryl Doyle's onboarding call was booked manually, outside HubSpot, so the
 * portal's booking embed never fired its completion postMessage and
 * "Schedule Your Onboarding Call" stayed Active — pinning her current_stage at
 * "Review Your Designs" and showing her a booking link for a meeting she has
 * already got.
 *
 * Completed via updateTaskStatus (never a raw UPDATE) so Auto 2 runs: the task
 * is a leaf (nothing depends on it), so this activates nothing new — it only
 * lets stage advance re-evaluate stage 2 and carry her to "Prepare for
 * Onboarding", where her already-Active Watch Setup Video + Sign In steps live.
 *
 * Idempotent: updateTaskStatus race-guards on `status != 'Completed'`.
 */
const CUSTOMER_ID = '151db493-c0b3-42cd-afb3-f96b03de7066';
const TASK_NAME = 'Schedule Your Onboarding Call';

async function main() {
  const { db } = await import('../src/db');
  const schema = await import('../src/db/schema');
  const { and, eq } = await import('drizzle-orm');
  const { updateTaskStatus } = await import('../src/lib/db');

  const task = await db.query.tasks.findFirst({
    where: and(
      eq(schema.tasks.customerId, CUSTOMER_ID),
      eq(schema.tasks.taskName, TASK_NAME),
    ),
  });
  if (!task) throw new Error(`Task "${TASK_NAME}" not found for ${CUSTOMER_ID}`);
  if (task.status === 'Completed') {
    console.log('already Completed — no-op');
    return;
  }

  console.log(`before: ${task.taskName} = ${task.status}`);
  const updated = await updateTaskStatus(task.id, 'Completed');
  console.log(`after:  ${updated.taskName} = ${updated.status}`);

  const cust = await db.query.customers.findFirst({
    where: eq(schema.customers.id, CUSTOMER_ID),
    columns: { currentStage: true, onboardingState: true },
  });
  console.log('customer stage now:', cust?.currentStage, '| onboarding_state:', cust?.onboardingState);

  const open = await db.query.tasks.findMany({
    where: and(eq(schema.tasks.customerId, CUSTOMER_ID), eq(schema.tasks.status, 'Active')),
    columns: { taskName: true, taskType: true },
  });
  console.log('still Active:', open.map((t) => `${t.taskName} (${t.taskType})`).join(', ') || '(none)');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
