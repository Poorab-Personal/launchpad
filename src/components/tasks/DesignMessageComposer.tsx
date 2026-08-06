'use client';

import { useEffect, useRef, useState } from 'react';
import { upload } from '@vercel/blob/client';
import type { InternalNoteAttachment } from '@/types';

const MAX_FILE_SIZE = 10_000_000;
const ALLOWED = /^image\//;
const ALLOWED_PDF = 'application/pdf';

type StagedFile = {
  key: string;
  filename: string;
  size: number;
  contentType: string;
  previewUrl: string | null;
  file: File;
};

function fileKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function extFromMime(mime: string): string {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg';
  if (mime === 'image/gif') return 'gif';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'application/pdf') return 'pdf';
  return 'bin';
}

/**
 * Inline "send a note + files" composer shared by the customer portal and the
 * workspace. Uploads attachments directly to Blob via `signUrl`, then hands the
 * assembled body + attachments to `onSubmit` (a fetch on the portal side, a
 * server action on the workspace side). Calls `onSent` on success.
 */
export default function DesignMessageComposer({
  signUrl,
  clientPayload,
  onSubmit,
  onSent,
  placeholder = 'Write a message… (paste screenshots with ⌘+V)',
  sendLabel = 'Send',
}: {
  signUrl: string;
  clientPayload?: string;
  onSubmit: (args: {
    body: string;
    attachments: InternalNoteAttachment[];
  }) => Promise<{ ok: boolean; error?: string }>;
  onSent?: () => void;
  placeholder?: string;
  sendLabel?: string;
}) {
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<StagedFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ uploaded: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const canSubmit = !busy && (body.trim().length > 0 || files.length > 0);

  useEffect(() => {
    return () => {
      files.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function addFiles(input: File[]) {
    const additions: StagedFile[] = [];
    for (const file of input) {
      if (!ALLOWED.test(file.type) && file.type !== ALLOWED_PDF) {
        setError(`${file.name || 'file'} is not an image or PDF.`);
        continue;
      }
      if (file.size > MAX_FILE_SIZE) {
        setError(`${file.name || 'file'} is over the 10MB limit.`);
        continue;
      }
      const img = ALLOWED.test(file.type);
      additions.push({
        key: fileKey(),
        filename: file.name || `attachment.${extFromMime(file.type)}`,
        size: file.size,
        contentType: file.type,
        previewUrl: img ? URL.createObjectURL(file) : null,
        file,
      });
    }
    if (additions.length > 0) {
      setError(null);
      setFiles((prev) => [...prev, ...additions]);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function removeFile(key: string) {
    setFiles((prev) => {
      const target = prev.find((f) => f.key === key);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((f) => f.key !== key);
    });
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const pasted: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file' && ALLOWED.test(item.type)) {
        const blob = item.getAsFile();
        if (blob) {
          const ext = extFromMime(blob.type);
          pasted.push(new File([blob], `pasted-${Date.now()}-${i}.${ext}`, { type: blob.type }));
        }
      }
    }
    if (pasted.length > 0) {
      e.preventDefault();
      addFiles(pasted);
    }
  }

  async function handleSubmit() {
    if (!canSubmit) return;
    setError(null);
    setBusy(true);

    let uploaded: InternalNoteAttachment[] = [];
    if (files.length > 0) {
      setProgress({ uploaded: 0, total: files.length });
      try {
        const results: InternalNoteAttachment[] = [];
        for (const staged of files) {
          const blob = await upload(staged.filename, staged.file, {
            access: 'public',
            handleUploadUrl: signUrl,
            ...(clientPayload ? { clientPayload } : {}),
          });
          results.push({
            url: blob.url,
            filename: staged.filename,
            size: staged.size,
            contentType: staged.contentType,
          });
          setProgress((p) => (p ? { ...p, uploaded: p.uploaded + 1 } : p));
        }
        uploaded = results;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Upload failed.');
        setBusy(false);
        setProgress(null);
        return;
      }
    }

    const res = await onSubmit({ body: body.trim(), attachments: uploaded });
    setBusy(false);
    setProgress(null);
    if (!res.ok) {
      setError(res.error ?? 'Something went wrong. Please try again.');
      return;
    }
    files.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
    setBody('');
    setFiles([]);
    onSent?.();
  }

  return (
    <div className="space-y-2">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onPaste={handlePaste}
        placeholder={placeholder}
        rows={3}
        disabled={busy}
        className="w-full rounded-lg border border-[#E0DEE4] bg-white px-3 py-2 text-sm text-[#1B2E35] placeholder:text-[#1B2E35]/35 focus:outline-none focus:border-[#6C4AB6]/50 disabled:opacity-60"
      />

      {files.length > 0 && (
        <ul className="grid grid-cols-4 gap-2">
          {files.map((f) => (
            <li
              key={f.key}
              className="relative rounded-lg border border-[#E0DEE4] bg-[#F7F4EB] overflow-hidden"
            >
              {f.previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={f.previewUrl} alt={f.filename} className="w-full h-20 object-cover" />
              ) : (
                <div className="h-20 flex items-center justify-center text-[10px] text-[#1B2E35]/60 px-2 text-center">
                  {f.filename}
                </div>
              )}
              <button
                type="button"
                onClick={() => removeFile(f.key)}
                disabled={busy}
                aria-label="Remove file"
                className="absolute top-1 right-1 rounded-full bg-white/90 text-[#1B2E35]/70 hover:text-[#EC531A] w-5 h-5 flex items-center justify-center text-xs"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="text-xs text-[#EC531A]">{error}</p>}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,application/pdf"
        multiple
        className="hidden"
        onChange={(e) => e.target.files && addFiles(Array.from(e.target.files))}
      />
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => fileInputRef.current?.click()}
          className="inline-flex items-center gap-1.5 rounded-full border border-[#E0DEE4] bg-white px-3 py-1.5 text-xs font-medium text-[#1B2E35]/70 hover:border-[#6C4AB6]/40 hover:text-[#6C4AB6] disabled:opacity-40"
        >
          📎 Attach
        </button>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={handleSubmit}
          className="rounded-full bg-[#6C4AB6] px-5 py-1.5 text-sm font-medium text-white hover:bg-[#5A3FA0] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? (progress ? `Uploading ${progress.uploaded}/${progress.total}…` : 'Sending…') : sendLabel}
        </button>
      </div>
    </div>
  );
}
