/**
 * Phase 3.2 smoke: verify Auto 2 (activate-dependents + advance-stage)
 * fires correctly on task completion.
 *
 * Setup: creates a D2C-Standard customer + its 17 tasks via Auto 1.
 * Verify: Complete the initial Active task → expect dependent activation.
 *         Complete all stage-1 tasks → expect stage advance to "Review Your Designs".
 * Cleanup: DELETE customer; FK cascades remove tasks/events/dependencies.
 *
 * Run: npx tsx --env-file=.env.local scripts/smoke-auto2.ts
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../src/db';
import * as schema from '../src/db/schema';
import { generateTasksFromTemplate } from '../src/lib/automations/generate-tasks';
import { updateTaskStatus } from '../src/lib/db';

async function setup(): Promise<{ customerId: string }> {
  const channel = await db.query.channels.findFirst({
    where: eq(schema.channels.code, 'Standard'),
  });
  if (!channel) throw new Error('Standard channel not seeded');

  const customerId = await db.transaction(async (tx) => {
    const [c] = await tx
      .insert(schema.customers)
      .values({
        name: 'Smoke Auto2',
        type: 'D2C',
        channelId: channel.id,
        workflowKey: 'D2C-Standard',
        contactEmail: 'smoke-auto2@example.com',
        platformEmail: 'smoke-auto2@example.com',
        currentStage: 'Getting Started',
      })
      .returning();
    await generateTasksFromTemplate(tx, {
      customerId: c.id,
      type: 'D2C',
      channel: 'Standard',
      brokerageId: null,
      hasVoice: false,
      hasAvatar: false,
    });
    return c.id;
  });
  return { customerId };
}

async function cleanup(customerId: string): Promise<void> {
  // FK CASCADE on tasks.customer_id, events.customer_id, etc. cleans up.
  await db.delete(schema.customers).where(eq(schema.customers.id, customerId));
}

async function snapshot(customerId: string) {
  const tasks = await db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.customerId, customerId));
  const events = await db
    .select()
    .from(schema.events)
    .where(eq(schema.events.customerId, customerId));
  const customer = await db.query.customers.findFirst({
    where: eq(schema.customers.id, customerId),
  });
  return {
    activeCount: tasks.filter((t) => t.status === 'Active').length,
    completedCount: tasks.filter((t) => t.status === 'Completed').length,
    draftCount: tasks.filter((t) => t.status === 'Draft').length,
    currentStage: customer?.currentStage,
    eventTypes: events.map((e) => e.eventType),
    tasks,
  };
}

async function main() {
  const { customerId } = await setup();
  try {
    console.log('--- Initial state after Auto 1 ---');
    let s = await snapshot(customerId);
    console.log(`  Active: ${s.activeCount}, Draft: ${s.draftCount}, Completed: ${s.completedCount}`);
    console.log(`  Stage: ${s.currentStage}`);

    // Complete the initial Active task ("Complete Your Onboarding Form")
    const initialActive = s.tasks.find((t) => t.status === 'Active');
    if (!initialActive) throw new Error('No initial Active task — Auto 1 broken?');
    console.log(`\n--- Completing "${initialActive.taskName}" ---`);
    await updateTaskStatus(initialActive.id, 'Completed');

    s = await snapshot(customerId);
    console.log(`  Active: ${s.activeCount}, Draft: ${s.draftCount}, Completed: ${s.completedCount}`);
    console.log(`  Events fired: ${s.eventTypes.length}: ${s.eventTypes.join(', ')}`);
    if (s.completedCount !== 1) throw new Error(`Expected 1 completed, got ${s.completedCount}`);
    // After completing the form, "Upload Logos" should still be Active (no deps; it was initially Active).
    // "Create Designs" depends on both → still Draft until Upload Logos completes.

    // Complete remaining stage-1 Active tasks to trigger stage advance.
    console.log(`\n--- Completing remaining Stage 1 Active tasks ---`);
    let s2 = await snapshot(customerId);
    const stage1Active = s2.tasks.filter((t) => t.stage === 'Getting Started' && t.status === 'Active');
    for (const t of stage1Active) {
      console.log(`  Completing "${t.taskName}"`);
      await updateTaskStatus(t.id, 'Completed');
    }
    s2 = await snapshot(customerId);
    const stage1Draft = s2.tasks.filter((t) => t.stage === 'Getting Started' && t.status === 'Draft');
    for (const t of stage1Draft) {
      // Internal team tasks (Create Designs) are now Active after their deps cleared
      // We need to complete them too to fully clear stage 1.
      const taskNow = s2.tasks.find((x) => x.id === t.id);
      if (taskNow?.status === 'Active') {
        console.log(`  Completing "${t.taskName}" (was Draft, now Active)`);
        await updateTaskStatus(t.id, 'Completed');
      }
    }
    // Re-fetch and complete any newly-activated stage 1 tasks
    s2 = await snapshot(customerId);
    const stage1Remaining = s2.tasks.filter((t) => t.stage === 'Getting Started' && t.status === 'Active');
    for (const t of stage1Remaining) {
      console.log(`  Completing "${t.taskName}" (newly activated)`);
      await updateTaskStatus(t.id, 'Completed');
    }

    s2 = await snapshot(customerId);
    console.log(`\n--- After Stage 1 fully complete ---`);
    console.log(`  Active: ${s2.activeCount}, Draft: ${s2.draftCount}, Completed: ${s2.completedCount}`);
    console.log(`  Stage: ${s2.currentStage}`);
    console.log(`  Stage Changed events: ${s2.eventTypes.filter((e) => e === 'Stage Changed').length}`);
    const stage1All = s2.tasks.filter((t) => t.stage === 'Getting Started');
    const stage1Done = stage1All.every((t) => t.status === 'Completed');
    console.log(`  Stage 1 all completed: ${stage1Done} (${stage1All.length} tasks)`);

    if (s2.currentStage !== 'Review Your Designs') {
      throw new Error(`Expected stage advance to "Review Your Designs", got "${s2.currentStage}"`);
    }
    if (!s2.eventTypes.includes('Stage Changed')) {
      throw new Error(`Expected Stage Changed event`);
    }

    console.log('\nSmoke PASSED.');
  } finally {
    await cleanup(customerId);
    console.log(`Cleanup: customer ${customerId} deleted (FK cascade removed tasks/events/deps).`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Smoke FAILED:', err);
  process.exit(1);
});
