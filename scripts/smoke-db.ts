/**
 * Phase 2.1 smoke test — verify db.ts queries work against live Neon.
 * Reads seeded config data; no writes.
 *
 * Run: tsx --env-file=.env.local scripts/smoke-db.ts
 */
import {
  getAvailableWorkflows,
  getBrokerageBySlug,
  getCustomers,
  getStripePlansByWorkflow,
  getTeamMembers,
  getTeamMembersByRole,
  getWorkflowTemplates,
} from '../src/lib/db';

async function main() {
  console.log('--- getCustomers ---');
  const customers = await getCustomers();
  console.log(`  ${customers.length} customers`);

  console.log('--- getTeamMembers (active) ---');
  const team = await getTeamMembers();
  console.log(`  ${team.length} team members`);
  team.forEach((t) => console.log(`    ${t.name.padEnd(25)} role=${t.role}`));

  console.log('--- getTeamMembersByRole("Designer") ---');
  const designers = await getTeamMembersByRole('Designer');
  console.log(`  ${designers.length} designers`);

  console.log('--- getBrokerageBySlug ---');
  // We don't know the seeded slugs; try the known B2B ones
  for (const slug of ['keyes', 'baird-warner', 'bw']) {
    const b = await getBrokerageBySlug(slug);
    if (b) console.log(`    slug=${slug} → name="${b.name}" workflow=${b.defaultWorkflowKey}`);
  }

  console.log('--- getAvailableWorkflows ---');
  const workflows = await getAvailableWorkflows();
  workflows.forEach((w) => console.log(`    ${w.workflowKey}  (type=${w.type}, channel=${w.channel})`));

  console.log('--- getWorkflowTemplates("D2C-Standard") ---');
  const tpls = await getWorkflowTemplates('D2C-Standard');
  console.log(`  ${tpls.length} templates for D2C-Standard`);
  if (tpls[0]) console.log(`    first: ${tpls[0].stage} / ${tpls[0].taskTitle}`);

  console.log('--- getStripePlansByWorkflow("B2B-Keyes") ---');
  const plans = await getStripePlansByWorkflow('B2B-Keyes');
  plans.forEach((p) => console.log(`    ${p.planName} (${p.stripePriceId}) ${p.priceDisplay}${p.pricePeriod}`));

  console.log('\nAll queries returned without error.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Smoke failed:', err);
  process.exit(1);
});
