'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { upload } from '@vercel/blob/client';
import { createInternalNoteAction } from '@/app/workspace/customers/[id]/notes-actions';
import type { InternalNoteAttachment } from '@/types';

type Variant = 'default' | 'small';

const MAX_FILE_SIZE = 10_000_000;
const ALLOWED = /^image\//;
const ALLOWED_PDF = 'application/pdf';

type StagedFile = {
  /** Local id so React can key list items + we can remove pre-upload. */
  key: string;
  filename: string;
  size: number;
  contentType: string;
  /** Object URL for preview (revoked on remove / submit). */
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

export default function AddInternalNoteButton({
  customerId,
  variant = 'default',
}: {
  customerId: string;
  variant?: Variant;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<StagedFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ uploaded: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const submitting = busy || pending;
  const canSubmit = !submitting && (body.trim().length > 0 || files.length > 0);

  // Revoke object URLs on unmount / when files removed
  useEffect(() => {
    return () => {
      files.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Focus the textarea when modal opens
  useEffect(() => {
    if (open) {
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, [open]);

  function resetAndClose() {
    files.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
    setBody('');
    setFiles([]);
    setProgress(null);
    setError(null);
    setOpen(false);
  }

  function addFiles(input: File[]) {
    const additions: StagedFile[] = [];
    for (const file of input) {
      if (!ALLOWED.test(file.type) && file.type !== ALLOWED_PDF) {
        setError(`${file.name || 'file'} is not an image or PDF.`);
        continue;
      }
      if (file.size > MAX_FILE_SIZE) {
        setError(
          `${file.name || 'file'} is ${(file.size / 1_000_000).toFixed(1)}MB — max is 10MB per file.`,
        );
        continue;
      }
      const isImage = ALLOWED.test(file.type);
      additions.push({
        key: fileKey(),
        filename: file.name || `attachment.${extFromMime(file.type)}`,
        size: file.size,
        contentType: file.type,
        previewUrl: isImage ? URL.createObjectURL(file) : null,
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
          const renamed = new File([blob], `pasted-${Date.now()}-${i}.${ext}`, {
            type: blob.type,
          });
          pasted.push(renamed);
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

    let uploaded: InternalNoteAttachment[] = [];
    if (files.length > 0) {
      setBusy(true);
      setProgress({ uploaded: 0, total: files.length });
      try {
        const clientPayload = JSON.stringify({ customerId });
        const results: InternalNoteAttachment[] = [];
        for (const staged of files) {
          const blob = await upload(staged.filename, staged.file, {
            access: 'public',
            handleUploadUrl: '/api/workspace/notes/sign',
            clientPayload,
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
      setBusy(false);
    }

    startTransition(async () => {
      const res = await createInternalNoteAction({
        customerId,
        body,
        attachments: uploaded,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      resetAndClose();
      router.refresh();
    });
  }

  const buttonClass =
    variant === 'small'
      ? 'inline-flex items-center gap-1.5 rounded-full border border-[#E0DEE4] bg-white px-3 py-1 text-xs font-medium text-[#1B2E35]/70 hover:border-[#6C4AB6]/40 hover:text-[#6C4AB6]'
      : 'inline-flex items-center gap-1.5 rounded-full bg-[#6C4AB6] px-4 py-1.5 text-xs font-medium text-white hover:bg-[#5A3FA0]';

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={buttonClass}>
        <span aria-hidden>＋</span> Add internal note
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#1B2E35]/40 p-4"
          onClick={() => !submitting && resetAndClose()}
        >
          <div
            className="w-full max-w-xl rounded-xl bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-[#E0DEE4] px-5 py-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-[#1B2E35]">Add internal note</h3>
              <button
                type="button"
                onClick={resetAndClose}
                disabled={submitting}
                className="text-[#1B2E35]/50 hover:text-[#1B2E35] text-lg leading-none disabled:opacity-40"
                aria-label="Close"
              >
                ×
              </button>
            </div>

            <div className="px-5 py-4 space-y-3">
              <textarea
                ref={textareaRef}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                onPaste={handlePaste}
                placeholder="Notes for the team… (paste screenshots with ⌘+V)"
                rows={5}
                disabled={submitting}
                className="w-full rounded-lg border border-[#E0DEE4] bg-white px-3 py-2 text-sm text-[#1B2E35] placeholder:text-[#1B2E35]/35 focus:outline-none focus:border-[#6C4AB6]/50 disabled:opacity-60"
              />

              {files.length > 0 && (
                <ul className="grid grid-cols-3 gap-2">
                  {files.map((f) => (
                    <li
                      key={f.key}
                      className="relative rounded-lg border border-[#E0DEE4] bg-[#F7F4EB] overflow-hidden"
                    >
                      {f.previewUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={f.previewUrl}
                          alt={f.filename}
                          className="w-full h-24 object-cover"
                        />
                      ) : (
                        <div className="h-24 flex items-center justify-center text-[11px] text-[#1B2E35]/60 px-2 text-center">
                          {f.filename}
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => removeFile(f.key)}
                        disabled={submitting}
                        aria-label="Remove file"
                        className="absolute top-1 right-1 rounded-full bg-white/90 text-[#1B2E35]/70 hover:text-[#EC531A] w-5 h-5 flex items-center justify-center text-xs"
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,application/pdf"
                multiple
                className="hidden"
                onChange={(e) => e.target.files && addFiles(Array.from(e.target.files))}
              />
              <button
                type="button"
                disabled={submitting}
                onClick={() => fileInputRef.current?.click()}
                className="w-full rounded-lg border border-dashed border-[#E0DEE4] bg-white px-3 py-1.5 text-xs text-[#1B2E35]/60 hover:border-[#6C4AB6]/50 hover:text-[#6C4AB6]"
              >
                Attach files (or paste images into the box above)
              </button>

              {error && (
                <p className="text-xs text-[#EC531A]">{error}</p>
              )}
            </div>

            <div className="border-t border-[#E0DEE4] px-5 py-3 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={resetAndClose}
                disabled={submitting}
                className="px-4 py-1.5 text-sm text-[#1B2E35]/70 hover:text-[#1B2E35] disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!canSubmit}
                onClick={handleSubmit}
                className="rounded-full bg-[#6C4AB6] px-4 py-1.5 text-sm font-medium text-white hover:bg-[#5A3FA0] disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {submitting
                  ? progress
                    ? `Uploading ${progress.uploaded}/${progress.total}…`
                    : 'Posting…'
                  : 'Post note'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
