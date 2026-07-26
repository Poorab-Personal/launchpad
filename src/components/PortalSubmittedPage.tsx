import type { Customer } from '@/types';

/**
 * Terminal page for intake-only pilot workflows (see
 * CORE_TERMINAL_STAGE_OVERRIDE in activate-dependents.ts). Rendered when
 * `customer.currentStage === 'Submitted'` — the agent has submitted their
 * intake form but there is no account, no credentials, and no onboarding
 * call yet (CSM/ops follows up manually via HubSpot for the duration of the
 * pilot). Deliberately shows none of PortalHandyPage's product link / temp
 * password — those don't exist for this customer.
 */
type Props = {
  customer: Customer;
};

export default function PortalSubmittedPage({ customer }: Props) {
  return (
    <div className="rounded-2xl border border-[#E0DEE4] bg-white p-8 text-center sm:p-12">
      <h1 className="text-2xl font-bold text-[#1B2E35]">
        Thanks, {customer.name.split(' ')[0]}!
      </h1>
      <p className="mt-3 text-[#1B2E35]/70">
        We&apos;ve received your information. Our team will be in touch with next steps soon.
      </p>
    </div>
  );
}
