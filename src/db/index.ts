import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from 'ws';

if (!process.env.POSTGRES_URL) {
  throw new Error('POSTGRES_URL is required');
}

neonConfig.webSocketConstructor = ws;

const pool = new Pool({ connectionString: process.env.POSTGRES_URL });

export const db = drizzle(pool);
export type Db = typeof db;
