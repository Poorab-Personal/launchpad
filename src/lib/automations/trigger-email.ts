/**
 * Auto 5 / Auto 6 port — fire customer-facing emails on triggers.
 *
 *   - Auto 5 "Welcome" → fires after POST /api/customers commits
 *   - Auto 6 "Design Ready" → fires when "Review & Approve Your Brand Kit"
 *     task transitions to Active (in Auto 2's new-stage activation pass)
 *
 * Both are best-effort: failures are logged but don't bubble. The email
 * route route at /api/email/send still works for Airtable Auto 5/6 to
 * POST into during the cutover window — this helper is for the new
 * automation hooks.
 */
import { getCustomerById } from '@/lib/db';
import { sendEmail, type EmailTemplate } from '@/lib/email/send';

function firstName(fullName: string): string {
  const trimmed = fullName.trim();
  if (!trimmed) return 'there';
  return trimmed.split(/\s+/)[0];
}

export async function triggerCustomerEmail(
  template: EmailTemplate,
  customerId: string,
): Promise<void> {
  if (template === 'credentials-sent') {
    // Credentials require a temp password from /api/workspace/send-credentials.
    // Reject silently here to surface the misuse in logs.
    console.warn(
      `[triggerCustomerEmail] credentials-sent must come from /api/workspace/send-credentials; skipping for ${customerId}`,
    );
    return;
  }

  const customer = await getCustomerById(customerId);
  if (!customer) {
    console.warn(`[triggerCustomerEmail] customer ${customerId} not found; skipping ${template}`);
    return;
  }
  if (!customer.contactEmail) {
    console.warn(`[triggerCustomerEmail] customer ${customerId} has no contact email; skipping ${template}`);
    return;
  }

  const portalBase = customer.portalBaseUrl || 'https://launchpad-indol-ten.vercel.app';
  const portalUrl = `${portalBase}/r/${customer.accessToken}`;
  const fname = firstName(customer.name);

  try {
    await sendEmail({
      template,
      to: customer.contactEmail,
      data: { firstName: fname, portalUrl },
    });
  } catch (err) {
    console.error(`[triggerCustomerEmail] ${template} send failed for ${customerId}:`, err);
  }
}
