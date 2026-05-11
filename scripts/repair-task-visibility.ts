/**
 * One-shot: repair tasks.visible_to_client by syncing from the (now-fixed)
 * workflow_templates table. Joins on (workflow_key, task_title) so revision
 * tasks (no template match) keep their current value.
 *
 * Run: npx tsx --env-file=.env.local scripts/repair-task-visibility.ts
 */
import { sql } from 'drizzle-orm';
import { db } from '../src/db';

async function main() {
  const result = await db.execute(sql`
    UPDATE tasks t
    SET visible_to_client = wt.visible_to_client
    FROM workflow_templates wt, customers c
    WHERE c.id = t.customer_id
      AND wt.workflow_key = c.workflow_key
      AND wt.task_title = t.task_name
      AND t.visible_to_client IS DISTINCT FROM wt.visible_to_client
    RETURNING t.id, t.task_name, t.visible_to_client
  `);
  console.log(`Updated ${result.rows.length} task rows.`);
  for (const row of result.rows.slice(0, 30)) {
    console.log(`  ${row.task_name} → visible_to_client=${row.visible_to_client}`);
  }
  if (result.rows.length > 30) console.log(`  ...and ${result.rows.length - 30} more`);
  process.exit(0);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
