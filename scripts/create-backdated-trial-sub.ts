/**
 * Start the subscription of an agent who has been using Rejig for free.
 *
 * The case this exists for: a Keyes/IPRE agent captured a card at intake
 * (`payment_mode = 'setup-intent-at-intake'`), got credentials, and started
 * posting — but their HubSpot ticket never reached `Active`, so LP's
 * sub-creation trigger never fired. They have had the product free ever since.
 * See `docs/integrations/hs-workflow-active-nonenrollment.md` for why the
 * ticket stalls; this script only fixes the billing side.
 *
 * Stripe cannot backdate a subscription's creation, and backdating the billing
 * anchor raises an immediate proration invoice. So instead of pretending the
 * sub started on the day they began posting, we create it today with an
 * explicit `trial_end` set to the day their trial *would* have ended. The
 * economics are identical — free until that date, first charge on it — and
 * the anchor lands there, so every later renewal falls on the right day.
 *
 * TRIAL END. The default is the same day of the following month ("a 30-day
 * trial" as we quote it: Sep 24 → Oct 24, Oct 2 → Nov 2). That is what the
 * three October 2026 runs did. Pass `--trial-end` to set the date outright, or
 * `--trial-days N` for literal day arithmetic. Time-of-day is inherited from
 * `stage_entered_at` so the anchor isn't midnight UTC; it only ever adds a few
 * free hours.
 *
 * The start date is an input, not something LP knows — LP has no "first post"
 * date. Take it from the agent's Rejig activity (first published post) or from
 * whatever the brokerage reports, and pass it in.
 *
 * Preconditions, each of which aborts: no existing `stripe_subscription_id`
 * (never create a second sub), a `selected_stripe_price_id` on the row, a
 * default payment method on the Stripe Customer, and a `trial_end` more than
 * 48h out (Stripe's floor). Idempotency-keyed on (customer, trial_end), so a
 * re-run of the same command cannot double-create.
 *
 * Writes on success: the Stripe sub, plus both LP mirrors
 * (`customers.stripe_subscription_id` / `subscription_status` and the
 * `customer_subscriptions` Core row). It does NOT touch `onboarding_state` or
 * the HubSpot ticket — move the ticket separately if it is still stalled.
 *
 * Dry run by default; `--confirm` applies.
 *
 *   npx tsx scripts/create-backdated-trial-sub.ts lisameyers@keyes.com --started 2026-09-24
 *   npx tsx scripts/create-backdated-trial-sub.ts lisameyers@keyes.com --started 2026-09-24 --confirm
 *   npx tsx scripts/create-backdated-trial-sub.ts ttecson@ipre.com --trial-end 2026-11-02 --confirm
 *
 * Run once per agent and read the dry run before confirming — the first charge
 * is real money on a real card.
 */
import dotenv from 'dotenv';
import Stripe from 'stripe';

dotenv.config({ path: '.env.local' });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

function mapStatus(s: string): 'Active' | 'Trial' | 'Past Due' | 'Cancelled' {
  if (s === 'trialing') return 'Trial';
  if (s === 'past_due') return 'Past Due';
  if (s === 'canceled' || s === 'incomplete_expired') return 'Cancelled';
  return 'Active';
}

/** Same day of the following month, clamped (Jan 31 → Feb 28). */
function plusOneMonth(d: Date): Date {
  const out = new Date(d);
  const day = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, lastDay));
  return out;
}

async function main() {
  const who = process.argv[2];
  const started = arg('--started');
  const trialEndArg = arg('--trial-end');
  const trialDaysArg = arg('--trial-days');
  const confirm = process.argv.includes('--confirm');

  if (!who || who.startsWith('--') || (!started && !trialEndArg)) {
    console.error('usage: create-backdated-trial-sub.ts <email|lp-id> (--started YYYY-MM-DD | --trial-end YYYY-MM-DD) [--trial-days N] [--confirm]');
    process.exit(1);
  }

  const { db } = await import('../src/db');
  const { sql } = await import('drizzle-orm');
  const stripe = new Stripe((process.env.STRIPE_LIVE_SECRET_KEY ?? process.env.STRIPE_SECRET_KEY)!);

  const match = UUID_RE.test(who)
    ? sql`id = ${who}`
    : sql`contact_email ilike ${who} or other_emails ilike ${`%${who}%`} or name ilike ${`%${who}%`}`;

  const rows = (await db.execute(sql`
    select id, name, contact_email, workflow_key, current_stage, stage_entered_at, onboarding_state,
           selected_plan_name, selected_stripe_price_id, stripe_customer_id, stripe_subscription_id
      from customers where ${match}`) as any).rows as any[];

  if (rows.length === 0) throw new Error(`No customer matched "${who}"`);
  if (rows.length > 1) {
    console.error(`"${who}" matched ${rows.length} customers — re-run with the LP id:`);
    for (const r of rows) console.error(`  ${r.id}  ${r.name} <${r.contact_email}>  ${r.workflow_key}`);
    process.exit(1);
  }

  const c = rows[0];
  if (c.stripe_subscription_id) throw new Error(`${c.name} already has sub ${c.stripe_subscription_id} — aborting`);
  if (!c.selected_stripe_price_id) throw new Error(`${c.name} has no selected_stripe_price_id — they never picked a plan`);
  if (!c.stripe_customer_id) throw new Error(`${c.name} has no stripe_customer_id — no card was ever captured`);

  // Template trial length, for display + --trial-days default. Header-level,
  // so any row for the workflow carries it.
  const tmpl = (await db.execute(sql`
    select trial_days, payment_mode from workflow_templates
     where workflow_key = ${c.workflow_key} and trial_days is not null limit 1`) as any).rows[0];

  // Time-of-day carrier: keeps the anchor off midnight UTC.
  const timeOf = c.stage_entered_at ? new Date(c.stage_entered_at) : null;
  const withTime = (ymd: string) => {
    const d = new Date(`${ymd}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) throw new Error(`Bad date "${ymd}" — expected YYYY-MM-DD`);
    if (timeOf) {
      d.setUTCHours(timeOf.getUTCHours(), timeOf.getUTCMinutes(), timeOf.getUTCSeconds(), 0);
    } else {
      d.setUTCHours(12, 0, 0, 0);
    }
    return d;
  };

  let trialEnd: Date;
  let rule: string;
  if (trialEndArg) {
    trialEnd = withTime(trialEndArg);
    rule = 'explicit --trial-end';
  } else {
    const start = withTime(started!);
    if (trialDaysArg) {
      const n = Number(trialDaysArg);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`Bad --trial-days "${trialDaysArg}"`);
      trialEnd = new Date(start.getTime() + n * 86_400_000);
      rule = `${started} + ${n}d`;
    } else {
      trialEnd = plusOneMonth(start);
      rule = `${started} + 1 month (template trial_days=${tmpl?.trial_days ?? '—'})`;
    }
  }

  const trialEndSec = Math.floor(trialEnd.getTime() / 1000);
  if (trialEndSec < Date.now() / 1000 + 48 * 3600) {
    throw new Error(`trial_end ${trialEnd.toISOString()} must be >48h out — Stripe rejects anything sooner. Their free run is already over; bill them from a near-future date instead.`);
  }

  const cust: any = await stripe.customers.retrieve(c.stripe_customer_id);
  const defaultPm = cust.invoice_settings?.default_payment_method;
  if (!defaultPm) throw new Error(`${c.name} has no default payment method on ${c.stripe_customer_id} — see scripts/audit-default-pm.ts`);
  const price = await stripe.prices.retrieve(c.selected_stripe_price_id, { expand: ['product'] });

  console.log(`customer    ${c.name} <${c.contact_email}>  ${c.workflow_key}`);
  console.log(`LP state    ${c.current_stage} / ${c.onboarding_state}`);
  console.log(`plan        ${c.selected_plan_name}`);
  console.log(`price       ${price.id}  $${price.unit_amount! / 100} / ${price.recurring?.interval_count ?? 1}${price.recurring?.interval}`);
  console.log(`product     ${(price.product as any).name}`);
  console.log(`trial_end   ${trialEnd.toISOString()}   (${rule}) → first charge that day`);
  console.log(`default pm  ${defaultPm}`);

  if (!confirm) {
    console.log('\nDRY RUN — nothing created. Re-run with --confirm to charge from the date above.');
    return;
  }

  const sub = await stripe.subscriptions.create(
    {
      customer: c.stripe_customer_id,
      items: [{ price: c.selected_stripe_price_id }],
      trial_end: trialEndSec,
      default_payment_method: defaultPm,
      metadata: { launchpad_customer_id: c.id },
    },
    { idempotencyKey: `backdated_trial_${c.id}_${trialEndSec}` },
  );

  const item: any = sub.items.data[0];
  const mapped = mapStatus(sub.status);
  const cpsSec = item.current_period_start ?? sub.start_date;
  const cpeSec = sub.trial_end ?? item.current_period_end;

  await db.execute(sql`
    update customers set stripe_subscription_id = ${sub.id}, subscription_status = ${mapped},
           last_modified = now() where id = ${c.id}`);
  await db.execute(sql`
    insert into customer_subscriptions (customer_id, product, stripe_subscription_id, status, started_at,
      current_period_start, current_period_end, current_period_start_source, payment_source)
    values (${c.id}, 'Core', ${sub.id}, ${mapped}, ${new Date(sub.start_date * 1000).toISOString()},
      ${new Date(cpsSec * 1000).toISOString()}, ${new Date(cpeSec * 1000).toISOString()}, 'stripe', 'stripe')
    on conflict (customer_id, product) do update set
      stripe_subscription_id = excluded.stripe_subscription_id, status = excluded.status,
      current_period_start = excluded.current_period_start, current_period_end = excluded.current_period_end,
      current_period_start_source = 'stripe', payment_source = 'stripe', updated_at = now()`);

  console.log(`\nCREATED ${sub.id}  status=${sub.status}`);
  console.log(`  trial  → ${new Date(sub.trial_end! * 1000).toISOString()}`);
  console.log(`  anchor   ${new Date((sub as any).billing_cycle_anchor * 1000).toISOString()}`);
  const up: any = await (stripe.invoices as any).createPreview({ subscription: sub.id });
  for (const l of up.lines.data) {
    console.log(`  next inv $${l.amount / 100}  ${new Date(l.period.start * 1000).toISOString().slice(0, 10)} → ${new Date(l.period.end * 1000).toISOString().slice(0, 10)}  ${l.description}`);
  }
  const ch = await stripe.charges.list({ customer: c.stripe_customer_id, limit: 3 });
  console.log(`  charges so far: ${ch.data.length}`);
  console.log('\nLP mirrors written. onboarding_state and the HubSpot ticket are untouched.');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('ERROR:', e?.message ?? e);
    process.exit(1);
  });
