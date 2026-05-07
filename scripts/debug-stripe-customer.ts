/**
 * Debug script: list everything Stripe has for a customer.
 *
 * Usage: npx tsx scripts/debug-stripe-customer.ts cus_UTSyil9iycoCeE
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import Stripe from 'stripe';

const customerId = process.argv[2];
if (!customerId) {
  console.error('Usage: npx tsx scripts/debug-stripe-customer.ts cus_xxxxx');
  process.exit(1);
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

async function main() {
  console.log(`\n=== Customer ${customerId} ===\n`);

  const customer = await stripe.customers.retrieve(customerId);
  if (customer.deleted) {
    console.log('(deleted)');
    return;
  }
  console.log(`Name:        ${customer.name}`);
  console.log(`Email:       ${customer.email}`);
  console.log(`Created:     ${new Date(customer.created * 1000).toISOString()}`);
  console.log(`Default PM:  ${customer.invoice_settings?.default_payment_method ?? '(none)'}`);

  console.log('\n=== SetupIntents ===');
  const sis = await stripe.setupIntents.list({ customer: customerId, limit: 20 });
  for (const si of sis.data) {
    console.log(`${si.id} | status=${si.status} | usage=${si.usage} | pm=${si.payment_method ?? '-'} | created=${new Date(si.created * 1000).toISOString()}`);
  }

  console.log('\n=== PaymentIntents ===');
  const pis = await stripe.paymentIntents.list({ customer: customerId, limit: 20 });
  if (pis.data.length === 0) console.log('(none)');
  for (const pi of pis.data) {
    console.log(`${pi.id} | status=${pi.status} | amount=${pi.amount} ${pi.currency} | created=${new Date(pi.created * 1000).toISOString()}`);
  }

  console.log('\n=== Charges ===');
  const charges = await stripe.charges.list({ customer: customerId, limit: 20 });
  if (charges.data.length === 0) console.log('(none)');
  for (const c of charges.data) {
    console.log(`${c.id} | status=${c.status} | amount=${c.amount} ${c.currency} | paid=${c.paid} | created=${new Date(c.created * 1000).toISOString()}`);
  }

  console.log('\n=== Subscriptions ===');
  const subs = await stripe.subscriptions.list({ customer: customerId, limit: 20 });
  if (subs.data.length === 0) console.log('(none)');
  for (const s of subs.data) {
    console.log(`${s.id} | status=${s.status} | trial_end=${s.trial_end ? new Date(s.trial_end * 1000).toISOString() : '-'} | created=${new Date(s.created * 1000).toISOString()}`);
  }

  console.log('\n=== Invoices ===');
  const invs = await stripe.invoices.list({ customer: customerId, limit: 20 });
  if (invs.data.length === 0) console.log('(none)');
  for (const inv of invs.data) {
    console.log(`${inv.id} | status=${inv.status} | amount_due=${inv.amount_due} ${inv.currency} | amount_paid=${inv.amount_paid} | created=${new Date(inv.created * 1000).toISOString()}`);
  }

  console.log('\n=== Payment Methods ===');
  const pms = await stripe.paymentMethods.list({ customer: customerId, type: 'card' });
  if (pms.data.length === 0) console.log('(none)');
  for (const pm of pms.data) {
    console.log(`${pm.id} | card=${pm.card?.brand} ****${pm.card?.last4} exp ${pm.card?.exp_month}/${pm.card?.exp_year}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
