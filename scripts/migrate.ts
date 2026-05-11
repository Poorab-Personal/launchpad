/**
 * Apply pending Drizzle migrations.
 *
 * Wraps drizzle-orm/neon-serverless/migrator using the same Pool/driver as
 * src/db/index.ts. We use this instead of `drizzle-kit migrate` because
 * drizzle-kit's migrate command can hang when paired with the neon-serverless
 * adapter (the WebSocket lifecycle doesn't close cleanly inside drizzle-kit's
 * process model).
 *
 * Run: npm run db:migrate
 */
import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { migrate } from 'drizzle-orm/neon-serverless/migrator';
import ws from 'ws';

async function main() {
  if (!process.env.POSTGRES_URL_NON_POOLING) {
    throw new Error('POSTGRES_URL_NON_POOLING is required for migrations (direct connection, no pgbouncer)');
  }

  neonConfig.webSocketConstructor = ws;
  const pool = new Pool({ connectionString: process.env.POSTGRES_URL_NON_POOLING });
  const db = drizzle(pool);

  console.log('Applying migrations from src/db/migrations ...');
  await migrate(db, { migrationsFolder: './src/db/migrations' });
  console.log('Migrations applied successfully.');

  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
