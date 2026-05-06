'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

export default function UploadProofButton({
  customerId,
  taskId,
}: {
  customerId: string;
  taskId: string;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
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
  }

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        accept="image/*,application/pdf"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
        }}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        className="w-full rounded-full bg-[#05C68E] px-4 py-2 text-sm font-medium text-white hover:bg-[#04946A] disabled:opacity-50"
      >
        {busy ? 'Uploading…' : 'Upload Proof + Mark Complete'}
      </button>
      <p className="text-xs text-[#1B2E35]/50 text-center">Max 3.5MB. PNG, JPG, PDF.</p>
      {error && (
        <p className="text-sm text-[#EC531A] text-center">{error}</p>
      )}
    </div>
  );
}
