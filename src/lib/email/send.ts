import { Resend } from 'resend';
import * as React from 'react';
import WelcomeEmail from './templates/welcome';
import DesignReadyEmail from './templates/design-ready';
import CredentialsSentEmail from './templates/credentials-sent';
import MagicLinkEmail from './templates/magic-link';
import TaskAssignedEmail from './templates/task-assigned';
import DailyDigestEmail from './templates/daily-digest';
import type {
  Section1Row,
  Section2Row,
} from '@/lib/automations/daily-checks';

const FROM = 'Rejig.ai Success Team <success@rejig.ai>';
const REPLY_TO = 'success@rejig.ai';

/**
 * Templates that go to the customer's inbox — these get auto-BCC'd to the
 * internal monitoring address so we can spot delivery / content issues
 * without polling Resend. Excludes internal-team templates (task-assigned,
 * magic-link) and ops alerts (sendAlertEmail).
 *
 * TODO: once the team is monitoring, swap to success@rejig.ai.
 */
const CUSTOMER_FACING_TEMPLATES: ReadonlySet<EmailTemplate> = new Set([
  'welcome',
  'design-ready',
  'credentials-sent',
]);
const CUSTOMER_EMAIL_BCC = 'poorab@rejig.ai';

export type EmailTemplate = 'welcome' | 'design-ready' | 'credentials-sent' | 'task-assigned';

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

interface TaskAssignedData {
  firstName: string;
  taskName: string;
  customerName: string;
  workspaceUrl: string;
  instructions?: string | null;
}

type TemplateDataMap = {
  welcome: BaseData;
  'design-ready': DesignReadyData;
  'credentials-sent': CredentialsData;
  'task-assigned': TaskAssignedData;
};

const subjects: Record<EmailTemplate, string> = {
  welcome: 'Welcome to Rejig — your portal is ready',
  'design-ready': 'Your design proof is ready to review',
  'credentials-sent': 'Your Rejig account is ready',
  // Overridden per-call by sendEmail({ subject }) — task-assigned interpolates
  // the task and customer name. This static fallback is only used if a caller
  // forgets the override.
  'task-assigned': 'New task in your queue',
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
    case 'task-assigned':
      return React.createElement(TaskAssignedEmail, data as TaskAssignedData);
  }
  // exhaustiveness guard
  throw new Error(`Unknown email template: ${template}`);
}

export async function sendEmail<T extends EmailTemplate>({
  template,
  to,
  cc,
  data,
  subject,
}: {
  template: T;
  to: string;
  /** Optional CC. Used to loop the sales rep in on the welcome email (deal
   * owner from HubSpot); passed through unchanged when null/undefined. */
  cc?: string | null;
  data: TemplateDataMap[T];
  /** Optional override. When omitted, falls back to the static `subjects[template]`. */
  subject?: string;
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
    subject: subject ?? subjects[template],
    react: renderTemplate(template, data),
    ...(cc ? { cc } : {}),
    ...(CUSTOMER_FACING_TEMPLATES.has(template) ? { bcc: CUSTOMER_EMAIL_BCC } : {}),
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
 * Send the daily B2B-onboarding gap-detection digest. Internal recipients
 * (success/poorab/matt) — separate from sendEmail() because the data shape
 * is the runDailyChecks() result, not the customer-template map.
 *
 * Caller should pre-check that at least one section is non-empty before
 * calling this — empty digests are silently skipped at the cron route.
 */
export async function sendDailyDigestEmail({
  to,
  cc,
  digestDate,
  section1,
  section2,
}: {
  to: string | string[];
  cc?: string | string[];
  digestDate: string; // YYYY-MM-DD
  section1: Section1Row[];
  section2: Section2Row[];
}) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY is not set');
  }
  const resend = new Resend(apiKey);

  const total = section1.length + section2.length;
  const subject = `[LaunchPad] Daily checks — ${total} item${total === 1 ? '' : 's'} (${digestDate})`;

  const result = await resend.emails.send({
    from: FROM,
    to,
    cc,
    replyTo: REPLY_TO,
    subject,
    react: React.createElement(DailyDigestEmail, {
      digestDate,
      section1,
      section2,
    }),
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
