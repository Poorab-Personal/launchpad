'use client';

import { useState } from 'react';
import type { Task, Customer } from '@/types';

export default function ProofTask({
  task,
  customerId,
  customer,
  onComplete,
}: {
  task: Task;
  customerId: string;
  customer?: Customer;
  onComplete: () => void;
}) {
  const [loading, setLoading] = useState<'approve' | 'changes' | null>(null);
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedbackText, setFeedbackText] = useState('');
  const [feedbackSent, setFeedbackSent] = useState(false);

  // Get proof image from customer's Design Proof attachment field
  const proofUrl = customer?.designProof?.[0]?.url;

  async function handleApprove() {
    setLoading('approve');
    try {
      await fetch(`/api/customers/${customerId}/design-approval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approval: 'Approved' }),
      });
      onComplete();
    } finally {
      setLoading(null);
    }
  }

  async function handleRequestChanges() {
    setLoading('changes');
    try {
      await fetch(`/api/customers/${customerId}/design-approval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approval: 'Changes Requested', feedback: feedbackText }),
      });
      setFeedbackSent(true);
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="space-y-5">
      {task.instructions && (
        <p className="text-[#1B2E35]/70 leading-relaxed">{task.instructions}</p>
      )}

      {/* Proof image */}
      <div className="overflow-hidden rounded-lg border border-[#E0DEE4] bg-[#F7F4EB]">
        <div className="flex items-center gap-2 border-b border-[#E0DEE4] bg-white px-4 py-3">
          <svg className="h-5 w-5 text-[#6C4AB6]" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0 0 22.5 18.75V5.25A2.25 2.25 0 0 0 20.25 3H3.75A2.25 2.25 0 0 0 1.5 5.25v13.5A2.25 2.25 0 0 0 3.75 21Z" />
          </svg>
          <span className="text-sm font-medium text-[#1B2E35]">Design Proof</span>
        </div>
        <div className="flex flex-col items-center justify-center p-4">
          {proofUrl ? (
            <img
              src={proofUrl}
              alt="Design proof"
              className="max-w-full rounded-lg"
            />
          ) : (
            <div className="w-full max-w-md">
              <div className="aspect-[4/3] rounded-lg bg-gradient-to-br from-[#6C4AB6]/10 via-[#F7F4EB] to-[#05C68E]/10 flex items-center justify-center">
                <div className="text-center space-y-3 p-6">
                  <div className="mx-auto h-16 w-16 rounded-full bg-white/60 flex items-center justify-center">
                    <svg className="h-8 w-8 text-[#6C4AB6]" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0 0 22.5 18.75V5.25A2.25 2.25 0 0 0 20.25 3H3.75A2.25 2.25 0 0 0 1.5 5.25v13.5A2.25 2.25 0 0 0 3.75 21Z" />
                    </svg>
                  </div>
                  <p className="text-sm font-medium text-[#1B2E35]">Your brand kit proof</p>
                  <p className="text-xs text-[#1B2E35]/50">Your design proof will appear here</p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Feedback sent confirmation */}
      {feedbackSent ? (
        <div className="rounded-lg bg-[#05C68E]/5 border border-[#05C68E]/20 px-5 py-4 text-sm text-[#1B2E35]">
          Your feedback has been sent to our design team. We&apos;ll email you when the revised proof is ready.
        </div>
      ) : (
        <>
          {showFeedback && (
            <div className="space-y-3">
              <label htmlFor="design-feedback" className="block text-sm font-semibold text-[#1B2E35]/87">
                What changes would you like?
              </label>
              <textarea
                id="design-feedback"
                value={feedbackText}
                onChange={(e) => setFeedbackText(e.target.value)}
                placeholder="Describe the changes you'd like to see..."
                rows={4}
                className="w-full rounded-lg border border-[#E0DEE4] bg-white px-3 py-2 text-sm text-[#1B2E35] placeholder:text-[#1B2E35]/40 focus:border-[#6C4AB6] focus:outline-none focus:ring-2 focus:ring-[#6C4AB6]/20"
              />
              <button
                onClick={handleRequestChanges}
                disabled={loading !== null || !feedbackText.trim()}
                className="inline-flex items-center gap-2 rounded-full bg-[#05C68E] px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#04946A] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading === 'changes' ? (
                  <>
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    Submitting…
                  </>
                ) : (
                  'Submit Feedback'
                )}
              </button>
            </div>
          )}

          <div className="flex flex-wrap gap-3">
            <button
              onClick={handleApprove}
              disabled={loading !== null}
              className="inline-flex items-center gap-2 rounded-full bg-[#05C68E] px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#04946A] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading === 'approve' ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  Approving…
                </>
              ) : (
                <>
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                  </svg>
                  Approve
                </>
              )}
            </button>
            {!showFeedback && (
              <button
                onClick={() => setShowFeedback(true)}
                disabled={loading !== null}
                className="inline-flex items-center gap-2 rounded-full border border-[#1B2E35]/20 bg-white px-6 py-2.5 text-sm font-medium text-[#1B2E35] transition-colors hover:bg-[#F7F4EB] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Request Changes
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
