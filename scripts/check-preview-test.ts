import { and, asc, eq } from 'drizzle-orm';
import { db } from '../src/db';
import { customers, tasks, workflowTemplates, taskDependencies } from '../src/db/schema';

async function main() {
  // Find the test customer
  const cust = await db.query.customers.findFirst({
    where: eq(customers.name, 'Poorab Preview Test'),
  });
  if (!cust) {
    console.log('No customer with name "Poorab Preview Test"');
    process.exit(1);
  }
  console.log(`Customer: ${cust.id} | workflow=${cust.workflowKey} | currentStage=${cust.currentStage}`);

  // Templates for this workflow
  const tpls = await db
    .select()
    .from(workflowTemplates)
    .where(eq(workflowTemplates.workflowKey, cust.workflowKey))
    .orderBy(asc(workflowTemplates.stageOrder), asc(workflowTemplates.taskOrder));
  console.log(`\n=== ${cust.workflowKey} templates ===`);
  for (const t of tpls) {
    console.log(`  s${t.stageOrder} ${t.stage.padEnd(28)} [${t.initialStatus.padEnd(5)}] ${t.taskTitle.padEnd(40)} dependsOn=${t.dependsOn ?? '(none)'}`);
  }

  // Customer's actual tasks
  const custTasks = await db
    .select()
    .from(tasks)
    .where(eq(tasks.customerId, cust.id))
    .orderBy(asc(tasks.stageOrder), asc(tasks.taskOrder));
  console.log(`\n=== ${cust.name} tasks ===`);
  for (const t of custTasks) {
    const deps = await db
      .select()
      .from(taskDependencies)
      .where(eq(taskDependencies.taskId, t.id));
    const depNames = await Promise.all(
      deps.map(async (d) => {
        const s = await db.query.tasks.findFirst({ where: eq(tasks.id, d.dependsOnTaskId), columns: { taskName: true } });
        return s?.taskName ?? '?';
      }),
    );
    console.log(
      `  s${t.stageOrder} ${t.stage.padEnd(28)} [${t.status.padEnd(9)}] ${t.taskName.padEnd(40)} deps=${depNames.join(', ') || '(none)'}`,
    );
  }
  process.exit(0);
}
main();
