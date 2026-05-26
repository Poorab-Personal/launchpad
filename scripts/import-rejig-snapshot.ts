/**
 * Import a Rejig accounts snapshot into customer_usage_signals.
 *
 * Thin CLI wrapper over `src/lib/integrations/rejig/import.ts` — the same
 * function is invoked by the Sunday 05:00 UTC cron at `/api/cron/import-rejig`.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/import-rejig-snapshot.ts [--apply] [--limit N]
 *
 * Default is dry-run. Pass `--apply` to write.
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { importRejigSnapshot } from '../src/lib/integrations/rejig/import';

function parseArgs(argv: string[]): { apply: boolean; limit: number | null } {
  let apply = false;
  let limit: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') apply = true;
    else if (arg === '--limit') {
      const next = argv[i + 1];
      if (next && /^\d+$/.test(next)) {
        limit = Number(next);
        i++;
      }
    } else if (arg.startsWith('--limit=')) {
      const v = arg.split('=')[1];
      if (/^\d+$/.test(v)) limit = Number(v);
    }
  }
  return { apply, limit };
}

async function main() {
  const { apply, limit } = parseArgs(process.argv.slice(2));
  const summary = await importRejigSnapshot({ apply, limit, log: (m) => console.log(m) });
  console.log('');
  console.log(`[summary] ${summary.mode.toUpperCase()} complete in ${summary.durationMs}ms.`);
  console.log(JSON.stringify(summary, null, 2));
  if (!apply) console.log('\nDRY-RUN — pass --apply to commit.');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
