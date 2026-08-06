/**
 * Pre-deploy audit: exactly who would receive a drop-off reminder/escalation
 * email, and exactly what the first B2B weekly digest would contain, if the
 * new cron wiring went live right now.
 *
 * Calls the SAME functions the live cron routes call (runDropoffReminders,
 * computeB2BDropoffDigest) with dryRun where applicable — no separate
 * preview logic to drift out of sync with what actually fires.
 *
 * Important: this is a FIRST-RUN preview, not a steady-state one. Tasks
 * that have been sitting Active for weeks/months (pre-dating this feature)
 * will immediately compute as "tier 3 due" and fire their escalation the
 * very first time this runs — there's no gradual day-2/5/8 warmup for
 * backlog. That's flagged explicitly below so it's a decision, not a surprise.
 *
 * Usage: npx tsx --env-file=.env.local scripts/audit-dropoff-reminders.ts
 */
import { runDropoffReminders, type DropoffAction } from '@/lib/automations/dropoff-reminders';
import { computeB2BDropoffDigest } from '@/lib/automations/dropoff-b2b-digest';

function line(char = '─', len = 78) {
  console.log(char.repeat(len));
}

async function main() {
  console.log('DROP-OFF REMINDER CRON — PRE-DEPLOY AUDIT (dry run, no emails sent, no DB writes)\n');

  const { actions, durationMs } = await runDropoffReminders({ dryRun: true });
  const b2bDigest = await computeB2BDropoffDigest();

  const byKind = new Map<DropoffAction['kind'], DropoffAction[]>();
  for (const a of actions) {
    const arr = byKind.get(a.kind) ?? [];
    arr.push(a);
    byKind.set(a.kind, arr);
  }

  // ── Customer reminders ──────────────────────────────────────────────
  const customerReminders = (byKind.get('customer-reminder') ?? []).filter(
    (a): a is Extract<DropoffAction, { kind: 'customer-reminder' }> => a.kind === 'customer-reminder',
  );
  line('=');
  console.log(`CUSTOMER REMINDERS — Track 1 (${customerReminders.length})`);
  line('=');
  for (const a of customerReminders.sort((x, y) => y.daysStalled - x.daysStalled)) {
    console.log(
      `  [tier ${a.tier}/3${a.isFinalReminder ? ' FINAL' : ''}]  ${a.daysStalled}d  ${a.customerName.padEnd(28)} ${a.taskName.padEnd(32)} → ${a.to}`,
    );
  }

  // ── D2C sales-rep escalations ───────────────────────────────────────
  const d2cEscalations = (byKind.get('customer-escalation') ?? []).filter(
    (a): a is Extract<DropoffAction, { kind: 'customer-escalation' }> => a.kind === 'customer-escalation',
  );
  console.log();
  line('=');
  console.log(`D2C SALES-REP ESCALATIONS — Track 2 (${d2cEscalations.length})`);
  line('=');
  if (d2cEscalations.length > 0) {
    console.log('  ⚠ FIRST-RUN NOTE: these fire immediately (no day-2/5/8 warmup) because');
    console.log('    escalatedAt is null for every task today — a customer stuck 50 days');
    console.log('    escalates on the very first run, same as one stuck exactly 8 days.\n');
  }
  for (const a of d2cEscalations.sort((x, y) => y.daysStalled - x.daysStalled)) {
    console.log(
      `  ${a.daysStalled}d  ${a.customerName.padEnd(28)} ${a.taskName.padEnd(32)} → ${a.to}  (cc: ${a.cc.join(', ')})`,
    );
  }

  // ── Team reminders ──────────────────────────────────────────────────
  const teamReminders = (byKind.get('team-reminder') ?? []).filter(
    (a): a is Extract<DropoffAction, { kind: 'team-reminder' }> => a.kind === 'team-reminder',
  );
  console.log();
  line('=');
  console.log(`TEAM REMINDERS — Track 5 (${teamReminders.length})`);
  line('=');
  for (const a of teamReminders.sort((x, y) => y.daysStalled - x.daysStalled)) {
    console.log(
      `  [tier ${a.tier}/3${a.isFinalReminder ? ' FINAL' : ''}]  ${a.daysStalled}d  ${a.customerName.padEnd(28)} ${a.taskName.padEnd(32)} → ${a.to}`,
    );
  }

  // ── Team escalations ────────────────────────────────────────────────
  const teamEscalations = (byKind.get('team-escalation') ?? []).filter(
    (a): a is Extract<DropoffAction, { kind: 'team-escalation' }> => a.kind === 'team-escalation',
  );
  console.log();
  line('=');
  console.log(`TEAM/OPS ESCALATIONS — Track 5 (${teamEscalations.length})`);
  line('=');
  if (teamEscalations.length > 0) {
    console.log('  ⚠ Same first-run note as above — no warmup, fires immediately for old stalls.\n');
  }
  for (const a of teamEscalations.sort((x, y) => y.daysStalled - x.daysStalled)) {
    console.log(
      `  ${a.daysStalled}d  ${a.customerName.padEnd(28)} ${a.taskName.padEnd(32)} assignee=${a.assigneeName.padEnd(20)} → ${a.to} (cc: ${a.cc.join(', ')})`,
    );
  }

  // ── Skipped ──────────────────────────────────────────────────────────
  const skipped = (byKind.get('skipped') ?? []).filter(
    (a): a is Extract<DropoffAction, { kind: 'skipped' }> => a.kind === 'skipped',
  );
  if (skipped.length > 0) {
    console.log();
    line('=');
    console.log(`SKIPPED (${skipped.length})`);
    line('=');
    for (const a of skipped) {
      console.log(`  ${a.customerName.padEnd(28)} ${a.taskName.padEnd(32)} — ${a.reason}`);
    }
  }

  // ── B2B weekly digest preview ───────────────────────────────────────
  console.log();
  line('=');
  console.log(`B2B WEEKLY DIGEST PREVIEW — Tracks 3/4 (${b2bDigest.rows.length} rows, would send Sunday)`);
  line('=');
  const hot = b2bDigest.rows.filter((r) => r.isHotCase);
  if (hot.length > 0) {
    console.log(`  ${hot.length} HOT CASE (card saved, call not booked) — highlighted red in the digest:`);
    for (const r of hot) {
      console.log(`    ${r.daysStalled}d  ${r.customerName.padEnd(28)} ${r.brokerageName.padEnd(16)} ${r.taskName}`);
    }
    console.log();
  }
  const cold = b2bDigest.rows.filter((r) => !r.isHotCase);
  for (const r of cold.sort((a, b) => b.daysStalled - a.daysStalled)) {
    console.log(`    ${r.daysStalled}d  ${r.customerName.padEnd(28)} ${r.brokerageName.padEnd(16)} ${r.taskName}`);
  }

  // ── Totals ───────────────────────────────────────────────────────────
  console.log();
  line();
  console.log(
    `TOTALS: ${customerReminders.length} customer reminders, ${d2cEscalations.length} D2C escalations, ` +
    `${teamReminders.length} team reminders, ${teamEscalations.length} team escalations, ` +
    `${b2bDigest.rows.length} B2B digest rows (${hot.length} hot). Scan took ${durationMs}ms.`,
  );
  line();

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
