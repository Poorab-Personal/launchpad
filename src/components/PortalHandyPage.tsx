'use client';

import { useState } from 'react';
import type { Customer } from '@/types';
import { tempPasswordFromName } from '@/lib/temp-password';

/**
 * The customer's permanent post-launch home base. Rendered by /r/[token]
 * when `customer.currentStage === 'Launched'`.
 *
 * Per docs/plans/post-launch-migration.md: LaunchPad's responsibility ends
 * at "Launched" (customer has credentials + signed in). Post-launch CSM
 * tasks, attention-state management, and check-ins live in HubSpot. This
 * page is the durable surface the customer returns to — links to the
 * product, support, and a credentials reminder. It does NOT show tasks or
 * track workflow progression.
 *
 * Per-workflow_key URL variation is controlled by HANDY_PAGE_LINKS below.
 * The "Book a support call" link is a HubSpot Meetings round-robin page
 * with 15/30/45-minute slot options, separate from the onboarding meeting
 * page (which only takes 1-hour slots).
 *
 * Resolution order for the support meeting URL:
 *   1. (future) brokerages.supportMeetingUrl — per-brokerage override
 *   2. HANDY_PAGE_LINKS[workflowKey].supportMeetingUrl — per-workflow override
 *   3. settings.default_support_meeting_url — Rejig-wide default
 *   4. null → falls back to "email support" message
 */

type Props = {
  customer: Customer;
  defaultSupportMeetingUrl: string | null;
};

// Per-workflow_key overrides. Add a row per workflow_key if/when its support
// URL needs to differ from the Rejig-wide default. Today all three use the
// default (settings.default_support_meeting_url).
const HANDY_PAGE_LINKS: Record<string, {
  productUrl: string;
  supportMeetingUrl: string | null;          // null = fall through to default
}> = {
  'D2C-Standard': {
    productUrl: 'https://app.rejig.ai',
    supportMeetingUrl: null,
  },
  'B2B-Keyes': {
    productUrl: 'https://app.rejig.ai',
    supportMeetingUrl: null,
  },
  'B2B-BW': {
    productUrl: 'https://app.rejig.ai',
    supportMeetingUrl: null,
  },
};

const FALLBACK = HANDY_PAGE_LINKS['D2C-Standard'];

export default function PortalHandyPage({ customer, defaultSupportMeetingUrl }: Props) {
  const config = HANDY_PAGE_LINKS[customer.workflowKey] ?? FALLBACK;
  const supportMeetingUrl = config.supportMeetingUrl ?? defaultSupportMeetingUrl;
  const firstName = customer.name.split(' ')[0];
  const email = customer.platformEmail ?? '';
  const password = tempPasswordFromName(customer.name ?? '');
  const launchUrl = email
    ? `${config.productUrl}/?email=${encodeURIComponent(email)}`
    : config.productUrl;
  const [copied, setCopied] = useState<'email' | 'password' | null>(null);

  async function copy(text: string, kind: 'email' | 'password') {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1200);
    } catch {
      // clipboard unavailable
    }
  }

  const stageEnteredAt = customer.stageEnteredAt
    ? new Date(customer.stageEnteredAt).toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
      })
    : null;

  return (
    <div className="space-y-6">
      {/* Hero */}
      <div className="rounded-xl bg-gradient-to-br from-[#05C68E]/10 to-[#6C4AB6]/10 border border-[#05C68E]/20 px-6 py-8">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#05C68E]/20">
            <svg className="h-5 w-5 text-[#05C68E]" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
            </svg>
          </span>
          <div>
            <h2 className="text-xl font-bold text-[#1B2E35]">
              You&rsquo;re all set, {firstName}.
            </h2>
            <p className="mt-1 text-sm text-[#1B2E35]/70">
              Your Rejig account is live. Pick up where you left off, or reach out anytime.
            </p>
          </div>
        </div>
      </div>

      {/* Primary actions */}
      <section className="rounded-lg border border-[#E0DEE4] bg-white p-5">
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[#1B2E35]/60">
          Your account
        </h3>
        <div className="space-y-3">
          <a
            href={launchUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-between rounded-lg border border-[#6C4AB6]/30 bg-[#6C4AB6]/5 px-4 py-3 transition-colors hover:bg-[#6C4AB6]/10"
          >
            <div>
              <p className="font-medium text-[#1B2E35]">Go to Rejig</p>
              <p className="text-xs text-[#1B2E35]/60">{config.productUrl}</p>
            </div>
            <svg className="h-4 w-4 text-[#6C4AB6]" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
            </svg>
          </a>
        </div>
      </section>

      {/* Sign-in credentials */}
      {(email || password) && (
        <section className="rounded-lg border border-[#E0DEE4] bg-white p-5">
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[#1B2E35]/60">
            Sign-in credentials
          </h3>
          <div className="space-y-4">
            {email && (
              <div>
                <label className="mb-1.5 block text-xs uppercase tracking-wide text-[#1B2E35]/60 font-semibold">
                  Email
                </label>
                <div className="flex items-center gap-2">
                  <input
                    readOnly
                    value={email}
                    onFocus={(e) => e.currentTarget.select()}
                    className="flex-1 rounded-lg border border-[#E0DEE4] bg-[#F7F4EB] px-3 py-2 text-sm text-[#1B2E35] font-mono focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => copy(email, 'email')}
                    className="rounded-lg border border-[#E0DEE4] bg-white px-3 py-2 text-xs text-[#1B2E35]/70 hover:border-[#6C4AB6] hover:text-[#6C4AB6]"
                  >
                    {copied === 'email' ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              </div>
            )}
            {password && (
              <div>
                <label className="mb-1.5 block text-xs uppercase tracking-wide text-[#1B2E35]/60 font-semibold">
                  Temporary password
                </label>
                <div className="flex items-center gap-2">
                  <input
                    readOnly
                    value={password}
                    onFocus={(e) => e.currentTarget.select()}
                    className="flex-1 rounded-lg border border-[#E0DEE4] bg-[#F7F4EB] px-3 py-2 text-sm text-[#1B2E35] font-mono focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => copy(password, 'password')}
                    className="rounded-lg border border-[#E0DEE4] bg-white px-3 py-2 text-xs text-[#1B2E35]/70 hover:border-[#6C4AB6] hover:text-[#6C4AB6]"
                  >
                    {copied === 'password' ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <p className="mt-1.5 text-xs text-[#1B2E35]/50">
                  We recommend changing this on first sign in.
                </p>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Support */}
      <section className="rounded-lg border border-[#E0DEE4] bg-white p-5">
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[#1B2E35]/60">
          Get help
        </h3>
        <div className="space-y-2">
          {supportMeetingUrl ? (
            <a
              href={supportMeetingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between rounded-lg border border-[#E0DEE4] px-4 py-3 transition-colors hover:bg-[#F7F4EB]"
            >
              <div>
                <p className="font-medium text-[#1B2E35]">Book a support session</p>
                <p className="text-xs text-[#1B2E35]/60">15, 30, or 45 minutes with a CSM</p>
              </div>
              <svg className="h-4 w-4 text-[#1B2E35]/40" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
              </svg>
            </a>
          ) : (
            <div className="rounded-lg border border-dashed border-[#E0DEE4] bg-[#F7F4EB] px-4 py-3 text-sm text-[#1B2E35]/60">
              Booking link coming soon — email{' '}
              <a href="mailto:support@rejig.ai" className="text-[#6C4AB6] hover:underline">
                support@rejig.ai
              </a>{' '}
              for now.
            </div>
          )}
          <a
            href="mailto:support@rejig.ai"
            className="flex items-center justify-between rounded-lg border border-[#E0DEE4] px-4 py-3 transition-colors hover:bg-[#F7F4EB]"
          >
            <div>
              <p className="font-medium text-[#1B2E35]">Email support</p>
              <p className="text-xs text-[#1B2E35]/60">support@rejig.ai</p>
            </div>
            <svg className="h-4 w-4 text-[#1B2E35]/40" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75" />
            </svg>
          </a>
        </div>
      </section>

      {/* Account details */}
      <section className="rounded-lg border border-[#E0DEE4] bg-white p-5">
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[#1B2E35]/60">
          Account details
        </h3>
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          {customer.businessName && (
            <div>
              <dt className="text-[#1B2E35]/60">Business</dt>
              <dd className="font-medium text-[#1B2E35]">{customer.businessName}</dd>
            </div>
          )}
          {stageEnteredAt && (
            <div>
              <dt className="text-[#1B2E35]/60">Onboarded</dt>
              <dd className="font-medium text-[#1B2E35]">{stageEnteredAt}</dd>
            </div>
          )}
        </dl>
      </section>
    </div>
  );
}
