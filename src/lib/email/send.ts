import { Resend } from 'resend';
import * as React from 'react';
import WelcomeEmail from './templates/welcome';
import DesignReadyEmail from './templates/design-ready';
import CredentialsSentEmail from './templates/credentials-sent';
import MagicLinkEmail from './templates/magic-link';

const FROM = 'Rejig.ai Success Team <success@rejig.ai>';
const REPLY_TO = 'success@rejig.ai';

export type EmailTemplate = 'welcome' | 'design-ready' | 'credentials-sent';

interface BaseData {
  firstName: string;
  portalUrl: string;
}

interface CredentialsData extends BaseData {
  platformEmail: string;
  password: string;
  /** ISO date of the booked onboarding call. Empty when not yet booked. */
  callDate: string;
}

interface DesignReadyData extends BaseData {
  /** Latest designer note attached to the proof being sent. Optional. */
  designerNote?: string | null;
}

type TemplateDataMap = {
  welcome: BaseData;
  'design-ready': DesignReadyData;
  'credentials-sent': CredentialsData;
};

const subjects: Record<EmailTemplate, string> = {
  welcome: 'Welcome to Rejig — your portal is ready',
  'design-ready': 'Your design proof is ready to review',
  'credentials-sent': 'Your Rejig account is ready',
};

function renderTemplate<T extends EmailTemplate>(
  template: T,
  data: TemplateDataMap[T],
): React.ReactElement {
  switch (template) {
    case 'welcome':
      return React.createElement(WelcomeEmail, data as BaseData);
    case 'design-ready':
      return React.createElement(DesignReadyEmail, data as DesignReadyData);
    case 'credentials-sent':
      return React.createElement(CredentialsSentEmail, data as CredentialsData);
  }
  // exhaustiveness guard
  throw new Error(`Unknown email template: ${template}`);
}

export async function sendEmail<T extends EmailTemplate>({
  template,
  to,
  data,
}: {
  template: T;
  to: string;
  data: TemplateDataMap[T];
}) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY is not set');
  }
  const resend = new Resend(apiKey);

  const result = await resend.emails.send({
    from: FROM,
    to,
    replyTo: REPLY_TO,
    subject: subjects[template],
    react: renderTemplate(template, data),
  });

  if (result.error) {
    throw new Error(`Resend error: ${result.error.message}`);
  }
  return result.data;
}

/**
 * Send a plain-text operational alert (e.g. cron failure) to the ops inbox.
 * Separate from sendEmail() because:
 *   - No React template — plain text only.
 *   - Recipient is internal ops (ALERTS_EMAIL), not a customer.
 *   - Subject is dynamic (per-incident), not template-keyed.
 *
 * Reuses the same Resend client construction + error-surfacing pattern as
 * sendEmail() / sendMagicLinkEmail() so callers don't need to import Resend
 * directly. Per docs/integrations/dmg-roster-plan.md §6.3.
 */
export async function sendAlertEmail({
  to,
  subject,
  text,
}: {
  to: string;
  subject: string;
  text: string;
}) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY is not set');
  }
  const resend = new Resend(apiKey);

  const result = await resend.emails.send({
    from: FROM,
    to,
    replyTo: REPLY_TO,
    subject,
    text,
  });

  if (result.error) {
    throw new Error(`Resend error: ${result.error.message}`);
  }
  return result.data;
}

/**
 * Send a magic-link sign-in email to an internal team member.
 * Separate from sendEmail() because the data shape is different
 * (signInUrl vs portalUrl) and the recipient is internal, not a customer.
 */
export async function sendMagicLinkEmail({
  to,
  firstName,
  signInUrl,
}: {
  to: string;
  firstName: string;
  signInUrl: string;
}) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY is not set');
  }
  const resend = new Resend(apiKey);

  const result = await resend.emails.send({
    from: FROM,
    to,
    replyTo: REPLY_TO,
    subject: 'Your LaunchPad sign-in link',
    react: React.createElement(MagicLinkEmail, { firstName, signInUrl }),
  });

  if (result.error) {
    throw new Error(`Resend error: ${result.error.message}`);
  }
  return result.data;
}
