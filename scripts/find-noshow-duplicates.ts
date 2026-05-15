import * as dotenv from 'dotenv';
import { Client } from '@hubspot/api-client';
dotenv.config({ path: '.env.local' });

async function main() {
  const hs = new Client({ accessToken: process.env.HUBSPOT_STATIC_TOKEN! });
  const result = await hs.crm.properties.coreApi.getAll('contacts');
  const matches = result.results.filter((p) =>
    p.label.toLowerCase().includes('no-show') ||
    p.label.toLowerCase().includes('no show') ||
    p.name.toLowerCase().includes('no_show') ||
    p.name.toLowerCase().includes('noshow')
  );
  console.log(JSON.stringify(matches.map((p) => ({
    internalName: p.name,
    label: p.label,
    type: p.type,
    fieldType: p.fieldType,
    groupName: p.groupName,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    modificationMetadata: p.modificationMetadata,
  })), null, 2));
  process.exit(0);
}
main();
