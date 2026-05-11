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
      // tests must never touch real Airtable / live Stripe / live Resend.
      STRIPE_WEBHOOK_SECRET: 'whsec_test_secret_phase15_vitest',
      STRIPE_SECRET_KEY: 'sk_test_dummy_phase15_vitest',
      AIRTABLE_PAT: 'pat_test_dummy',
      AIRTABLE_BASE_ID: 'app_test_dummy',
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'src'),
    },
  },
});
