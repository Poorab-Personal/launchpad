'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { updateCallNotes, updateCallRecording } from './call-actions';

type Field = 'notes' | 'recording';

export default function CallNotesEditor({
  callId,
  customerId,
  initialValue,
  field,
  placeholder,
  rows,
  className,
}: {
  callId: string;
  customerId: string;
  initialValue: string;
  field: Field;
  placeholder?: string;
  /** Only used when field === 'notes' */
  rows?: number;
  className?: string;
}) {
  // React 19 pattern for "reset state when a prop changes": store the
  // last-seen prop value as state. When the parent passes a new
  // `initialValue`, we detect the difference during render and call
  // `setX` synchronously — React will discard the in-progress render and
  // re-render with the new state, no effect needed.
  const [lastInitial, setLastInitial] = useState(initialValue);
  const [value, setValue] = useState(initialValue);
  const [savedValue, setSavedValue] = useState(initialValue);
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (lastInitial !== initialValue) {
    setLastInitial(initialValue);
    setValue(initialValue);
    setSavedValue(initialValue);
  }

  useEffect(() => {
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  function handleBlur() {
    if (value === savedValue) return;
    setError(null);
    startTransition(async () => {
      const res =
        field === 'notes'
          ? await updateCallNotes(callId, value, customerId)
          : await updateCallRecording(callId, value, customerId);
      if (res.ok) {
        setSavedValue(value);
        setStatus('saved');
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
        savedTimerRef.current = setTimeout(() => setStatus('idle'), 1500);
      } else {
        setStatus('error');
        setError(res.error);
      }
    });
  }

  const baseInputClass =
    'w-full rounded-md border border-[#E0DEE4] bg-white px-2 py-1.5 text-sm text-[#1B2E35] focus:border-[#6C4AB6] focus:outline-none focus:ring-1 focus:ring-[#6C4AB6]/30 disabled:opacity-50';

  return (
    <div className={`relative ${className ?? ''}`}>
      {field === 'notes' ? (
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={handleBlur}
          disabled={pending}
          rows={rows ?? 3}
          placeholder={placeholder ?? 'Add notes…'}
          className={`${baseInputClass} resize-y min-h-[3rem]`}
        />
      ) : (
        <input
          type="url"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={handleBlur}
          disabled={pending}
          placeholder={placeholder ?? 'https://…'}
          className={baseInputClass}
        />
      )}
      <div className="mt-1 h-4 text-xs">
        {pending && <span className="text-[#1B2E35]/40">Saving…</span>}
        {!pending && status === 'saved' && (
          <span className="text-[#04946A]">Saved ✓</span>
        )}
        {!pending && status === 'error' && error && (
          <span className="text-[#EC531A]">{error}</span>
        )}
      </div>
    </div>
  );
}
