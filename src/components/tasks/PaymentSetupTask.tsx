'use client';

import { useEffect, useMemo, useState } from 'react';
import { loadStripe, type Stripe as StripeJs } from '@stripe/stripe-js';
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from '@stripe/react-stripe-js';
import type { Task, StripePlan, Customer } from '@/types';

const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;

// Lazy-loaded once per app lifetime. If the key isn't set, the component
// renders a helpful error instead of crashing.
let _stripePromise: Promise<StripeJs | null> | null = null;
function getStripe(): Promise<StripeJs | null> {
  if (!PUBLISHABLE_KEY) return Promise.resolve(null);
  if (!_stripePromise) _stripePromise = loadStripe(PUBLISHABLE_KEY);
  return _stripePromise;
}

export default function PaymentSetupTask({
  task,
  customerId,
  customer,
  workflowKey,
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

  const [plans, setPlans] = useState<StripePlan[] | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<StripePlan | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [stage, setStage] = useState<'pickPlan' | 'enterCard' | 'done'>(
    alreadyPaid ? 'done' : 'pickPlan',
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const stripePromise = useMemo(() => getStripe(), []);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/stripe/plans?workflowKey=${encodeURIComponent(workflowKey)}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (!data.plans) throw new Error('No plans returned');
        setPlans(data.plans as StripePlan[]);
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : 'Failed to load plans'));
    return () => {
      cancelled = true;
    };
  }, [workflowKey]);

  async function handlePickPlan(plan: StripePlan) {
    setError(null);
    setLoading(true);
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
      setLoading(false);
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

  if (stage === 'pickPlan') {
    if (!plans) {
      return <div className="text-sm text-[#1B2E35]/60">Loading plans…</div>;
    }
    if (plans.length === 0) {
      return (
        <div className="rounded-lg border border-[#EC531A]/30 bg-[#EC531A]/5 px-4 py-3 text-sm text-[#EC531A]">
          No active plans available. Please contact support.
        </div>
      );
    }
    return (
      <div className="space-y-4">
        {task.instructions && (
          <p className="text-[#1B2E35]/70 leading-relaxed">{task.instructions}</p>
        )}
        <div className="space-y-3">
          {plans.map((plan) => (
            <button
              key={plan.id}
              onClick={() => handlePickPlan(plan)}
              disabled={loading}
              className="w-full rounded-lg border border-[#E0DEE4] bg-white p-4 text-left transition-all hover:border-[#6C4AB6] hover:shadow-sm disabled:opacity-50"
            >
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-base font-medium text-[#1B2E35]">{plan.planName}</p>
                  {plan.description && (
                    <p className="mt-1 text-sm text-[#1B2E35]/60">{plan.description}</p>
                  )}
                </div>
                <span className="shrink-0 text-sm text-[#6C4AB6]">Choose →</span>
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (stage === 'enterCard' && clientSecret && selectedPlan) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg bg-[#F7F4EB] px-4 py-3 text-sm">
          <p className="font-medium text-[#1B2E35]">{selectedPlan.planName}</p>
          {selectedPlan.description && (
            <p className="mt-0.5 text-[#1B2E35]/60">{selectedPlan.description}</p>
          )}
          <button
            onClick={() => {
              setStage('pickPlan');
              setSelectedPlan(null);
              setClientSecret(null);
            }}
            className="mt-2 text-xs text-[#1B2E35]/60 underline"
          >
            Change plan
          </button>
        </div>
        <Elements stripe={stripePromise} options={{ clientSecret, appearance: { theme: 'stripe' } }}>
          <CardForm
            customerId={customerId}
            taskId={task.id}
            plan={selectedPlan}
            onSuccess={() => {
              setStage('done');
              onComplete();
            }}
          />
        </Elements>
      </div>
    );
  }

  if (stage === 'done') {
    const savedPlanName = customer?.selectedPlanName ?? selectedPlan?.planName ?? '';
    return (
      <div className="space-y-3">
        <div className="rounded-lg border border-[#05C68E]/30 bg-[#05C68E]/5 px-4 py-3 text-sm text-[#1B2E35]">
          <div className="flex items-center gap-2">
            <span className="font-medium text-[#05C68E]">✓ Payment method saved</span>
          </div>
          {savedPlanName && (
            <div className="mt-1 text-[#1B2E35]/70">
              Plan: <span className="font-medium text-[#1B2E35]">{savedPlanName}</span>
            </div>
          )}
          <div className="mt-1 text-xs text-[#1B2E35]/60">
            Your free trial starts after your onboarding call. You won&apos;t be charged during the trial.
          </div>
        </div>
        <p className="text-xs text-[#1B2E35]/50">
          Need to change your plan or card? Contact support.
        </p>
      </div>
    );
  }

  return null;
}

function CardForm({
  customerId,
  taskId,
  plan,
  onSuccess,
}: {
  customerId: string;
  taskId: string;
  plan: StripePlan;
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
        className="inline-flex items-center gap-2 rounded-full bg-[#05C68E] px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#04946A] disabled:opacity-50 disabled:cursor-not-allowed"
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
