/**
 * Phase 3.1 smoke: verify Auto 1 (generate-tasks) produces a complete
 * D2C-Standard set + dependencies + Customer Created event, then roll
 * back so no test data persists.
 *
 * Run: npx tsx --env-file=.env.local scripts/smoke-auto1.ts
 */
import { eq } from 'drizzle-orm';
import { db } from '../src/db';
import * as schema from '../src/db/schema';
import { generateTasksFromTemplate } from '../src/lib/automations/generate-tasks';

async function main() {
  // Wrap in a transaction we'll deliberately roll back.
  try {
    await db.transaction(async (tx) => {
      const standardChannel = await tx.query.channels.findFirst({
        where: eq(schema.channels.code, 'Standard'),
      });
      if (!standardChannel) throw new Error('Standard channel not seeded');

      const [customer] = await tx
        .insert(schema.customers)
        .values({
          name: 'Smoke Auto1',
          type: 'D2C',
          channelId: standardChannel.id,
          workflowKey: 'D2C-Standard',
          contactEmail: 'smoke@example.com',
          platformEmail: 'smoke@example.com',
          currentStage: 'Getting Started',
        })
        .returning();

      const result = await generateTasksFromTemplate(tx, {
        customerId: customer.id,
        type: 'D2C',
        channel: 'Standard',
        brokerageId: null,
        hasVoice: false,
        hasAvatar: false,
      });

      console.log('Auto 1 result:', result);

      // Verify
      const taskRows = await tx
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.customerId, customer.id));
      const depRows = await tx
        .select()
        .from(schema.taskDependencies)
        .where(
          eq(
            schema.taskDependencies.taskId,
            taskRows[0]?.id ?? '00000000-0000-0000-0000-000000000000',
          ),
        );
      const eventRows = await tx
        .select()
        .from(schema.events)
        .where(eq(schema.events.customerId, customer.id));
      const updatedCustomer = await tx.query.customers.findFirst({
        where: eq(schema.customers.id, customer.id),
      });

      console.log(`  Tasks created:        ${taskRows.length}`);
      console.log(`  Active tasks at gen:  ${taskRows.filter((t) => t.status === 'Active').length}`);
      console.log(`  Draft tasks at gen:   ${taskRows.filter((t) => t.status === 'Draft').length}`);
      console.log(`  Dependencies total:   ${await tx.$count(schema.taskDependencies)} (across all customers — this txn's contribution rolls back)`);
      console.log(`  Events created:       ${eventRows.length}`);
      console.log(`  Customer.currentStage: ${updatedCustomer?.currentStage}`);
      console.log(`  Customer.stageEnteredAt set: ${updatedCustomer?.stageEnteredAt !== null}`);

      // Sanity checks
      const expectedDtcTasks = 17;
      if (result.coreCount !== expectedDtcTasks) {
        throw new Error(`Expected ${expectedDtcTasks} Core tasks for D2C-Standard, got ${result.coreCount}`);
      }
      if (!result.firstStage) {
        throw new Error('No firstStage returned');
      }

      console.log('\nSmoke PASSED — rolling back txn.');
      throw new Error('__intentional_rollback__');
    });
  } catch (err) {
    if (err instanceof Error && err.message === '__intentional_rollback__') {
      console.log('Rollback complete; no test data persisted.');
      process.exit(0);
    }
    throw err;
  }
}

main().catch((err) => {
  console.error('Smoke FAILED:', err);
  process.exit(1);
});
