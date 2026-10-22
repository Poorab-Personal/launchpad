import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

async function main() {
  const { db } = await import('../src/db');
  const { teamMembers } = await import('../src/db/schema/teamMembers');
  const { eq } = await import('drizzle-orm');

  const email = 'riccardo@rejig.ai';
  const existing = await db.select().from(teamMembers).where(eq(teamMembers.email, email));
  if (existing.length > 0) {
    console.log('already exists:', existing[0]);
    return;
  }

  const [inserted] = await db
    .insert(teamMembers)
    .values({
      name: 'Riccardo Trebbi',
      email,
      roles: ['Admin'],
    })
    .returning();

  console.log('inserted:', inserted);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
