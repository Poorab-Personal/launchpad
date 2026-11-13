'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { RejigSyncSummary } from '@/lib/db';
import type { NameSource } from '@/lib/rejig-sync/payload';
import { syncToRejigAction } from './rejig-sync-actions';

/**
 * Account Creator's panel for pushing this customer to Rejig's staging
 * table, where they finish the account in "Create Account (New)". Dev is for
 * testing; Prod stays disabled until its key is configured. Syncing never
 * completes a task — Mark Account Created is still the Account Creator's
 * click once the account exists. Plan: docs/plans/rejig-account-sync.md.
 */

type Env = 'dev' | 'prod';

const OUTCOME_LABELS: Record<string, string> = {
  created: 'Sent',
  updated: 'Updated',
  locked: 'Already created in Rejig',
  domain_exists: 'Website already in Rejig',
  validation_error: 'Rejected by Rejig',
  auth_error: 'API key rejected',
  http_error: 'Rejig error',
  network_error: "Couldn't reach Rejig",
};

const SOURCE_NOTES: Record<NameSource, string> = {
  saved: 'As last sent to Rejig.',
  roster: 'From the brokerage roster.',
  guessed: 'Guessed from the customer name. Check before syncing.',
};

function ago(isoTs: string): string {
  const mins = Math.round((Date.now() - new Date(isoTs).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const inputClass =
  'w-full rounded-lg border bg-white px-3 py-2 text-sm text-[#1B2E35] focus:outline-none focus:ring-2 focus:ring-[#6C4AB6]/30 focus:border-[#6C4AB6] disabled:opacity-50';

export default function RejigSyncCard({
  customerId,
  initialName,
  initialIsTeam,
  recordMissing,
  lastSyncs,
  devConfigured,
  prodConfigured,
}: {
  customerId: string;
  initialName: { firstName: string; lastName: string; source: NameSource };
  initialIsTeam: { isTeam: boolean; source: 'saved' | 'guessed' };
  /** Website / brand-kit gaps, computed on the server. Names are checked here as they're typed. */
  recordMissing: string[];
  lastSyncs: Partial<Record<Env, RejigSyncSummary>>;
  devConfigured: boolean;
  prodConfigured: boolean;
}) {
  const router = useRouter();
  const [firstName, setFirstName] = useState(initialName.firstName);
  const [lastName, setLastName] = useState(initialName.lastName);
  const [edited, setEdited] = useState(false);
  const [isTeam, setIsTeam] = useState(initialIsTeam.isTeam);
  const [voiceTouched, setVoiceTouched] = useState(false);
  const [confirmingProd, setConfirmingProd] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const missing = [
    ...(firstName.trim() ? [] : ['First name']),
    ...(lastName.trim() ? [] : ['Last name']),
    ...recordMissing,
  ];
  const ready = missing.length === 0;
  const guessed = initialName.source === 'guessed' && !edited;
  const voiceGuessed = initialIsTeam.source === 'guessed' && !voiceTouched;

  function sync(env: Env) {
    setResult(null);
    startTransition(async () => {
      const res = await syncToRejigAction({ customerId, env, firstName, lastName, isTeam });
      setResult({ ok: res.ok, message: res.message });
      setConfirmingProd(false);
      setConfirmText('');
      router.refresh();
    });
  }

  return (
    <section className="rounded-xl bg-white border border-[#E0DEE4] p-5 space-y-4">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-[#1B2E35]/70">Sync to Rejig</h2>
        <p className="text-xs text-[#1B2E35]/50 mt-0.5">
          Sends the intake details and Brand Kit to Rejig. Finish the account in Rejig&apos;s Create Account (New).
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {(
          [
            ['rejig-first-name', 'First name', firstName, setFirstName],
            ['rejig-last-name', 'Last name', lastName, setLastName],
          ] as const
        ).map(([id, label, value, set]) => (
          <div key={id}>
            <label htmlFor={id} className="block text-xs uppercase tracking-wide text-[#1B2E35]/60 font-semibold mb-1">
              {label}
            </label>
            <input
              id={id}
              type="text"
              value={value}
              disabled={pending}
              onChange={(e) => {
                set(e.target.value);
                setEdited(true);
              }}
              className={`${inputClass} ${guessed ? 'border-[#EC531A] bg-[#EC531A]/5' : 'border-[#E0DEE4]'}`}
            />
          </div>
        ))}
      </div>
      <p className={`-mt-2 text-[11px] ${guessed ? 'text-[#EC531A] font-medium' : 'text-[#1B2E35]/50'}`}>
        {edited ? 'Edited. Saved when you sync.' : SOURCE_NOTES[initialName.source]}
      </p>

      <div>
        <p className="block text-xs uppercase tracking-wide text-[#1B2E35]/60 font-semibold mb-1">Writes as</p>
        <div
          role="radiogroup"
          aria-label="Writes as"
          className={`grid grid-cols-2 gap-1 rounded-lg border p-1 ${
            voiceGuessed ? 'border-[#EC531A] bg-[#EC531A]/5' : 'border-[#E0DEE4]'
          }`}
        >
          {(
            [
              [false, 'Individual', 'I / me'],
              [true, 'Team', 'we / us'],
            ] as const
          ).map(([value, label, hint]) => (
            <button
              key={label}
              type="button"
              role="radio"
              aria-checked={isTeam === value}
              disabled={pending}
              onClick={() => {
                setIsTeam(value);
                setVoiceTouched(true);
              }}
              className={`rounded-md px-2 py-1.5 text-sm disabled:opacity-50 ${
                isTeam === value ? 'bg-[#6C4AB6] font-medium text-white' : 'text-[#1B2E35] hover:bg-[#6C4AB6]/10'
              }`}
            >
              {label} <span className={isTeam === value ? 'text-white/70' : 'text-[#1B2E35]/50'}>({hint})</span>
            </button>
          ))}
        </div>
        <p className={`mt-1 text-[11px] ${voiceGuessed ? 'text-[#EC531A] font-medium' : 'text-[#1B2E35]/50'}`}>
          {voiceTouched
            ? 'Changed. Saved when you sync.'
            : initialIsTeam.source === 'saved'
              ? 'As last sent to Rejig.'
              : 'Guessed from the name. Check before syncing.'}
        </p>
      </div>

      {ready ? (
        <p className="text-xs font-medium text-[#04946A]">Ready to sync.</p>
      ) : (
        <div className="rounded-lg bg-[#D97706]/10 px-3 py-2">
          <p className="text-xs font-semibold text-[#B45309]">Can&apos;t sync yet. Missing:</p>
          <ul className="mt-1 list-disc pl-4 text-xs text-[#B45309]">
            {missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-2">
        <button
          type="button"
          onClick={() => sync('dev')}
          disabled={!ready || !devConfigured || pending}
          className="w-full rounded-full bg-[#6C4AB6] px-4 py-2 text-sm font-medium text-white hover:bg-[#5A3FA0] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {pending ? 'Syncing…' : 'Sync to Rejig Dev'}
        </button>

        {!confirmingProd ? (
          <button
            type="button"
            onClick={() => setConfirmingProd(true)}
            disabled={!ready || !prodConfigured || pending}
            title={prodConfigured ? undefined : 'Rejig Prod is not set up yet'}
            className="w-full rounded-full border border-[#EC531A]/60 px-4 py-2 text-sm font-medium text-[#EC531A] hover:bg-[#EC531A]/5 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {prodConfigured ? 'Sync to Rejig Prod…' : 'Sync to Rejig Prod (not set up)'}
          </button>
        ) : (
          <div className="rounded-lg border border-[#EC531A]/40 bg-[#EC531A]/5 p-3 space-y-2">
            <label htmlFor="rejig-prod-confirm" className="block text-xs text-[#1B2E35]">
              This sends <b>{firstName} {lastName}</b> to <b>Rejig Prod</b>. Type <b>PROD</b> to confirm.
            </label>
            <input
              id="rejig-prod-confirm"
              type="text"
              autoComplete="off"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              className={`${inputClass} border-[#E0DEE4]`}
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => sync('prod')}
                disabled={confirmText !== 'PROD' || pending}
                className="flex-1 rounded-full bg-[#EC531A] px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Sync to Prod
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmingProd(false);
                  setConfirmText('');
                }}
                className="rounded-full px-3 py-1.5 text-sm text-[#1B2E35]/60 hover:text-[#1B2E35]"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {result && (
        <p className={`text-xs ${result.ok ? 'text-[#04946A]' : 'text-[#EC531A]'}`}>{result.message}</p>
      )}

      <dl className="space-y-1 border-t border-[#E0DEE4] pt-3 text-xs">
        {(['dev', 'prod'] as const).map((env) => {
          const s = lastSyncs[env];
          return (
            <div key={env} className="flex justify-between gap-2">
              <dt className="text-[#1B2E35]/50">{env === 'dev' ? 'Dev' : 'Prod'}</dt>
              <dd className="text-right text-[#1B2E35]">
                {s ? (
                  <>
                    {OUTCOME_LABELS[s.outcome] ?? s.outcome} · {ago(s.at)}
                    {s.actorName && ` · ${s.actorName.split(' ')[0]}`}
                  </>
                ) : (
                  <span className="text-[#1B2E35]/40">Never synced</span>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
