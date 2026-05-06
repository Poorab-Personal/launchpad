'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { markTaskComplete } from './actions';

export default function ProofTaskAction({
  customerId,
  taskId,
  hasExistingProof,
  proofRequired,
  ctaLabel,
}: {
  customerId: string;
  taskId: string;
  hasExistingProof: boolean;
  /** When true, must have either an existing proof or a newly-picked file before marking complete */
  proofRequired: boolean;
  ctaLabel: string;
}) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingTransition, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const pending = busy || pendingTransition;
  const canSubmit = !proofRequired || hasExistingProof || pickedFile !== null;
  const buttonDisabled = pending || !canSubmit;

  async function handleSubmit() {
    setError(null);

    // Path A: a new file was picked → upload then mark complete (server route does both)
    if (pickedFile) {
      setBusy(true);
      try {
        const fd = new FormData();
        fd.append('file', pickedFile);
        fd.append('customerId', customerId);
        fd.append('taskId', taskId);
        const res = await fetch('/api/workspace/design-proof', {
          method: 'POST',
          body: fd,
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? 'Upload failed');
        }
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Upload failed');
        setBusy(false);
      }
      return;
    }

    // Path B: no new file → just mark complete (proof already exists for required tasks)
    startTransition(async () => {
      const res = await markTaskComplete(taskId, customerId);
      if (!res.ok) {
        setError(res.error);
      } else {
        router.refresh();
      }
    });
  }

  return (
    <div className="space-y-2">
      <div>
        <label className="block text-xs uppercase tracking-wide text-[#1B2E35]/60 font-semibold mb-1.5">
          {hasExistingProof ? 'Replace proof (optional)' : `Attach proof${proofRequired ? '' : ' (optional)'}`}
        </label>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,application/pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) setPickedFile(f);
          }}
        />
        {pickedFile ? (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-[#6C4AB6]/30 bg-[#6C4AB6]/5 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-[#6C4AB6] truncate">
                {pickedFile.name}
              </p>
              <p className="text-[10px] text-[#1B2E35]/50">
                {(pickedFile.size / 1_000_000).toFixed(1)}MB
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setPickedFile(null);
                if (fileInputRef.current) fileInputRef.current.value = '';
              }}
              className="text-xs text-[#1B2E35]/50 hover:text-[#EC531A]"
            >
              Remove
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="w-full rounded-lg border border-dashed border-[#E0DEE4] bg-white px-3 py-2 text-xs text-[#1B2E35]/60 hover:border-[#6C4AB6]/50 hover:text-[#6C4AB6] transition-colors"
          >
            Choose file… (PNG, JPG, PDF · max 3.5MB)
          </button>
        )}
      </div>

      {proofRequired && !hasExistingProof && !pickedFile && (
        <p className="text-xs text-[#1B2E35]/50">
          A proof must be attached before sending to the customer.
        </p>
      )}

      <button
        type="button"
        disabled={buttonDisabled}
        onClick={handleSubmit}
        className="w-full rounded-full bg-[#05C68E] px-4 py-2 text-sm font-medium text-white hover:bg-[#04946A] disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {pending
          ? pickedFile
            ? 'Uploading…'
            : 'Saving…'
          : pickedFile
            ? `Upload & ${ctaLabel}`
            : ctaLabel}
      </button>

      {error && <p className="text-sm text-[#EC531A] text-center">{error}</p>}
    </div>
  );
}
