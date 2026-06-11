import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

async function main() {
  const { db } = await import('../src/db');
  const { teamMembers } = await import('../src/db/schema/teamMembers');

  const toAdd: Array<typeof teamMembers.$inferInsert> = [
    { name: 'Matt Maier', email: 'matt@rejig.ai', roles: ['Sales'] },
    { name: 'Rafael Mata', email: 'rafa@rejig.ai', roles: ['Sales'] },
  ];

  for (const m of toAdd) {
    const result = await db
      .insert(teamMembers)
      .values(m)
      .onConflictDoNothing({ target: teamMembers.email })
      .returning({ id: teamMembers.id, name: teamMembers.name, email: teamMembers.email });
    if (result.length > 0) {
      console.log(`  ✓ inserted ${result[0].name} <${result[0].email}> (id=${result[0].id})`);
    } else {
      console.log(`  → ${m.email} already exists — skipped`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
