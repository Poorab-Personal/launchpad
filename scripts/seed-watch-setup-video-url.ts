/**
 * Phase 1.5.A3: set the Watch Setup Video URL on all 3 Core workflow_templates
 * rows + backfill in-flight customers' task rows.
 *
 * Idempotent. Re-runnable.
 *
 * Usage: npx tsx scripts/seed-watch-setup-video-url.ts
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const LOOM_URL = 'https://www.loom.com/share/8da6e238719c45e7b678bb2d053d533f';

async function main() {
  const { db } = await import('../src/db');
  const { workflowTemplates } = await import('../src/db/schema/workflowTemplates');
  const { tasks } = await import('../src/db/schema/tasks');
  const { and, eq, ne, inArray } = await import('drizzle-orm');

  // 1. Update workflow_templates rows.
  const templateRows = await db
    .update(workflowTemplates)
    .set({ embedUrl: LOOM_URL })
    .where(
      and(
        eq(workflowTemplates.taskTitle, 'Watch Setup Video'),
        inArray(workflowTemplates.workflowKey, ['D2C-Standard', 'B2B-Keyes', 'B2B-BW']),
      ),
    )
    .returning({
      workflowKey: workflowTemplates.workflowKey,
      embedUrl: workflowTemplates.embedUrl,
    });
  console.log(`Updated ${templateRows.length} workflow_templates rows:`);
  for (const r of templateRows) console.log(`  - [${r.workflowKey}] → ${r.embedUrl}`);

  // 2. Backfill existing customers' Watch Setup Video task rows.
  // Only touch tasks that are NOT yet Completed (Completed tasks have already
  // been "watched"; backfilling them would be misleading).
  const taskRows = await db
    .update(tasks)
    .set({ embedUrl: LOOM_URL })
    .where(
      and(
        eq(tasks.taskName, 'Watch Setup Video'),
        ne(tasks.status, 'Completed'),
        eq(tasks.product, 'Core'),
      ),
    )
    .returning({
      id: tasks.id,
      customerId: tasks.customerId,
      status: tasks.status,
    });
  console.log(`\nUpdated ${taskRows.length} in-flight tasks rows:`);
  for (const r of taskRows) console.log(`  - customer ${r.customerId} [${r.status}]`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
