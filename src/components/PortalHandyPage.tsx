import type { Customer } from '@/types';

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
 */

type Props = { customer: Customer };

// Per-workflow_key configuration. When new workflows are added, add a row.
// The default fallback handles unknown workflow_keys gracefully.
const HANDY_PAGE_LINKS: Record<string, {
  productUrl: string;
  supportMeetingUrl: string | null;          // null until user provides the HubSpot round-robin link
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

export default function PortalHandyPage({ customer }: Props) {
  const config = HANDY_PAGE_LINKS[customer.workflowKey] ?? FALLBACK;
  const firstName = customer.name.split(' ')[0];
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
            href={config.productUrl}
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

      {/* Support */}
      <section className="rounded-lg border border-[#E0DEE4] bg-white p-5">
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[#1B2E35]/60">
          Get help
        </h3>
        <div className="space-y-2">
          {config.supportMeetingUrl ? (
            <a
              href={config.supportMeetingUrl}
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
          {customer.platformEmail && (
            <div>
              <dt className="text-[#1B2E35]/60">Sign-in email</dt>
              <dd className="font-medium text-[#1B2E35]">{customer.platformEmail}</dd>
            </div>
          )}
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
          <div>
            <dt className="text-[#1B2E35]/60">Plan</dt>
            <dd className="font-medium text-[#1B2E35]">{customer.workflowKey}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
