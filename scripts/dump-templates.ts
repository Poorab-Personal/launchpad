import { asc, eq } from 'drizzle-orm';
import { db } from '../src/db';
import { workflowTemplates } from '../src/db/schema';

async function main() {
  const rows = await db
    .select()
    .from(workflowTemplates)
    .where(eq(workflowTemplates.workflowKey, 'D2C-Standard'))
    .orderBy(asc(workflowTemplates.stageOrder), asc(workflowTemplates.taskOrder));
  console.log(`D2C-Standard: ${rows.length} templates`);
  for (const r of rows) {
    console.log(`  s${r.stageOrder} t${r.taskOrder} [${r.initialStatus.padEnd(5)}] ${r.stage} / ${r.taskTitle}`);
  }
  process.exit(0);
}
main();
