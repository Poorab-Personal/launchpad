'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { upload } from '@vercel/blob/client';
import type { AirtableAttachment } from '@/types';
import { groupDrafts, formatGroupStamp } from './draft-groups';

const MAX_FILE_SIZE = 3_500_000;

/**
 * Action panel button for "Upload Proof to Customer" / "Upload Revised Proof (Round N)" tasks.
 *
 * Opens a modal where Kaushal:
 *  - Sees every Internal Design Drafts attachment as a checkable thumbnail
 *  - Currently-sent items are pre-ticked (typical case on revision: tweak one, keep the rest)
 *  - Can also drop in net-new files
 *  - On Send, the API replaces Customer.Design Proof with (selected drafts + new uploads),
 *    appends the new uploads to Drafts, and marks the task complete
 *
 * Empty Drafts → fall back to plain multi-file upload (no checklist).
 */
export default function SendToCustomerAction({
  customerId,
  taskId,
  taskName,
  ctaLabel,
  drafts,
  currentlySent,
}: {
  customerId: string;
  taskId: string;
  taskName: string;
  ctaLabel: string;
  drafts: AirtableAttachment[];
  currentlySent: AirtableAttachment[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded-full bg-[#05C68E] px-4 py-2 text-sm font-medium text-white hover:bg-[#04946A]"
      >
        {ctaLabel}
      </button>
      {open && (
        <SendModal
          customerId={customerId}
          taskId={taskId}
          taskName={taskName}
          drafts={drafts}
          currentlySent={currentlySent}
          onClose={() => setOpen(false)}
          onSuccess={() => {
            setOpen(false);
            router.refresh();
          }}
        />
      )}
    </>
  );
}

function SendModal({
  customerId,
  taskId,
  taskName,
  drafts,
  currentlySent,
  onClose,
  onSuccess,
}: {
  customerId: string;
  taskId: string;
  taskName: string;
  drafts: AirtableAttachment[];
  currentlySent: AirtableAttachment[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  // Smart pre-tick by task intent:
  //   - "Upload Proof to Customer" (initial send): pre-tick anything currently
  //     in Design Proof (matched by URL). For first sends, designProof is
  //     usually empty so nothing is ticked.
  //   - "Upload Revised Proof (Round N)" (revision send): pre-tick only the
  //     matching round's drafts (uploadTask === 'Revise Design (Round N)').
  //     Avoids the footgun of re-sending the original set the customer just
  //     rejected when the intent is to ship the new revisions.
  //   Designer can still toggle anything off/on; this is just the default.
  const initialSelected = useMemo(() => {
    const revMatch = taskName.match(/^Upload Revised Proof \(Round (\d+)\)$/i);
    if (revMatch) {
      const targetTask = `Revise Design (Round ${revMatch[1]})`;
      return new Set(
        drafts
          .filter((d) => d.id && d.uploadTask === targetTask)
          .map((d) => d.id as string),
      );
    }
    const sentUrls = new Set(currentlySent.map((a) => a.url));
    return new Set(
      drafts.filter((d) => d.id && sentUrls.has(d.url)).map((d) => d.id as string),
    );
  }, [drafts, currentlySent, taskName]);

  const [selected, setSelected] = useState<Set<string>>(initialSelected);
  const [newFiles, setNewFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ uploaded: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Lock body scroll while modal is open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Esc to close
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function addFiles(list: FileList | null) {
    if (!list) return;
    const arr = Array.from(list);
    const oversized = arr.find((f) => f.size > MAX_FILE_SIZE);
    if (oversized) {
      setError(`${oversized.name} is ${(oversized.size / 1_000_000).toFixed(1)}MB — max 3.5MB per file.`);
      return;
    }
    setError(null);
    setNewFiles((prev) => {
      const seen = new Set(prev.map((f) => `${f.name}::${f.size}::${f.lastModified}`));
      const fresh = arr.filter((f) => !seen.has(`${f.name}::${f.size}::${f.lastModified}`));
      return [...prev, ...fresh];
    });
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function removeFile(i: number) {
    setNewFiles((prev) => prev.filter((_, idx) => idx !== i));
  }

  const totalToSend = selected.size + newFiles.length;
  const canSend = totalToSend > 0 && !busy;

  async function handleSend() {
    setError(null);
    setBusy(true);
    setProgress(newFiles.length > 0 ? { uploaded: 0, total: newFiles.length } : null);
    try {
      // Upload net-new files browser → Blob direct (bypasses Vercel's 4.5MB
      // serverless function payload cap). Sequential per-file for accurate
      // progress + isolated failures.
      const clientPayload = JSON.stringify({ taskId, customerId });
      const uploaded: Array<{ url: string; filename: string; size: number; contentType: string }> = [];
      for (const f of newFiles) {
        const blob = await upload(f.name, f, {
          access: 'public',
          handleUploadUrl: '/api/workspace/design-proof/sign',
          clientPayload,
        });
        uploaded.push({ url: blob.url, filename: f.name, size: f.size, contentType: f.type });
        setProgress((p) => (p ? { ...p, uploaded: p.uploaded + 1 } : p));
      }

      // Finalize: persist drafts + curated proof set + mark task complete.
      const res = await fetch('/api/workspace/design-proof', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerId,
          taskId,
          uploaded,
          selectedDraftIds: [...selected],
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? 'Send failed');
      }
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Send failed');
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col">
        <header className="px-6 py-4 border-b border-[#E0DEE4] flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-[#1B2E35]">Send proof to customer</h2>
            <p className="text-xs text-[#1B2E35]/60 mt-0.5">
              Pick which drafts the customer should review. You can also add net-new files.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="text-[#1B2E35]/40 hover:text-[#1B2E35] text-2xl leading-none px-2 disabled:opacity-50"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {drafts.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[#E0DEE4] bg-[#F7F4EB] p-6 text-center text-sm text-[#1B2E35]/60">
              No internal drafts yet — upload the files you want to send to the customer below.
            </div>
          ) : (
            <section className="space-y-5">
              <div className="flex items-center justify-between">
                <h3 className="text-xs uppercase tracking-wide font-semibold text-[#1B2E35]/60">
                  Internal Drafts ({drafts.length})
                </h3>
                <button
                  type="button"
                  onClick={() => {
                    if (selected.size === drafts.length) setSelected(new Set());
                    else setSelected(new Set(drafts.filter((d) => d.id).map((d) => d.id as string)));
                  }}
                  className="text-xs text-[#6C4AB6] hover:underline"
                >
                  {selected.size === drafts.length ? 'Deselect all' : 'Select all'}
                </button>
              </div>
              {groupDrafts(drafts).map((g, gi) => {
                const stamp = formatGroupStamp(g.newestAt);
                const groupIds = g.drafts.filter((d) => d.id).map((d) => d.id as string);
                const groupAllSelected = groupIds.length > 0 && groupIds.every((id) => selected.has(id));
                return (
                  <div key={`g-${gi}`}>
                    <div className="mb-2 flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-[#1B2E35]">{g.label}</span>
                        <span className="text-[#1B2E35]/40">
                          · {g.drafts.length} file{g.drafts.length === 1 ? '' : 's'}
                        </span>
                        {stamp && <span className="text-[#1B2E35]/40">· {stamp}</span>}
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          if (groupAllSelected) {
                            setSelected((prev) => {
                              const next = new Set(prev);
                              for (const id of groupIds) next.delete(id);
                              return next;
                            });
                          } else {
                            setSelected((prev) => {
                              const next = new Set(prev);
                              for (const id of groupIds) next.add(id);
                              return next;
                            });
                          }
                        }}
                        className="text-xs text-[#6C4AB6] hover:underline"
                      >
                        {groupAllSelected ? 'Deselect group' : 'Select group'}
                      </button>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      {g.drafts.map((d) => {
                        if (!d.id) return null;
                        const isPicked = selected.has(d.id);
                        return (
                          <button
                            type="button"
                            key={d.id}
                            onClick={() => toggle(d.id as string)}
                            className={`group relative overflow-hidden rounded-lg border-2 transition-all text-left ${
                              isPicked
                                ? 'border-[#6C4AB6] ring-2 ring-[#6C4AB6]/20'
                                : 'border-[#E0DEE4] hover:border-[#6C4AB6]/40'
                            }`}
                          >
                            <div className="aspect-[4/3] bg-[#F7F4EB] relative">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={d.url}
                                alt={d.filename ?? 'Draft'}
                                className="absolute inset-0 w-full h-full object-contain"
                              />
                              <div
                                className={`absolute top-2 left-2 h-5 w-5 rounded border-2 flex items-center justify-center text-white text-xs ${
                                  isPicked ? 'bg-[#6C4AB6] border-[#6C4AB6]' : 'bg-white/80 border-[#1B2E35]/30'
                                }`}
                              >
                                {isPicked && '✓'}
                              </div>
                            </div>
                            {d.filename && (
                              <div className="px-2 py-1.5 border-t border-[#E0DEE4]">
                                <p className="text-[11px] text-[#1B2E35]/70 truncate">{d.filename}</p>
                              </div>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </section>
          )}

          <section>
            <h3 className="text-xs uppercase tracking-wide font-semibold text-[#1B2E35]/60 mb-3">
              Add net-new files {newFiles.length > 0 && `(${newFiles.length})`}
            </h3>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,application/pdf"
              multiple
              className="hidden"
              onChange={(e) => addFiles(e.target.files)}
            />
            {newFiles.length > 0 && (
              <ul className="space-y-1.5 mb-2">
                {newFiles.map((f, i) => (
                  <li
                    key={`${f.name}-${f.size}-${f.lastModified}`}
                    className="flex items-center justify-between gap-2 rounded-lg border border-[#6C4AB6]/30 bg-[#6C4AB6]/5 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-[#6C4AB6] truncate">{f.name}</p>
                      <p className="text-[10px] text-[#1B2E35]/50">{(f.size / 1_000_000).toFixed(1)}MB</p>
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
              className="w-full rounded-lg border border-dashed border-[#E0DEE4] bg-white px-3 py-2 text-xs text-[#1B2E35]/60 hover:border-[#6C4AB6]/50 hover:text-[#6C4AB6]"
            >
              {newFiles.length > 0 ? '+ Add more files' : 'Choose files… (PNG, JPG, PDF · max 3.5MB each)'}
            </button>
          </section>

          {error && (
            <div className="rounded-lg border border-[#EC531A]/30 bg-[#EC531A]/5 px-4 py-3 text-sm text-[#EC531A]">
              {error}
            </div>
          )}
        </div>

        <footer className="px-6 py-4 border-t border-[#E0DEE4] flex items-center justify-between gap-3">
          <p className="text-xs text-[#1B2E35]/60">
            Sending <span className="font-semibold text-[#1B2E35]">{totalToSend}</span> file{totalToSend === 1 ? '' : 's'} to the customer
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-full border border-[#1B2E35]/20 bg-white px-4 py-2 text-sm font-medium text-[#1B2E35] hover:bg-[#F7F4EB] disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSend}
              disabled={!canSend}
              className="rounded-full bg-[#05C68E] px-5 py-2 text-sm font-semibold text-white hover:bg-[#04946A] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy
                ? progress
                  ? `Uploading ${progress.uploaded} / ${progress.total}…`
                  : 'Sending…'
                : 'Send to customer'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
