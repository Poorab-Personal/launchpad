/**
 * Dry-run smoke for the assignee notification helper.
 *
 * Reads the DB and reports what `notifyTaskAssigned` would do for every
 * currently Active + Team + assigned task. Never sends email; never writes
 * to the DB. Use to verify the skip-logic gauntlet behaves correctly without
 * spamming real team members.
 *
 * Run: tsx --env-file=.env.local scripts/smoke-notify-assignee.ts
 *
 * Optional arg: pass a taskId to focus on a single task.
 *   tsx --env-file=.env.local scripts/smoke-notify-assignee.ts <task-uuid>
 */
import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '@/db';
import * as schema from '@/db/schema';
import { getSetting } from '@/lib/db';

type Decision =
  | { kind: 'would_send'; to: string; subject: string; workspaceUrl: string }
  | { kind: 'skip'; reason: string };

async function decide(taskId: string): Promise<Decision> {
  const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) });
  if (!task) return { kind: 'skip', reason: 'task not found' };
  if (task.status !== 'Active') return { kind: 'skip', reason: `status=${task.status}` };
  if (!task.assignedToTeamMemberId) return { kind: 'skip', reason: 'no assignee' };

  const assignee = await db.query.teamMembers.findFirst({
    where: eq(schema.teamMembers.id, task.assignedToTeamMemberId),
  });
  if (!assignee) return { kind: 'skip', reason: 'assignee row missing' };
  if (!assignee.active) return { kind: 'skip', reason: `assignee ${assignee.email} inactive` };
  if (assignee.roles.length === 1 && assignee.roles[0] === 'CSM') {
    return { kind: 'skip', reason: `assignee ${assignee.email} is CSM-only (HubSpot handles)` };
  }

  const customer = await db.query.customers.findFirst({ where: eq(schema.customers.id, task.customerId) });
  if (!customer) return { kind: 'skip', reason: 'customer row missing' };
  if (customer.createdVia === 'backfill') {
    return { kind: 'skip', reason: `customer ${customer.name} is backfill` };
  }

  if (task.assigneeNotifiedAt !== null) {
    return { kind: 'skip', reason: `already notified at ${task.assigneeNotifiedAt.toISOString()}` };
  }

  const portalBase =
    (await getSetting('portal_base_url'))
    || 'https://launchpad-indol-ten.vercel.app';
  const workspaceUrl = `${portalBase}/workspace/customers/${customer.id}`;

  return {
    kind: 'would_send',
    to: assignee.email,
    subject: `New task in your queue: ${task.taskName} for ${customer.name}`,
    workspaceUrl,
  };
}

async function main() {
  const focusTaskId = process.argv[2];

  if (focusTaskId) {
    console.log(`Focusing on task ${focusTaskId}\n`);
    const decision = await decide(focusTaskId);
    console.log(JSON.stringify(decision, null, 2));
    return;
  }

  console.log('Scanning all Active + Team + assigned tasks...\n');
  const candidates = await db
    .select({
      id: schema.tasks.id,
      taskName: schema.tasks.taskName,
      assigneeNotifiedAt: schema.tasks.assigneeNotifiedAt,
    })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.status, 'Active'),
        eq(schema.tasks.taskType, 'Team'),
        isNotNull(schema.tasks.assignedToTeamMemberId),
      ),
    );

  console.log(`Found ${candidates.length} candidate task(s).\n`);

  let wouldSend = 0;
  let skipped = 0;
  const skipReasons: Record<string, number> = {};

  for (const c of candidates) {
    const d = await decide(c.id);
    if (d.kind === 'would_send') {
      wouldSend++;
      console.log(`WOULD SEND  task=${c.id} → ${d.to}`);
      console.log(`            subject: ${d.subject}`);
      console.log(`            workspace: ${d.workspaceUrl}\n`);
    } else {
      skipped++;
      skipReasons[d.reason] = (skipReasons[d.reason] ?? 0) + 1;
    }
  }

  console.log('─'.repeat(60));
  console.log(`Summary: ${wouldSend} would send, ${skipped} skipped.`);
  if (skipped > 0) {
    console.log('\nSkip reasons:');
    for (const [reason, count] of Object.entries(skipReasons).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${count.toString().padStart(4)}  ${reason}`);
    }
  }

  // CSM-only skip survey: list active team members whose role is exactly ['CSM'].
  // These will always be silenced. Confirm the list is what you expect.
  const allMembers = await db
    .select({
      name: schema.teamMembers.name,
      email: schema.teamMembers.email,
      roles: schema.teamMembers.roles,
      active: schema.teamMembers.active,
    })
    .from(schema.teamMembers);
  const csmOnly = allMembers.filter(
    (m) => m.active && m.roles.length === 1 && m.roles[0] === 'CSM',
  );
  console.log(`\nCSM-only team members (would be silenced): ${csmOnly.length}`);
  for (const m of csmOnly) console.log(`  ${m.email} (${m.name})`);
  const multiRoleCsm = allMembers.filter(
    (m) => m.active && m.roles.includes('CSM') && m.roles.length > 1,
  );
  console.log(`\nMulti-role members including CSM (still notified): ${multiRoleCsm.length}`);
  for (const m of multiRoleCsm) console.log(`  ${m.email} (${m.name}) — roles: ${m.roles.join(', ')}`);

  process.exit(0);
}

main().catch((err) => {
  console.error('Smoke failed:', err);
  process.exit(1);
});
