import { asc, eq } from 'drizzle-orm';
import { db } from '../src/db';
import { tasks, taskDependencies, workflowTemplates } from '../src/db/schema';

async function main() {
  // Template deps for D2C-Standard
  const tpls = await db
    .select()
    .from(workflowTemplates)
    .where(eq(workflowTemplates.workflowKey, 'D2C-Standard'))
    .orderBy(asc(workflowTemplates.stageOrder), asc(workflowTemplates.taskOrder));
  console.log('D2C-Standard template depends_on:');
  for (const t of tpls) {
    if (t.dependsOn) console.log(`  ${t.taskTitle} ← ${t.dependsOn}`);
  }

  // Most recent customer's task deps (via junction table)
  const recentTasks = await db.select().from(tasks).orderBy(asc(tasks.createdAt));
  const latestCustomer = recentTasks[recentTasks.length - 1]?.customerId;
  if (!latestCustomer) return;

  console.log(`\nMost recent customer ${latestCustomer} — task graph:`);
  const custTasks = recentTasks.filter((t) => t.customerId === latestCustomer);
  const taskById = new Map(custTasks.map((t) => [t.id, t]));

  for (const t of custTasks) {
    const deps = await db.select().from(taskDependencies).where(eq(taskDependencies.taskId, t.id));
    const depNames = deps
      .map((d) => taskById.get(d.dependsOnTaskId)?.taskName ?? '?')
      .join(', ');
    console.log(`  [${t.status.padEnd(9)}] ${t.taskName} ← ${depNames || '(no deps)'}`);
  }
  process.exit(0);
}
main();
