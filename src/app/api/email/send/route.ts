import { NextRequest } from 'next/server';
import { getCustomerById } from '@/lib/db';
import { sendEmail, type EmailTemplate } from '@/lib/email/send';

const VALID_TEMPLATES: EmailTemplate[] = ['welcome', 'design-ready', 'credentials-sent'];

function firstName(fullName: string): string {
  const trimmed = fullName.trim();
  if (!trimmed) return 'there';
  return trimmed.split(/\s+/)[0];
}

/**
 * Trigger an outbound email for a customer.
 *
 * Body: { template: EmailTemplate, customerId: string }
 *
 * Called by Airtable automations when specific tasks complete or when a new
 * customer is created. The template's data is built from the Customer record
 * (no extra fields needed in the request).
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const template = body?.template as EmailTemplate | undefined;
  const customerId = body?.customerId as string | undefined;

  if (!template || !VALID_TEMPLATES.includes(template)) {
    return Response.json(
      { error: `template must be one of: ${VALID_TEMPLATES.join(', ')}` },
      { status: 400 },
    );
  }
  if (!customerId) {
    return Response.json({ error: 'customerId is required' }, { status: 400 });
  }

  const customer = await getCustomerById(customerId);
  if (!customer) {
    return Response.json({ error: `Customer ${customerId} not found` }, { status: 404 });
  }

  const recipient = customer.contactEmail;
  if (!recipient) {
    return Response.json(
      { error: `Customer ${customerId} has no Contact Email` },
      { status: 422 },
    );
  }

  const portalBase = customer.portalBaseUrl || 'https://launchpad-indol-ten.vercel.app';
  const portalUrl = `${portalBase}/r/${customer.id}`;

  const fname = firstName(customer.name);

  try {
    if (template === 'credentials-sent') {
      // Credentials emails now require a Temporary Password generated in the
      // workspace at send-time. Use the Account Creator workspace
      // (POST /api/workspace/send-credentials) instead of this generic route.
      return Response.json(
        {
          error:
            'credentials-sent must be sent via /api/workspace/send-credentials so a temporary password can be generated.',
        },
        { status: 400 },
      );
    }

    const result = await sendEmail({
      template,
      to: recipient,
      data: { firstName: fname, portalUrl },
    });
    return Response.json({ ok: true, id: result?.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return Response.json({ error: message }, { status: 500 });
  }
}
