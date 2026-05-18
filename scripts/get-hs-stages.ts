import * as dotenv from 'dotenv';
import { Client } from '@hubspot/api-client';
dotenv.config({ path: '.env.local' });
async function main() {
  const hs = new Client({ accessToken: process.env.HUBSPOT_STATIC_TOKEN });
  const p = await hs.crm.pipelines.pipelinesApi.getById('tickets', '0');
  console.log(JSON.stringify(p.stages.map((s: any) => ({ id: s.id, label: s.label, order: s.displayOrder })), null, 2));
}
main();
