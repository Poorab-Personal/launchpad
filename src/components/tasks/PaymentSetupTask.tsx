'use client';

import { useEffect, useMemo, useState } from 'react';
import { loadStripe, type Stripe as StripeJs } from '@stripe/stripe-js';
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from '@stripe/react-stripe-js';
import type { Task, Customer } from '@/types';

const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;

// Lazy-loaded once per app lifetime. If the key isn't set, the component
// renders a helpful error instead of crashing.
let _stripePromise: Promise<StripeJs | null> | null = null;
function getStripe(): Promise<StripeJs | null> {
  if (!PUBLISHABLE_KEY) return Promise.resolve(null);
  if (!_stripePromise) _stripePromise = loadStripe(PUBLISHABLE_KEY);
  return _stripePromise;
}

type PlanOption = {
  id: string;
  stripePriceId: string;
  planName: string;
  priceDisplay: string;
  pricePeriod: string;
  billingDetail: string;
  footnote: string;
  highlight: string;
};

type PricingPayload = {
  brokerageName: string;
  brokerageShortName: string;
  brokerageLogoUrl: string | null;
  tagline: string;
  features: string[];
  trialDays: number;
  plans: PlanOption[];
};

// D2C falls back to brokerageName = 'Rejig.ai' in the API; the component uses
// that to suppress the brokerage-partnership framing.
const REJIG_PRODUCT_NAME = 'Rejig.ai';
const REJIG_SUPPORT_EMAIL = 'support@rejig.ai';
// Rejig wordmark — matches the portal header logo at /r/[token]/page.tsx.
const REJIG_LOGO_URL =
  'https://rejig.ai/wp-content/themes/rejigchild/assets/images/rejig-logo-1.png';

export default function PaymentSetupTask({
  task,
  customerId,
  customer,
  onComplete,
}: {
  task: Task;
  customerId: string;
  customer?: Customer;
  workflowKey: string;
  onComplete: () => void;
}) {
  // If the customer already has a saved plan, start in the 'done' state so
  // revisiting the tab shows a summary instead of the picker.
  const alreadyPaid = !!(customer?.selectedStripePriceId && customer?.selectedPlanName);

  const [pricing, setPricing] = useState<PricingPayload | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<PlanOption | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [stage, setStage] = useState<'pickPlan' | 'enterCard' | 'done'>(
    alreadyPaid ? 'done' : 'pickPlan',
  );
  const [error, setError] = useState<string | null>(null);
  const [loadingPriceId, setLoadingPriceId] = useState<string | null>(null);

  const stripePromise = useMemo(() => getStripe(), []);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/stripe/plans?customerId=${encodeURIComponent(customerId)}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (!data || !Array.isArray(data.plans)) throw new Error('Malformed plans response');
        setPricing(data as PricingPayload);
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : 'Failed to load plans'));
    return () => {
      cancelled = true;
    };
  }, [customerId]);

  async function handlePickPlan(plan: PlanOption) {
    setError(null);
    setLoadingPriceId(plan.stripePriceId);
    try {
      const res = await fetch(`/api/customers/${customerId}/payment-setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stripePriceId: plan.stripePriceId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed to start payment setup');
      setSelectedPlan(plan);
      setClientSecret(data.clientSecret);
      setStage('enterCard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoadingPriceId(null);
    }
  }

  if (!PUBLISHABLE_KEY) {
    return (
      <div className="rounded-lg border border-[#EC531A]/30 bg-[#EC531A]/5 px-4 py-3 text-sm text-[#EC531A]">
        Payment is not configured for this environment. Please contact support.
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-[#EC531A]/30 bg-[#EC531A]/5 px-4 py-3 text-sm text-[#EC531A]">
          {error}
        </div>
        <button
          onClick={() => {
            setError(null);
            setStage('pickPlan');
            setSelectedPlan(null);
            setClientSecret(null);
          }}
          className="text-sm text-[#1B2E35]/70 underline"
        >
          Start over
        </button>
      </div>
    );
  }

  if (stage === 'done') {
    return <DoneState planName={customer?.selectedPlanName ?? selectedPlan?.planName ?? ''} trialDays={pricing?.trialDays ?? 0} />;
  }

  if (stage === 'enterCard' && clientSecret && selectedPlan) {
    return (
      <CardEntryStage
        plan={selectedPlan}
        clientSecret={clientSecret}
        stripePromise={stripePromise}
        customerId={customerId}
        taskId={task.id}
        trialDays={pricing?.trialDays ?? 0}
        onBack={() => {
          setStage('pickPlan');
          setSelectedPlan(null);
          setClientSecret(null);
        }}
        onSuccess={() => {
          setStage('done');
          onComplete();
        }}
      />
    );
  }

  // stage === 'pickPlan'
  if (!pricing) {
    return <div className="text-sm text-[#1B2E35]/60">Loading plans…</div>;
  }
  if (pricing.plans.length === 0) {
    return (
      <div className="rounded-lg border border-[#EC531A]/30 bg-[#EC531A]/5 px-4 py-3 text-sm text-[#EC531A]">
        No active plans available. Please contact support.
      </div>
    );
  }
  return (
    <PricingPage
      pricing={pricing}
      onPick={handlePickPlan}
      loadingPriceId={loadingPriceId}
    />
  );
}

function PricingPage({
  pricing,
  onPick,
  loadingPriceId,
}: {
  pricing: PricingPayload;
  onPick: (p: PlanOption) => void;
  loadingPriceId: string | null;
}) {
  const { brokerageName, brokerageShortName, brokerageLogoUrl, tagline, features, trialDays, plans } = pricing;
  // D2C / unconfigured = no brokerage co-brand to surface; the partnership
  // framing only makes sense when there's a real brokerage in play.
  const hasBrokerage = brokerageName !== REJIG_PRODUCT_NAME;
  // Adaptive grid: 1 plan = single centered card, 2 = 2-col, 3+ = 3-col
  const gridCols = plans.length === 1 ? 'grid-cols-1' : plans.length === 2 ? 'md:grid-cols-2' : 'md:grid-cols-3';
  // Always "Choose Your Plan" — "Start Your … Trial" misled customers into
  // thinking the trial begins today. Trial mechanics live in the banner + the
  // "here's how it works" callout below.
  const heading = 'Choose Your Plan';

  return (
    <div className="mx-auto max-w-4xl space-y-10">
      <header className="text-center space-y-2">
        <h2 className="text-3xl font-semibold tracking-tight text-[#1B2E35]">{heading}</h2>
        {trialDays > 0 && (
          // Was a loud orange tinted pill that upstaged the Recommended badge.
          // Now a restrained line in brand purple — same color system as the
          // primary action, no second accent competing.
          <p className="text-sm font-medium text-[#6C4AB6]">
            No charge today · {trialDays}-day free trial starts on your onboarding call
          </p>
        )}
        {tagline && <p className="text-sm text-[#1B2E35]/60">{tagline}</p>}
      </header>

      {/* Plans + trust row visually grouped — the trust signals hug the cards
          (tight space-y-4) so they read as belonging to the action above, not
          as a separate section. */}
      <div className="space-y-4">
        <div className={`grid gap-4 ${gridCols}`}>
          {plans.map((plan) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              loading={loadingPriceId === plan.stripePriceId}
              disabled={loadingPriceId !== null && loadingPriceId !== plan.stripePriceId}
              onPick={() => onPick(plan)}
            />
          ))}
        </div>

        {/* Compact trust row — single neutral ink color throughout. "Stripe"
            in semibold (no brand purple — was a second accent that didn't
            earn its keep). Check icons in muted ink, not mint. */}
        <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-3 text-sm text-[#1B2E35]/75">
          <span className="inline-flex items-center gap-1.5">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 0h10.5a2.25 2.25 0 0 1 2.25 2.25v6.75a2.25 2.25 0 0 1-2.25 2.25H6.75a2.25 2.25 0 0 1-2.25-2.25v-6.75a2.25 2.25 0 0 1 2.25-2.25Z" />
            </svg>
            Encrypted by <span className="font-semibold text-[#1B2E35]">Stripe</span>
          </span>
          <span aria-hidden className="text-[#1B2E35]/20">·</span>
          <span className="inline-flex items-center gap-1.5">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
            </svg>
            <a href={`mailto:${REJIG_SUPPORT_EMAIL}`} className="hover:underline">
              Cancel anytime
            </a>
          </span>
          {trialDays > 0 && (
            <>
              <span aria-hidden className="text-[#1B2E35]/20">·</span>
              <span className="inline-flex items-center gap-1.5">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                </svg>
                {trialDays}-day free trial
              </span>
            </>
          )}
        </div>
      </div>

      {features.length > 0 && (
        // Collapsible — closed by default. The features card was eating a huge
        // vertical chunk; agents who care can expand, the rest get a cleaner page.
        <details className="group rounded-xl border border-[#E0DEE4] bg-white">
          <summary className="flex cursor-pointer list-none items-center justify-between px-6 py-4">
            <span className="text-sm font-semibold uppercase tracking-wide text-[#1B2E35]/70">
              What&apos;s included
            </span>
            <svg
              className="h-4 w-4 text-[#1B2E35]/50 transition-transform group-open:rotate-180"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
            </svg>
          </summary>
          <ul className="grid gap-3 px-6 pb-6 sm:grid-cols-2">
            {features.map((feature) => (
              <li key={feature} className="flex items-start gap-3 text-sm text-[#1B2E35]">
                <svg
                  className="mt-0.5 h-5 w-5 shrink-0 text-[#05C68E]"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={2.5}
                  stroke="currentColor"
                  aria-hidden="true"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                </svg>
                <span>{feature}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Partnership lockup — moved to the bottom (was redundantly above the
          "What's included" box AND repeated again in a "A program from…"
          footer line). One placement, one statement. Grayscale + same height
          so the two logos read as a quiet co-brand. */}
      <div className="flex flex-wrap items-center justify-center gap-3 text-sm text-[#1B2E35]/60">
        <span>Brought to you by</span>
        {hasBrokerage && brokerageLogoUrl && (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={brokerageLogoUrl}
              alt={brokerageName}
              className="h-7 w-auto object-contain opacity-70 grayscale"
            />
            <span>in partnership with</span>
          </>
        )}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={REJIG_LOGO_URL}
          alt="Rejig.ai"
          className="h-7 w-auto object-contain opacity-70 grayscale"
        />
      </div>

    </div>
  );
}

function PlanCard({
  plan,
  loading,
  disabled,
  onPick,
}: {
  plan: PlanOption;
  loading: boolean;
  disabled: boolean;
  onPick: () => void;
}) {
  const isHighlighted = !!plan.highlight;
  return (
    <div
      className={`relative flex flex-col rounded-xl border bg-white p-6 transition-all ${
        isHighlighted
          ? 'border-[#6C4AB6] shadow-md ring-1 ring-[#6C4AB6]/20'
          : 'border-[#E0DEE4] hover:border-[#6C4AB6]/40'
      }`}
    >
      {plan.highlight && (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-[#6C4AB6] px-3 py-1 text-xs font-semibold text-white whitespace-nowrap">
          {plan.highlight}
        </span>
      )}
      <h3 className="text-lg font-semibold text-[#1B2E35]">{plan.planName}</h3>
      <div className="mt-4 flex items-baseline gap-1">
        <span className="text-4xl font-bold text-[#1B2E35]">{plan.priceDisplay}</span>
        {plan.pricePeriod && (
          <span className="text-base text-[#1B2E35]/60">{plan.pricePeriod}</span>
        )}
      </div>
      {plan.billingDetail && (
        <p className="mt-1 text-sm text-[#1B2E35]/70">{plan.billingDetail}</p>
      )}
      {plan.footnote && (
        <div className="mt-2">
          <span className="inline-flex items-center rounded-full bg-[#05C68E]/12 px-2.5 py-0.5 text-xs font-semibold text-[#05C68E]">
            {plan.footnote}
          </span>
        </div>
      )}
      {/* Wrapper: mt-auto pushes the button to the bottom (CTAs align across
          cards regardless of content), pt-6 guarantees breathing room above
          the button even when both cards have similar content heights. */}
      <div className="mt-auto pt-6">
      <button
        type="button"
        onClick={onPick}
        disabled={loading || disabled}
        // Same button style on both cards — Recommended-ness lives in the
        // badge + border, not in a different button color. One CTA affordance,
        // not two competing ones.
        className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-[#1B2E35] px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#1B2E35]/90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading ? (
          <>
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
            Loading…
          </>
        ) : (
          'Choose this plan'
        )}
      </button>
      </div>
    </div>
  );
}


function CardEntryStage({
  plan,
  clientSecret,
  stripePromise,
  customerId,
  taskId,
  trialDays,
  onBack,
  onSuccess,
}: {
  plan: PlanOption;
  clientSecret: string;
  stripePromise: Promise<StripeJs | null>;
  customerId: string;
  taskId: string;
  trialDays: number;
  onBack: () => void;
  onSuccess: () => void;
}) {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {/* Proper Back button — clear affordance to return to the plan picker
          without using browser back (which would leave the portal entirely).
          The "Change plan" link in the summary card below is a contextual
          secondary path; this one is the primary nav. */}
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-[#1B2E35]/70 transition-colors hover:text-[#6C4AB6]"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
        </svg>
        Back to plans
      </button>

      <header className="space-y-1">
        <h2 className="text-2xl font-semibold text-[#1B2E35]">Save your card to create your account</h2>
        <p className="text-sm text-[#1B2E35]/70">
          We&apos;ll save it securely with Stripe —{' '}
          <strong className="font-semibold text-[#1B2E35]">no charge today.</strong>{' '}
          {trialDays > 0 ? (
            <>
              Your{' '}
              <strong className="font-semibold text-[#1B2E35]">
                {trialDays}-day free trial starts the day of your onboarding call,
              </strong>{' '}
              and you won&apos;t be charged until it ends.
            </>
          ) : (
            `You won't be charged until your onboarding call is complete.`
          )}
        </p>
      </header>

      <div className="rounded-lg border border-[#E0DEE4] bg-[#F7F4EB] px-5 py-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-[#1B2E35]">{plan.planName}</p>
            <p className="mt-0.5 text-sm text-[#1B2E35]/70">
              {plan.priceDisplay}
              {plan.pricePeriod}
              {plan.billingDetail ? ` · ${plan.billingDetail}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onBack}
            className="text-xs text-[#6C4AB6] underline whitespace-nowrap transition-colors hover:text-[#1B2E35]"
          >
            Change plan
          </button>
        </div>
      </div>

      <Elements stripe={stripePromise} options={{ clientSecret, appearance: { theme: 'stripe' } }}>
        <CardForm
          customerId={customerId}
          taskId={taskId}
          plan={plan}
          onSuccess={onSuccess}
        />
      </Elements>
    </div>
  );
}

function DoneState({ planName, trialDays }: { planName: string; trialDays: number }) {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-[#05C68E]/30 bg-[#05C68E]/5 px-4 py-3 text-sm text-[#1B2E35]">
        <div className="flex items-center gap-2">
          <span className="font-medium text-[#05C68E]">✓ You&apos;re in — we&apos;re creating your account</span>
        </div>
        {planName && (
          <div className="mt-1 text-[#1B2E35]/70">
            Plan: <span className="font-medium text-[#1B2E35]">{planName}</span>
          </div>
        )}
        <div className="mt-1 text-xs text-[#1B2E35]/60">
          {trialDays > 0
            ? `Your ${trialDays}-day free trial starts the day of your onboarding call — you won't be charged before then. We've started getting your personalized AI ready.`
            : `Your subscription starts the day of your onboarding call. We've started getting your personalized AI ready.`}
        </div>
      </div>
      <p className="text-xs text-[#1B2E35]/50">
        Need to change your plan or card? Contact support.
      </p>
    </div>
  );
}

function CardForm({
  customerId,
  taskId,
  plan,
  onSuccess,
}: {
  customerId: string;
  taskId: string;
  plan: PlanOption;
  onSuccess: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setSubmitting(true);
    setError(null);

    const { error: stripeError } = await stripe.confirmSetup({
      elements,
      redirect: 'if_required',
    });
    if (stripeError) {
      setError(stripeError.message ?? 'Card confirmation failed');
      setSubmitting(false);
      return;
    }

    // Card saved successfully. Tell the server: record the plan choice +
    // mark the task complete. Phase 1.7 webhook will redo this server-side
    // as a safety net (idempotent).
    try {
      const res = await fetch(`/api/customers/${customerId}/payment-setup/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stripePriceId: plan.stripePriceId,
          planName: plan.planName,
          taskId,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed to record plan choice');
      onSuccess();
    } catch (err) {
      setError(
        (err instanceof Error ? err.message : 'Failed to finalize') +
          ' — your card was saved but the plan was not recorded. Please contact support.',
      );
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* layout="tabs" puts each payment method side-by-side with Card pre-selected
          (no extra click to expand). Default accordion collapses everything. */}
      <PaymentElement options={{ layout: 'tabs' }} />
      {error && (
        <div className="rounded-lg border border-[#EC531A]/30 bg-[#EC531A]/5 px-4 py-3 text-sm text-[#EC531A]">
          {error}
        </div>
      )}
      <button
        type="submit"
        disabled={!stripe || !elements || submitting}
        className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-[#05C68E] px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-[#04946A] disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {submitting ? (
          <>
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
            Saving…
          </>
        ) : (
          'Save card — no charge today'
        )}
      </button>
      <p className="flex items-center justify-center gap-1.5 text-xs text-[#1B2E35]/55">
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 0h10.5a2.25 2.25 0 0 1 2.25 2.25v6.75a2.25 2.25 0 0 1-2.25 2.25H6.75a2.25 2.25 0 0 1-2.25-2.25v-6.75a2.25 2.25 0 0 1 2.25-2.25Z" />
        </svg>
        Encrypted via Stripe · Cancel anytime
      </p>
    </form>
  );
}
