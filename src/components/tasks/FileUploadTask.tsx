'use client';

import { useState, useCallback } from 'react';
import type { Task } from '@/types';
export default function FileUploadTask({
  task,
  onComplete,
}: {
  task: Task;
  onComplete: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [files, setFiles] = useState<string[]>([]);

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
    const dropped = Array.from(e.dataTransfer.files).map((f) => f.name);
    setFiles((prev) => [...prev, ...dropped]);
  }, []);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const selected = Array.from(e.target.files).map((f) => f.name);
      setFiles((prev) => [...prev, ...selected]);
    }
  }, []);

  async function handleUpload() {
    setLoading(true);
    try {
      await fetch(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'Completed' }),
      });
      onComplete();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      {task.instructions && (
        <p className="text-[#1B2E35]/70 leading-relaxed">{task.instructions}</p>
      )}
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
              accept=".png,.svg,.jpg,.jpeg,.pdf"
              onChange={handleFileSelect}
              className="sr-only"
            />
          </label>
        </p>
        <p className="mt-1.5 text-xs text-[#1B2E35]/40">PNG, SVG, JPG, PDF</p>
      </div>
      {files.length > 0 && (
        <ul className="space-y-1.5">
          {files.map((name, i) => (
            <li key={i} className="flex items-center gap-2 text-sm text-[#1B2E35]/70">
              <svg className="h-4 w-4 shrink-0 text-[#05C68E]" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
              </svg>
              {name}
              <button
                onClick={() => setFiles((prev) => prev.filter((_, idx) => idx !== i))}
                className="ml-auto text-[#1B2E35]/40 hover:text-[#EC531A]"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        onClick={handleUpload}
        disabled={loading || files.length === 0}
        className="inline-flex items-center gap-2 rounded-full bg-[#05C68E] px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#04946A] disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? (
          <>
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
            Uploading…
          </>
        ) : (
          'Upload Files'
        )}
      </button>
    </div>
  );
}
