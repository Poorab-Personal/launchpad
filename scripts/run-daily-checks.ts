/**
 * Run the daily B2B-onboarding gap checks against live data. Default
 * mode is preview (print summary + flagged rows, NO email). Pass
 * --send to actually email the digest. Pass --to to override recipients
 * (useful for self-test).
 *
 * Run:
 *   tsx --env-file=.env.local scripts/run-daily-checks.ts
 *   tsx --env-file=.env.local scripts/run-daily-checks.ts --send
 *   tsx --env-file=.env.local scripts/run-daily-checks.ts --send --to poorab@rejig.ai
 *   tsx --env-file=.env.local scripts/run-daily-checks.ts --send --to poorab@rejig.ai,matt@rejig.ai
 *
 * Hits production Neon (POSTGRES_URL), Rejig API (REJIG_API_KEY), and
 * Resend (RESEND_API_KEY) — all read from .env.local. No DB writes
 * anywhere in this path.
 */
import { runDailyChecks } from '../src/lib/automations/daily-checks';
import { sendDailyDigestEmail } from '../src/lib/email/send';

const DEFAULT_RECIPIENTS = [
  'success@rejig.ai',
  'poorab@rejig.ai',
  'matt@rejig.ai',
];

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  let send = false;
  let to: string[] | null = null;
  let cc: string[] | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--send') send = true;
    else if (a === '--to') {
      const v = args[++i];
      if (!v) throw new Error('--to requires an email or comma-separated list');
      to = v.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--cc') {
      const v = args[++i];
      if (!v) throw new Error('--cc requires an email or comma-separated list');
      cc = v.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--help' || a === '-h') {
      console.log('Usage: tsx --env-file=.env.local scripts/run-daily-checks.ts [--send] [--to addr,addr] [--cc addr,addr]');
      process.exit(0);
    } else {
      throw new Error(`Unknown arg: ${a}`);
    }
  }
  return { send, to, cc };
}

async function main() {
  const { send, to, cc } = parseArgs(process.argv);

  console.log(`Mode: ${send ? 'SEND' : 'PREVIEW (no email)'}`);
  console.log('Hitting Neon + Rejig API…\n');

  const result = await runDailyChecks();

  console.log(`Duration            : ${result.durationMs}ms`);
  console.log(`Rejig accounts read : ${result.rejigAccountsFetched}`);
  console.log(`Section 1 rows      : ${result.section1.length}`);
  console.log(`Section 2 rows      : ${result.section2.length}`);
  console.log(`Section 3 rows      : ${result.section3.length}`);
  console.log('');

  if (result.section1.length > 0) {
    console.log('── Section 1 — Stripe sub needs linking in Rejig ──');
    for (const r of result.section1) {
      console.log(
        `  ${r.customerName.padEnd(30)} ${r.workflowKey.padEnd(10)} ${r.reason.padEnd(24)} ${r.contactEmail}`,
      );
      console.log(`    LP sub : ${r.lpStripeSubId}`);
      if (r.rejigStripeSubId) console.log(`    Rejig  : ${r.rejigStripeSubId}`);
    }
    console.log('');
  }

  if (result.section2.length > 0) {
    console.log('── Section 2 — Onboarding meeting unmarked ──');
    for (const r of result.section2) {
      const hrs = Math.floor((Date.now() - r.callDate.getTime()) / (60 * 60 * 1000));
      console.log(
        `  ${r.customerName.padEnd(30)} ${(r.brokerageName ?? r.workflowKey).padEnd(12)} ${String(hrs).padStart(3)}h ago  ${r.contactEmail}`,
      );
    }
    console.log('');
  }

  if (result.section3.length > 0) {
    console.log('── Section 3 — Brokerage roster is stale ──');
    for (const r of result.section3) {
      const age =
        r.daysStale === null ? 'NEVER SYNCED' : `${r.daysStale}d stale`;
      console.log(
        `  ${r.brokerageName.padEnd(30)} /${r.landingPageSlug.padEnd(10)} ${age.padStart(14)}  last: ${
          r.lastRosterSync?.toISOString().slice(0, 10) ?? '—'
        }`,
      );
    }
    console.log('');
  }

  const total =
    result.section1.length + result.section2.length + result.section3.length;
  if (total === 0) {
    console.log('All clear — nothing to surface.');
    process.exit(0);
  }

  if (!send) {
    console.log(`Preview only — pass --send to email the digest.`);
    process.exit(0);
  }

  const recipients = to ?? DEFAULT_RECIPIENTS;
  console.log(`Sending digest to: ${recipients.join(', ')}`);
  if (cc && cc.length > 0) console.log(`              cc: ${cc.join(', ')}`);

  const digestDate = new Date().toISOString().slice(0, 10);
  await sendDailyDigestEmail({
    to: recipients,
    cc: cc ?? undefined,
    digestDate,
    section1: result.section1,
    section2: result.section2,
    section3: result.section3,
  });

  console.log('Sent.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
