import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

async function main() {
  const customerId = process.argv[2];
  if (!customerId) throw new Error('Usage: tsx scripts/debug-b2b-push.ts <customer-uuid>');

  const { pushCustomerIntakeToHubSpot } = await import('../src/lib/integrations/hubspot/intake-handler');

  console.log(`Re-firing HS intake push for ${customerId}...`);
  try {
    const result = await pushCustomerIntakeToHubSpot(customerId);
    console.log('Result:', JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Threw:', err);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
