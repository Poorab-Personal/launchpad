/**
 * One-shot patch: extend the existing HS Ticket property
 * `rejig_attention_reason` with the full enum from
 * setup-hubspot-properties.enums.ts.
 *
 * Background: the property was created with only 6 of the 10 enum values
 * (the 4 added later — stuck_in_onboarding, engagement_drop_30d,
 * renewal_approaching_6w, renewal_approaching_2w — never made it into HS,
 * causing silent ticket-property push failures when state-mapper emitted
 * the missing values. Observed 2026-05-18.
 *
 * Idempotent: HS PATCH replaces the full options array; we send the full
 * spec each time so re-running is a no-op once aligned.
 *
 *   npx tsx scripts/patch-hs-attention-reason-options.ts          # dry-run
 *   npx tsx scripts/patch-hs-attention-reason-options.ts --apply  # apply
 */
import * as dotenv from 'dotenv';
import { Client } from '@hubspot/api-client';
dotenv.config({ path: '.env.local' });

import { ATTENTION_REASON_VALUES } from './setup-hubspot-properties.enums';

const APPLY = process.argv.includes('--apply');

async function main() {
  const token = process.env.HUBSPOT_STATIC_TOKEN;
  if (!token) {
    console.error('✗ HUBSPOT_STATIC_TOKEN not set');
    process.exit(1);
  }
  const hs = new Client({ accessToken: token });

  const existing = await hs.crm.properties.coreApi.getByName(
    'tickets',
    'rejig_attention_reason',
  );
  const existingValues = new Set((existing.options ?? []).map((o) => o.value));
  const desired = ATTENTION_REASON_VALUES;
  const missing = desired.filter((v) => !existingValues.has(v));
  const extra = [...existingValues].filter((v) => !desired.includes(v as never));

  console.log(`Existing options (${existingValues.size}): ${[...existingValues].join(', ')}`);
  console.log(`Desired options (${desired.length}):  ${desired.join(', ')}`);
  console.log(`Missing (to add):  ${missing.length ? missing.join(', ') : '(none)'}`);
  console.log(`Extra (will keep): ${extra.length ? extra.join(', ') : '(none)'}`);

  if (missing.length === 0) {
    console.log('✓ Property already has all desired options. No-op.');
    return;
  }

  if (!APPLY) {
    console.log('\nDry-run. Re-run with --apply to PATCH the property.');
    return;
  }

  // Build the full union: existing + missing. Preserve existing displayOrder
  // / hidden state where possible.
  const existingByValue = new Map((existing.options ?? []).map((o) => [o.value, o]));
  const fullOptions = desired.map((v, i) => {
    const e = existingByValue.get(v);
    return e
      ? {
          label: e.label,
          value: e.value,
          description: e.description ?? '',
          displayOrder: i,
          hidden: e.hidden ?? false,
        }
      : {
          label: v,
          value: v,
          description: '',
          displayOrder: i,
          hidden: false,
        };
  });

  await hs.crm.properties.coreApi.update('tickets', 'rejig_attention_reason', {
    options: fullOptions,
  } as never);
  console.log(`✓ Patched rejig_attention_reason with ${fullOptions.length} options.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
