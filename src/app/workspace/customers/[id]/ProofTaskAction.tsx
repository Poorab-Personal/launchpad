'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { markTaskComplete } from './actions';

const MAX_FILE_SIZE = 3_500_000;

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
  /** When true, must have either an existing proof or at least one newly-picked file before marking complete */
  proofRequired: boolean;
  ctaLabel: string;
}) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pickedFiles, setPickedFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [pendingTransition, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const pending = busy || pendingTransition;
  const canSubmit = !proofRequired || hasExistingProof || pickedFiles.length > 0;
  const buttonDisabled = pending || !canSubmit;

  function addFiles(newFiles: FileList | null) {
    if (!newFiles || newFiles.length === 0) return;
    // Snapshot the FileList to a plain array immediately. We clear the input
    // value below so the user can re-pick the same file later, but clearing
    // also empties the live FileList ref — anything captured into a setState
    // updater would then see zero files. Snapshot up front to avoid that.
    const additions = Array.from(newFiles);
    const oversized = additions.find((f) => f.size > MAX_FILE_SIZE);
    if (oversized) {
      setError(
        `${oversized.name} is ${(oversized.size / 1_000_000).toFixed(1)}MB — max is 3.5MB per file.`,
      );
      return;
    }
    setError(null);
    // Append, dedupe by name+size+lastModified (avoid double-pick of the same file)
    setPickedFiles((prev) => {
      const seen = new Set(prev.map((f) => `${f.name}::${f.size}::${f.lastModified}`));
      const fresh = additions.filter(
        (f) => !seen.has(`${f.name}::${f.size}::${f.lastModified}`),
      );
      return [...prev, ...fresh];
    });
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function removeFile(index: number) {
    setPickedFiles((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit() {
    setError(null);

    if (pickedFiles.length > 0) {
      setBusy(true);
      try {
        const fd = new FormData();
        for (const file of pickedFiles) fd.append('file', file);
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

    // No new files picked → just mark complete (existing proof must already satisfy proofRequired)
    startTransition(async () => {
      const res = await markTaskComplete(taskId, customerId);
      if (!res.ok) {
        setError(res.error);
      } else {
        router.refresh();
      }
    });
  }

  const fileCount = pickedFiles.length;

  return (
    <div className="space-y-2">
      <div>
        <label className="block text-xs uppercase tracking-wide text-[#1B2E35]/60 font-semibold mb-1.5">
          {hasExistingProof
            ? `Add more files${proofRequired ? '' : ' (optional)'}`
            : `Attach proofs${proofRequired ? '' : ' (optional)'}`}
        </label>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,application/pdf"
          multiple
          className="hidden"
          onChange={(e) => addFiles(e.target.files)}
        />

        {fileCount > 0 && (
          <ul className="space-y-1.5 mb-2">
            {pickedFiles.map((f, i) => (
              <li
                key={`${f.name}-${f.size}-${f.lastModified}`}
                className="flex items-center justify-between gap-2 rounded-lg border border-[#6C4AB6]/30 bg-[#6C4AB6]/5 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-[#6C4AB6] truncate">{f.name}</p>
                  <p className="text-[10px] text-[#1B2E35]/50">
                    {(f.size / 1_000_000).toFixed(1)}MB
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => removeFile(i)}
                  className="text-xs text-[#1B2E35]/50 hover:text-[#EC531A]"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="w-full rounded-lg border border-dashed border-[#E0DEE4] bg-white px-3 py-2 text-xs text-[#1B2E35]/60 hover:border-[#6C4AB6]/50 hover:text-[#6C4AB6] transition-colors"
        >
          {fileCount > 0
            ? '+ Add more files'
            : 'Choose files… (PNG, JPG, PDF · max 3.5MB each)'}
        </button>
      </div>

      {proofRequired && !hasExistingProof && fileCount === 0 && (
        <p className="text-xs text-[#1B2E35]/50">
          At least one file must be attached before sending to the customer.
        </p>
      )}

      <button
        type="button"
        disabled={buttonDisabled}
        onClick={handleSubmit}
        className="w-full rounded-full bg-[#05C68E] px-4 py-2 text-sm font-medium text-white hover:bg-[#04946A] disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {pending
          ? fileCount > 0
            ? `Uploading ${fileCount} file${fileCount === 1 ? '' : 's'}…`
            : 'Saving…'
          : fileCount > 0
            ? `Upload ${fileCount} file${fileCount === 1 ? '' : 's'} & ${ctaLabel}`
            : ctaLabel}
      </button>

      {error && <p className="text-sm text-[#EC531A] text-center">{error}</p>}
    </div>
  );
}
