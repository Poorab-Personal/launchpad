import { asc, eq } from 'drizzle-orm';
import { db } from '../src/db';
import { workflowTemplates, tasks } from '../src/db/schema';

async function main() {
  const tpls = await db
    .select()
    .from(workflowTemplates)
    .where(eq(workflowTemplates.workflowKey, 'D2C-Standard'))
    .orderBy(asc(workflowTemplates.stageOrder), asc(workflowTemplates.taskOrder));
  console.log('D2C-Standard templates — visibleToClient flag:');
  for (const t of tpls) {
    console.log(`  s${t.stageOrder} ${t.stage.padEnd(28)} [vis=${t.visibleToClient}] ${t.taskType}/${t.taskTitle}`);
  }

  // Compare to actual tasks created
  const recentTasks = await db
    .select()
    .from(tasks)
    .orderBy(asc(tasks.createdAt));
  const latestCustomer = recentTasks[recentTasks.length - 1]?.customerId;
  if (latestCustomer) {
    console.log(`\nMost recent customer (${latestCustomer}) tasks — visibleToClient flag:`);
    const custTasks = recentTasks.filter((t) => t.customerId === latestCustomer);
    for (const t of custTasks) {
      console.log(`  s${t.stageOrder} ${t.stage.padEnd(28)} [vis=${t.visibleToClient}] ${t.taskType}/${t.taskName} status=${t.status}`);
    }
  }
  process.exit(0);
}
main();
