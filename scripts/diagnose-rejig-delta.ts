import { db } from '@/db';
import { customers } from '@/db/schema/customers';
import { fetchAccountsSnapshot } from '@/lib/integrations/rejig/client';

async function main() {
  const accounts = await fetchAccountsSnapshot();
  console.log('Rejig API returned:', accounts.length, 'accounts');

  const lp = await db.query.customers.findMany();
  const lpEmails = new Set<string>();
  const lpById = new Map<string, typeof lp[0]>();
  for (const c of lp) {
    if (c.contactEmail) lpEmails.add(c.contactEmail.toLowerCase());
    if (c.platformEmail) lpEmails.add(c.platformEmail.toLowerCase());
    if (c.rejigUserId) lpById.set(c.rejigUserId, c);
  }
  console.log('LP customers:', lp.length, '(distinct emails:', lpEmails.size, ')');

  const trulyMissing = accounts.filter((a) => !lpById.has(a._id));
  console.log('\n=== Truly missing from LP (by rejig_user_id):', trulyMissing.length, '===');
  for (const a of trulyMissing) {
    const e = (a.email || '').toLowerCase();
    const inLpByEmail = e && lpEmails.has(e);
    console.log(`  ${a._id} | ${(a.email || '(no email)').padEnd(38)} | ${(a.subscription_status || '').padEnd(10)} | ${(a.business_name || a.account_name || '').slice(0, 40)}${inLpByEmail ? '  [LP HAS this email under different rejig_user_id]' : ''}`);
  }

  const tf = accounts.find((a) => (a.email || '').includes('teamforss') || /team\s*forss/i.test(a.business_name || a.account_name || ''));
  console.log('\n=== Team Forss in Rejig today: ===');
  if (tf) {
    console.log(`  _id=${tf._id} | email=${tf.email} | status=${tf.subscription_status} | business=${tf.business_name}`);
    console.log(`  In LP by rejig_user_id? ${lpById.has(tf._id) ? 'YES' : 'NO'}`);
    console.log(`  In LP by email? ${tf.email && lpEmails.has(tf.email.toLowerCase()) ? 'YES' : 'NO'}`);
  } else {
    console.log('  Not in Rejig API response.');
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
