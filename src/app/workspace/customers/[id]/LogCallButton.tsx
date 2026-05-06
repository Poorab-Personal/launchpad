'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { logCall } from './call-actions';

export type CSMOption = {
  id: string;
  name: string;
};

const CALL_TYPES = ['Onboarding', 'Check-In 1', 'Check-In 2', 'Ad-hoc'] as const;
const STATUSES = ['Scheduled', 'Completed', 'No Show', 'Rescheduled', 'Canceled'] as const;

function nowLocalDatetime(): string {
  // Format: YYYY-MM-DDTHH:MM (datetime-local input format, in local TZ)
  const d = new Date();
  const tzOffsetMs = d.getTimezoneOffset() * 60_000;
  const local = new Date(d.getTime() - tzOffsetMs);
  return local.toISOString().slice(0, 16);
}

export default function LogCallButton({
  customerId,
  currentMemberId,
  csms,
}: {
  customerId: string;
  currentMemberId: string;
  csms: CSMOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const [type, setType] = useState<(typeof CALL_TYPES)[number]>('Ad-hoc');

  // Default status follows the type: Ad-hoc → Completed, others → Scheduled
  const defaultStatus = type === 'Ad-hoc' ? 'Completed' : 'Scheduled';

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const fd = new FormData(e.currentTarget);
    fd.set('customerId', customerId);
    startTransition(async () => {
      const res = await logCall(fd);
      if (res.ok) {
        setOpen(false);
        formRef.current?.reset();
        setType('Ad-hoc');
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  // Ensure currentMemberId is in the CSM list (so default selection is valid).
  const csmOptions = csms.some((c) => c.id === currentMemberId)
    ? csms
    : [{ id: currentMemberId, name: 'Me' }, ...csms];

  return (
    <div className="space-y-3">
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-full bg-[#6C4AB6] px-4 py-2 text-sm font-medium text-white hover:bg-[#553a91] transition-colors"
        >
          + Log a call
        </button>
      ) : (
        <form
          ref={formRef}
          onSubmit={handleSubmit}
          className="rounded-xl border border-[#6C4AB6]/30 bg-[#6C4AB6]/5 p-4 space-y-3"
        >
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-[#1B2E35]">Log a call</p>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setError(null);
              }}
              disabled={pending}
              className="text-xs text-[#1B2E35]/60 hover:text-[#1B2E35]"
            >
              Cancel
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-[11px] uppercase tracking-wide text-[#1B2E35]/50 font-medium mb-1">
                Type
              </span>
              <select
                name="type"
                value={type}
                onChange={(e) => setType(e.target.value as (typeof CALL_TYPES)[number])}
                disabled={pending}
                className="w-full rounded-md border border-[#E0DEE4] bg-white px-2 py-1.5 text-sm text-[#1B2E35] focus:border-[#6C4AB6] focus:outline-none focus:ring-1 focus:ring-[#6C4AB6]/30"
              >
                {CALL_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="block text-[11px] uppercase tracking-wide text-[#1B2E35]/50 font-medium mb-1">
                Status
              </span>
              <select
                name="status"
                defaultValue={defaultStatus}
                key={`status-${type}`}
                disabled={pending}
                className="w-full rounded-md border border-[#E0DEE4] bg-white px-2 py-1.5 text-sm text-[#1B2E35] focus:border-[#6C4AB6] focus:outline-none focus:ring-1 focus:ring-[#6C4AB6]/30"
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>

            <label className="block sm:col-span-1">
              <span className="block text-[11px] uppercase tracking-wide text-[#1B2E35]/50 font-medium mb-1">
                Date &amp; time
              </span>
              <input
                type="datetime-local"
                name="scheduledDate"
                defaultValue={nowLocalDatetime()}
                disabled={pending}
                className="w-full rounded-md border border-[#E0DEE4] bg-white px-2 py-1.5 text-sm text-[#1B2E35] focus:border-[#6C4AB6] focus:outline-none focus:ring-1 focus:ring-[#6C4AB6]/30"
              />
            </label>

            <label className="block sm:col-span-1">
              <span className="block text-[11px] uppercase tracking-wide text-[#1B2E35]/50 font-medium mb-1">
                CSM
              </span>
              <select
                name="csmId"
                defaultValue={currentMemberId}
                disabled={pending}
                className="w-full rounded-md border border-[#E0DEE4] bg-white px-2 py-1.5 text-sm text-[#1B2E35] focus:border-[#6C4AB6] focus:outline-none focus:ring-1 focus:ring-[#6C4AB6]/30"
              >
                {csmOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="block">
            <span className="block text-[11px] uppercase tracking-wide text-[#1B2E35]/50 font-medium mb-1">
              Notes (optional)
            </span>
            <textarea
              name="notes"
              rows={3}
              disabled={pending}
              placeholder="What was discussed?"
              className="w-full rounded-md border border-[#E0DEE4] bg-white px-2 py-1.5 text-sm text-[#1B2E35] focus:border-[#6C4AB6] focus:outline-none focus:ring-1 focus:ring-[#6C4AB6]/30 resize-y min-h-[4rem]"
            />
          </label>

          <label className="block">
            <span className="block text-[11px] uppercase tracking-wide text-[#1B2E35]/50 font-medium mb-1">
              Recording URL (optional)
            </span>
            <input
              type="url"
              name="recordingUrl"
              disabled={pending}
              placeholder="https://…"
              className="w-full rounded-md border border-[#E0DEE4] bg-white px-2 py-1.5 text-sm text-[#1B2E35] focus:border-[#6C4AB6] focus:outline-none focus:ring-1 focus:ring-[#6C4AB6]/30"
            />
          </label>

          {error && <p className="text-sm text-[#EC531A]">{error}</p>}

          <div className="flex justify-end gap-2">
            <button
              type="submit"
              disabled={pending}
              className="rounded-full bg-[#6C4AB6] px-4 py-2 text-sm font-medium text-white hover:bg-[#553a91] disabled:opacity-50"
            >
              {pending ? 'Saving…' : 'Log call'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
