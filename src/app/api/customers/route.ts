import { NextRequest } from 'next/server';
import { createRecord } from '@/lib/airtable-client';

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { name, type, channel, email, businessName, businessAddress, website, phone, hasVoice, hasAvatar } = body as {
    name: string;
    type: string;
    channel: string;
    email: string;
    businessName?: string;
    businessAddress?: string;
    website?: string;
    phone?: string;
    hasVoice?: boolean;
    hasAvatar?: boolean;
  };

  if (!name || !type || !channel || !email) {
    return Response.json(
      { error: 'Missing required fields: name, type, channel, email' },
      { status: 400 },
    );
  }

  // Create the customer record — Airtable Auto 1 handles task generation
  const customerFields: Record<string, unknown> = {
    Name: name,
    Type: type,
    Channel: channel,
    'Contact Email': email,
  };
  if (businessName) customerFields['Business Name'] = businessName;
  if (businessAddress) customerFields['Business Address'] = businessAddress;
  if (website) customerFields['Website'] = website;
  if (phone) customerFields['Phone'] = phone;
  if (hasVoice) customerFields['Has Voice'] = true;
  if (hasAvatar) customerFields['Has Avatar'] = true;

  const customerRecord = await createRecord('Customers', customerFields);

  return Response.json({
    id: customerRecord.id,
    accessToken: customerRecord.id,
    name,
    type,
    channel,
  });
}
