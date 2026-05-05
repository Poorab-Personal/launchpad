'use client';

import { useState, useCallback } from 'react';
import type { Task } from '@/types';

const MAX_FILE_SIZE = 3_500_000; // 3.5MB

export default function FileUploadTask({
  task,
  customerId,
  onComplete,
}: {
  task: Task;
  customerId: string;
  onComplete: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [shareLink, setShareLink] = useState('');
  const [error, setError] = useState('');
  const [uploadStatus, setUploadStatus] = useState<Record<string, 'uploading' | 'done' | 'error'>>({});

  // Detect if this is a video/audio upload task (Voice/Avatar add-ons)
  const isVideo = task.taskName.toLowerCase().includes('video') ||
    task.taskName.toLowerCase().includes('recording') ||
    task.product === 'Voice' || task.product === 'Avatar';

  // Add-on tasks save via share link (too large for upload), Core tasks upload to Airtable
  const isAddonUpload = task.product === 'Voice' || task.product === 'Avatar';

  const acceptFormats = isVideo
    ? '.mp4,.mov,.webm,.m4a,.wav,.mp3'
    : '.png,.svg,.jpg,.jpeg,.pdf';

  const formatLabel = isVideo
    ? 'MP4, MOV, WebM, M4A, WAV, MP3'
    : 'PNG, SVG, JPG, PDF';

  // Determine which Airtable attachment field to write to (Core tasks only)
  function getFieldName(): string {
    const name = task.taskName.toLowerCase();
    if (name.includes('photo') || name.includes('headshot')) return 'Agent Photo';
    if (name.includes('logo')) return 'Business Logo';
    return 'Other Assets';
  }

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const dropped = Array.from(e.dataTransfer.files);
    setFiles((prev) => [...prev, ...dropped]);
    setError('');
  }, []);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const selected = Array.from(e.target.files);
      setFiles((prev) => [...prev, ...selected]);
      setError('');
    }
  }, []);

  const canSubmit = files.length > 0 || shareLink.trim().length > 0;

  function isValidUrl(value: string): boolean {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  async function uploadOne(file: File, fieldName: string): Promise<void> {
    setUploadStatus((prev) => ({ ...prev, [file.name]: 'uploading' }));
    const fd = new FormData();
    fd.append('file', file);
    fd.append('customerId', customerId);
    fd.append('fieldName', fieldName);

    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    if (!res.ok) {
      setUploadStatus((prev) => ({ ...prev, [file.name]: 'error' }));
      const err = await res.json().catch(() => null);
      throw new Error(err?.error || `Failed to upload ${file.name}`);
    }
    setUploadStatus((prev) => ({ ...prev, [file.name]: 'done' }));
  }

  async function handleSubmit() {
    setLoading(true);
    setError('');

    try {
      // Path 1: share link
      if (shareLink.trim()) {
        if (!isValidUrl(shareLink.trim())) {
          setError('Please enter a valid link starting with http:// or https://');
          setLoading(false);
          return;
        }
        const res = await fetch(`/api/tasks/${task.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'Completed', notes: shareLink.trim() }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => null);
          throw new Error(err?.error || 'Failed to save share link');
        }
        onComplete();
        return;
      }

      // Path 2: file upload
      const oversized = files.filter((f) => f.size > MAX_FILE_SIZE);
      if (oversized.length > 0) {
        const names = oversized.map((f) => `"${f.name}" (${(f.size / 1_000_000).toFixed(1)}MB)`).join(', ');
        const msg = isAddonUpload
          ? `${names} ${oversized.length === 1 ? 'is' : 'are'} too large to upload. Please use the share link option below.`
          : `${names} too large. Maximum is 3.5MB per file. Use the share link option for larger files.`;
        setError(msg);
        setLoading(false);
        return;
      }

      // Upload all files in parallel
      const fieldName = getFieldName();
      await Promise.all(files.map((file) => uploadOne(file, fieldName)));

      // Mark task complete
      const res = await fetch(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'Completed' }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw new Error(err?.error || 'Files uploaded, but failed to mark task complete. Please refresh.');
      }
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      {task.instructions && (
        <p className="text-[#1B2E35]/70 leading-relaxed">{task.instructions}</p>
      )}

      {/* File upload zone */}
      {!isAddonUpload && (
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`relative flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
            dragOver
              ? 'border-[#6C4AB6] bg-[#6C4AB6]/5'
              : 'border-[#E0DEE4] hover:border-[#6C4AB6]/50'
          }`}
        >
          <svg className="mb-3 h-10 w-10 text-[#E0DEE4]" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
          </svg>
          <p className="text-sm font-medium text-[#1B2E35]">
            Drag & drop files here, or{' '}
            <label className="cursor-pointer text-[#6C4AB6] underline underline-offset-2">
              browse
              <input
                type="file"
                multiple
                accept={acceptFormats}
                onChange={handleFileSelect}
                className="sr-only"
              />
            </label>
          </p>
          <p className="mt-1.5 text-xs text-[#1B2E35]/40">{formatLabel}</p>
        </div>
      )}

      {/* File list with upload status */}
      {files.length > 0 && (
        <ul className="space-y-1.5">
          {files.map((file, i) => (
            <li key={i} className="flex items-center gap-2 text-sm text-[#1B2E35]/70">
              {uploadStatus[file.name] === 'uploading' ? (
                <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-[#6C4AB6]/30 border-t-[#6C4AB6]" />
              ) : uploadStatus[file.name] === 'done' ? (
                <svg className="h-4 w-4 shrink-0 text-[#05C68E]" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                </svg>
              ) : uploadStatus[file.name] === 'error' ? (
                <svg className="h-4 w-4 shrink-0 text-[#EC531A]" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                </svg>
              ) : (
                <svg className="h-4 w-4 shrink-0 text-[#E0DEE4]" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
                </svg>
              )}
              {file.name}
              <span className="text-xs text-[#1B2E35]/30">({(file.size / 1_000_000).toFixed(1)}MB)</span>
              {!uploadStatus[file.name] && (
                <button
                  onClick={() => setFiles((prev) => prev.filter((_, idx) => idx !== i))}
                  className="ml-auto text-[#1B2E35]/40 hover:text-[#EC531A]"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Share link option */}
      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-[#E0DEE4]" />
        <span className="text-xs text-[#1B2E35]/40">or paste a link</span>
        <div className="h-px flex-1 bg-[#E0DEE4]" />
      </div>

      <div>
        <input
          type="url"
          value={shareLink}
          onChange={(e) => { setShareLink(e.target.value); setError(''); }}
          placeholder="https://drive.google.com/... or Dropbox link"
          className="w-full rounded-lg border border-[#E0DEE4] bg-white px-3 py-2.5 text-sm text-[#1B2E35] placeholder:text-[#1B2E35]/40 focus:border-[#6C4AB6] focus:outline-none focus:ring-2 focus:ring-[#6C4AB6]/20"
        />
        <p className="mt-1.5 text-xs text-[#1B2E35]/40">
          Make sure sharing is set to &quot;Anyone with the link can view&quot;
        </p>
      </div>

      {/* Error message */}
      {error && (
        <div className="rounded-lg border border-[#EC531A]/30 bg-[#EC531A]/5 px-4 py-3 text-sm text-[#EC531A]">
          {error}
        </div>
      )}

      {/* Submit */}
      <button
        onClick={handleSubmit}
        disabled={loading || !canSubmit}
        className="inline-flex items-center gap-2 rounded-full bg-[#05C68E] px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#04946A] disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? (
          <>
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
            Submitting…
          </>
        ) : (
          'Submit'
        )}
      </button>
    </div>
  );
}
