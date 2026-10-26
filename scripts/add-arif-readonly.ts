import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

/**
 * Arif gets read-only access. `Sales` is the view-only role in this
 * codebase (src/app/workspace/page.tsx: "view-only over the customer
 * list"), and critically it is the only non-Admin role that no
 * workflow_template assigns work to — so resolveDefaultTeamMemberForRole
 * can never auto-assign him a real task.
 */
async function main() {
  const { db } = await import('../src/db');
  const { teamMembers } = await import('../src/db/schema/teamMembers');

  const result = await db
    .insert(teamMembers)
    .values({ name: 'Arif Rathod', email: 'arif@rejig.ai', roles: ['Sales'] })
    .onConflictDoNothing({ target: teamMembers.email })
    .returning();

  if (result.length > 0) {
    console.log('inserted:', result[0]);
  } else {
    console.log('arif@rejig.ai already exists — skipped');
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
