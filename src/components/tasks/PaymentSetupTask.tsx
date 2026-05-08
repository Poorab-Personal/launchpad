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
  tagline: string;
  features: string[];
  trialDays: number;
  plans: PlanOption[];
};

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
  const { brokerageName, tagline, features, trialDays, plans } = pricing;
  // Adaptive grid: 1 plan = single centered card, 2 = 2-col, 3+ = 3-col
  const gridCols = plans.length === 1 ? 'grid-cols-1' : plans.length === 2 ? 'md:grid-cols-2' : 'md:grid-cols-3';
  const heading =
    trialDays > 0 ? `Start Your ${trialDays}-Day Free Trial` : `Choose Your Plan`;

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <header className="text-center space-y-2">
        <h2 className="text-3xl font-semibold tracking-tight text-[#1B2E35]">{heading}</h2>
        <p className="text-[#1B2E35]/70">{tagline}</p>
      </header>

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

      {features.length > 0 && (
        <div className="rounded-xl border border-[#E0DEE4] bg-white p-6">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-[#1B2E35]/60 mb-4">
            What&apos;s included
          </h3>
          <ul className="grid gap-3 sm:grid-cols-2">
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
        </div>
      )}

      <TrialCallout trialDays={trialDays} />

      <p className="text-center text-xs text-[#1B2E35]/50">
        Powered by Stripe. {brokerageName === 'Rejig.ai' ? 'Rejig.ai' : `${brokerageName} × Rejig.ai`}
      </p>
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
        <p className="mt-1 text-xs text-[#1B2E35]/50">{plan.footnote}</p>
      )}
      <button
        type="button"
        onClick={onPick}
        disabled={loading || disabled}
        className={`mt-6 inline-flex items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
          isHighlighted
            ? 'bg-[#6C4AB6] text-white hover:bg-[#5A3DA5]'
            : 'bg-[#1B2E35] text-white hover:bg-[#1B2E35]/90'
        }`}
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
  );
}

function TrialCallout({ trialDays }: { trialDays: number }) {
  const message =
    trialDays > 0
      ? `Your ${trialDays}-day free trial starts the day of your onboarding call — you won't be charged until ${trialDays} days after that.`
      : `Your subscription starts the day of your onboarding call. We're saving your card now so we can activate billing then.`;
  return (
    <div className="rounded-xl border border-[#EC531A]/20 bg-[#EC531A]/5 px-6 py-5">
      <div className="flex items-start gap-3">
        <svg
          className="mt-0.5 h-6 w-6 shrink-0 text-[#EC531A]"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.8}
          stroke="currentColor"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
          />
        </svg>
        <div className="space-y-1">
          <p className="text-sm font-semibold text-[#1B2E35]">No charge today</p>
          <p className="text-sm text-[#1B2E35]/80 leading-relaxed">{message}</p>
        </div>
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
      <header className="space-y-1">
        <h2 className="text-2xl font-semibold text-[#1B2E35]">Add your payment method</h2>
        <p className="text-sm text-[#1B2E35]/70">
          We&apos;ll save your card securely with Stripe.{' '}
          {trialDays > 0
            ? `You won't be charged until ${trialDays} days after your onboarding call.`
            : `You won't be charged until your onboarding call is complete.`}
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
            className="text-xs text-[#6C4AB6] underline whitespace-nowrap"
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
          <span className="font-medium text-[#05C68E]">✓ Payment method saved</span>
        </div>
        {planName && (
          <div className="mt-1 text-[#1B2E35]/70">
            Plan: <span className="font-medium text-[#1B2E35]">{planName}</span>
          </div>
        )}
        <div className="mt-1 text-xs text-[#1B2E35]/60">
          {trialDays > 0
            ? `Your ${trialDays}-day free trial starts after your onboarding call. You won't be charged during the trial.`
            : `Your subscription starts after your onboarding call.`}
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
      <PaymentElement />
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
          'Save payment method'
        )}
      </button>
    </form>
  );
}
