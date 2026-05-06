'use client';

import { useActionState } from 'react';
import { sendMagicLink, type SignInState } from './actions';

const initial: SignInState = { status: 'idle' };

export default function SignInPage() {
  const [state, action, pending] = useActionState(sendMagicLink, initial);

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F7F4EB] px-4">
      <div className="w-full max-w-sm">
        <div className="flex justify-center mb-6">
          <span className="text-[#6C4AB6] text-2xl font-bold tracking-tight">
            Rejig.ai
          </span>
        </div>
        <div className="rounded-lg border border-[#E0DEE4] bg-white p-8 shadow-[0px_4px_12px_#1B2E3514]">
          <h1 className="text-xl font-bold text-[#1B2E35] mb-1">
            Sign in to LaunchPad
          </h1>
          <p className="text-sm text-[#1B2E35]/60 mb-6">
            Enter your work email — we&apos;ll send you a sign-in link.
          </p>

          {state.status === 'sent' ? (
            <div className="rounded-lg bg-[#05C68E]/10 border border-[#05C68E]/30 p-4 text-sm text-[#1B2E35]">
              <p className="font-medium mb-1">Check your inbox</p>
              <p className="text-[#1B2E35]/70">{state.message}</p>
            </div>
          ) : (
            <form action={action} className="space-y-4">
              <input
                type="email"
                name="email"
                placeholder="you@rejig.ai"
                autoFocus
                required
                disabled={pending}
                className="w-full rounded-lg border border-[#E0DEE4] bg-white px-3 py-2.5 text-sm text-[#1B2E35] placeholder:text-[#1B2E35]/40 focus:border-[#6C4AB6] focus:outline-none focus:ring-2 focus:ring-[#6C4AB6]/20 disabled:opacity-50"
              />
              {state.status === 'error' && (
                <p className="text-sm text-[#EC531A]">{state.message}</p>
              )}
              <button
                type="submit"
                disabled={pending}
                className="w-full rounded-full bg-[#05C68E] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#04946A] disabled:opacity-50"
              >
                {pending ? 'Sending…' : 'Send sign-in link'}
              </button>
            </form>
          )}
        </div>

        <p className="text-center text-xs text-[#1B2E35]/50 mt-4">
          Internal tool. If you don&apos;t have access, ask an admin to add you.
        </p>
      </div>
    </div>
  );
}
