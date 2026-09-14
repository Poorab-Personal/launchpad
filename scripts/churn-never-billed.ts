/**
 * Churn the five Keyes/IPRE agents who completed signup and got credentials
 * but never got past the onboarding call — no-show (or rescheduled and never
 * rebooked), so posting was stopped in their Rejig accounts. Decided
 * 2026-09-14.
 *
 *   npx tsx scripts/churn-never-billed.ts            # dry run
 *   npx tsx scripts/churn-never-billed.ts --confirm  # apply
 *
 * What it does per customer:
 *   1. applyStateTransition → 'Churned'. One helper writes LP's
 *      onboarding_state, appends the customer_state_transitions audit row,
 *      AND pushes the HubSpot ticket to the Churned stage. Both sides are
 *      required: the HS webhook deliberately ignores LP's own INTEGRATION
 *      writes (loop prevention), so an API stage-move alone would never
 *      mirror back into LP.
 *   2. HubSpot meeting outcome → NO_SHOW, for the meetings still sitting at
 *      SCHEDULED months after the fact. Krista's is already RESCHEDULED and
 *      is left alone — that's the accurate record for her.
 *   3. LP `calls` row → 'No Show' (or 'Rescheduled' for Krista). Written with
 *      a direct UPDATE rather than updateCall(): updateCall fires Auto 8 on
 *      Completed, and we must never take that path for a churn.
 *   4. Detaches the saved Stripe payment method. None of these five ever had
 *      a subscription (asserted below), so there is nothing to cancel — but
 *      each has a card set as the customer default. If anyone later moves the
 *      ticket to Active, the sub-creation trigger would charge that card. The
 *      Stripe Customer object itself is kept for history.
 *   5. Writes a `Churned` LP event carrying the reason.
 *
 * subscription_status is deliberately left NULL. These five never subscribed,
 * so 'Cancelled' would invent five phantom cancellations in revenue reporting
 * and pull them into the BI cron's scope (it requires onboarding_state AND
 * subscription_status both non-null).
 *
 * NOT churned: George Wlodarczyk. His HubSpot meeting was rescheduled in
 * place to 2026-09-15 and is still live — LP's call_date (2026-07-27) is just
 * stale, because an in-place reschedule never updates it.
 *
 * Preconditions are asserted per row and a failure skips that row: name must
 * match the id, state must still be 'Onboarding Scheduled', and Stripe must
 * report zero subscriptions. Targeting is by customer id because there are
 * TWO Mary Sibiski records — the 2026-05-01 one is already Churned and must
 * not be touched.
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

type Target = {
  customerId: string;
  name: string;
  callId: string;
  meetingId: string;
  /** Leave the HS meeting outcome alone when it already reads accurately. */
  meetingOutcome: 'NO_SHOW' | null;
  callStatus: 'No Show' | 'Rescheduled';
  reason: string;
};

const TARGETS: Target[] = [
  {
    customerId: '88cebf87-b9dc-4540-8d51-34a7dbfc86f0',
    name: 'Mimi Vail',
    callId: 'f771f728-33d1-4b77-9fc9-fa2875530da6',
    meetingId: '375120205519',
    meetingOutcome: 'NO_SHOW',
    callStatus: 'No Show',
    reason: 'No-show on 2026-06-17 onboarding call; never rebooked. Posting stopped in Rejig.',
  },
  {
    customerId: '2448a8ad-50ec-4e4b-87ae-3984a41294fc',
    name: 'Mary Sibiski',
    callId: 'b7cea993-230d-4f33-8d3f-e15aa2b97403',
    meetingId: '377109311178',
    meetingOutcome: 'NO_SHOW',
    callStatus: 'No Show',
    reason: 'No-show on 2026-06-30 onboarding call; never rebooked. Posting stopped in Rejig.',
  },
  {
    customerId: 'edde0a9b-5841-4c78-a942-0cf2ee90d9d5',
    name: 'Krista Singleton',
    callId: '0342d6b3-89d0-4826-90ba-777fc4b4c165',
    meetingId: '380288323299',
    meetingOutcome: null,                       // already RESCHEDULED in HS
    callStatus: 'Rescheduled',
    reason: 'Rescheduled off the 2026-07-08 onboarding call and never rebooked. Posting stopped in Rejig.',
  },
  {
    customerId: 'dc7d0cd1-43a0-4c10-96db-3e096d03284e',
    name: 'Matt Yorgey',
    callId: 'c3e59780-3813-4d36-8418-47d21edcd1de',
    meetingId: '387415504631',
    meetingOutcome: 'NO_SHOW',
    callStatus: 'No Show',
    reason: 'No-show on 2026-08-04 onboarding call; never rebooked. Posting stopped in Rejig.',
  },
  {
    customerId: '336b971a-cecd-493b-8ad8-663221d0164b',
    name: 'Adele Leonardo',
    callId: '68f353d5-4f9b-4c3c-b8fa-1170fcd45fb1',
    meetingId: '388430059199',
    meetingOutcome: 'NO_SHOW',
    callStatus: 'No Show',
    reason: 'No-show on 2026-08-08 onboarding call; never rebooked. Posting stopped in Rejig.',
  },
];

async function main() {
  const confirm = process.argv.includes('--confirm');
  const { db } = await import('../src/db');
  const { sql, eq } = await import('drizzle-orm');
  const schema = await import('../src/db/schema');
  const { applyStateTransition } = await import('../src/lib/db');
  const Stripe = (await import('stripe')).default;
  const { Client } = await import('@hubspot/api-client');

  const stripe = new Stripe(process.env.STRIPE_LIVE_SECRET_KEY ?? process.env.STRIPE_SECRET_KEY!);
  const hs = new Client({ accessToken: process.env.HUBSPOT_STATIC_TOKEN! });

  console.log(confirm ? 'APPLYING churn\n' : 'DRY RUN — pass --confirm to apply\n');

  for (const t of TARGETS) {
    const rows = await db.execute(sql`
      SELECT name, onboarding_state, stripe_customer_id, subscription_status
      FROM customers WHERE id = ${t.customerId}::uuid
    `);
    const c = (rows.rows as Array<Record<string, string | null>>)[0];

    // ── Preconditions ────────────────────────────────────────────────────
    if (!c) { console.log(`✗ ${t.name}: customer ${t.customerId} not found`); continue; }
    if (c.name !== t.name) {
      console.log(`✗ ${t.name}: id maps to "${c.name}" — refusing (wrong record?)`);
      continue;
    }
    if (c.onboarding_state !== 'Onboarding Scheduled') {
      console.log(`· ${t.name}: state is already "${c.onboarding_state}" — skipping`);
      continue;
    }
    const subs = c.stripe_customer_id
      ? await stripe.subscriptions.list({ customer: c.stripe_customer_id, status: 'all', limit: 5 })
      : { data: [] as Array<{ id: string; status: string }> };
    if (subs.data.length > 0) {
      console.log(
        `✗ ${t.name}: REFUSING — has ${subs.data.length} Stripe subscription(s) `
        + `(${subs.data.map((s) => `${s.id} ${s.status}`).join(', ')}). `
        + `A real subscriber needs a cancellation decision, not this script.`,
      );
      continue;
    }

    if (!confirm) {
      const pms = c.stripe_customer_id
        ? await stripe.paymentMethods.list({ customer: c.stripe_customer_id, limit: 5 })
        : { data: [] };
      console.log(`· ${t.name}: would churn`);
      console.log(`    LP state       Onboarding Scheduled → Churned (+ transition row, changeSource=lp_admin)`);
      console.log(`    HS ticket      → Churned stage`);
      console.log(`    HS meeting     ${t.meetingId} outcome → ${t.meetingOutcome ?? '(left as-is)'}`);
      console.log(`    LP call row    → ${t.callStatus}`);
      console.log(`    Stripe         detach ${pms.data.length} card(s): ${pms.data.map((p) => p.id).join(', ') || 'none'}`);
      console.log(`    sub_status     stays ${c.subscription_status ?? 'NULL'}`);
      continue;
    }

    // ── 1. LP state + audit row + HS ticket stage push ──────────────────
    const res = await applyStateTransition({
      customerId: t.customerId,
      toState: 'Churned',
      attentionReason: null,
      changeSource: 'lp_admin',
      sourceDetail: 'manual:onboarding-no-show-never-rebooked',
      expectedFromState: 'Onboarding Scheduled',
      pushToHubSpot: true,
      payload: { reason: t.reason, decidedOn: '2026-09-14', neverBilled: true },
    });
    if (!res.applied) {
      console.log(`✗ ${t.name}: state transition not applied (${res.reason}) — skipping the rest`);
      continue;
    }
    console.log(`✓ ${t.name}: LP → Churned + HS ticket pushed`);

    // ── 2. HS meeting outcome ───────────────────────────────────────────
    if (t.meetingOutcome) {
      try {
        await hs.crm.objects.basicApi.update('meetings', t.meetingId, {
          properties: { hs_meeting_outcome: t.meetingOutcome },
        });
        console.log(`    meeting ${t.meetingId} → ${t.meetingOutcome}`);
      } catch (err) {
        console.warn(`    ! meeting outcome failed: ${err instanceof Error ? err.message.slice(0, 90) : err}`);
      }
    }

    // ── 3. LP call row (direct UPDATE — never via updateCall) ───────────
    try {
      await db.update(schema.calls)
        .set({ status: t.callStatus })
        .where(eq(schema.calls.id, t.callId));
      console.log(`    call row → ${t.callStatus}`);
    } catch (err) {
      console.warn(`    ! call update failed: ${err instanceof Error ? err.message.slice(0, 90) : err}`);
    }

    // ── 4. Detach saved cards ───────────────────────────────────────────
    if (c.stripe_customer_id) {
      const pms = await stripe.paymentMethods.list({ customer: c.stripe_customer_id, limit: 5 });
      for (const pm of pms.data) {
        try {
          await stripe.paymentMethods.detach(pm.id);
          console.log(`    detached ${pm.id} (${pm.card?.brand} ${pm.card?.last4})`);
        } catch (err) {
          console.warn(`    ! detach ${pm.id} failed: ${err instanceof Error ? err.message.slice(0, 90) : err}`);
        }
      }
    }

    // ── 5. Audit event ──────────────────────────────────────────────────
    await db.insert(schema.events).values({
      customerId: t.customerId,
      eventType: 'Churned',
      actorType: 'Team Member',
      details: `${t.reason} Never billed — no Stripe subscription ever existed; saved card detached.`,
    });
  }

  console.log('\nGeorge Wlodarczyk deliberately NOT churned — live HS meeting 2026-09-15.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
