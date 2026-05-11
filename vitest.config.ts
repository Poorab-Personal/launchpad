import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    env: {
      // Hardcoded deterministic test values. We do NOT load .env.local —
      // tests must never touch real Airtable / live Stripe / live Resend /
      // live Postgres.
      STRIPE_WEBHOOK_SECRET: 'whsec_test_secret_phase15_vitest',
      STRIPE_SECRET_KEY: 'sk_test_dummy_phase15_vitest',
      AIRTABLE_PAT: 'pat_test_dummy',
      AIRTABLE_BASE_ID: 'app_test_dummy',
      // Drizzle setup at src/db throws on missing POSTGRES_URL even when
      // db.ts functions are mocked. A fake URL satisfies the guard; no
      // connections are made because every db.ts function is vi.mock'd.
      POSTGRES_URL: 'postgres://test:test@localhost/test',
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'src'),
    },
  },
});
