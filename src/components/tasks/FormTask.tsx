'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import type { Task, Customer, AirtableAttachment } from '@/types';

// ─── Types ──────────────────────────────────────────────────────────

interface FormData {
  // Step 1 — Your Business
  businessName: string;
  phone: string;
  businessAddress: string;
  website: string;
  licenseNumber: string;
  mlsIds: string;
  gmbName: string;
  zillowProfile: string;

  // Step 2 — You & Your Brand
  bio: string;
  specialInstructions: string;
  otherEmails: string;

  // Step 3 — Content Direction
  serviceAreas: string;
  localContentAreas: string;
  topics: string;
  hashtags: string;

  // Step 4 — Account Access
  platformEmail: string;
}

// A file slot is either an asset already on the customer row (imported to Blob
// at B2B create, persisted) or a newly-picked browser File (not yet uploaded).
type ExistingAsset = { kind: 'existing'; url: string; filename: string };
type PickedFile = { kind: 'file'; file: File };
type FileSlot = ExistingAsset | PickedFile;

interface FileState {
  agentPhoto: FileSlot[];
  businessLogo: FileSlot[];
  otherAssets: FileSlot[];
}

interface StepDef {
  name: string;
  label: string;
}

const STEPS: StepDef[] = [
  { name: 'business', label: 'Your Business' },
  { name: 'brand', label: 'You & Your Brand' },
  { name: 'content', label: 'Content Direction' },
  { name: 'account', label: 'Account Access' },
  { name: 'review', label: 'Review & Submit' },
];

const REQUIRED_FIELDS: Record<number, (keyof FormData)[]> = {
  0: ['businessName', 'phone', 'website', 'mlsIds'],
  1: ['bio'],
  2: ['serviceAreas', 'topics'],
  3: ['platformEmail'],
};

const REQUIRED_FILES: Record<number, (keyof FileState)[]> = {
  1: ['agentPhoto', 'businessLogo'],
};

const MAX_AREAS = 5;
const ACCEPTED_FORMATS = '.png,.svg,.jpg,.jpeg,.pdf';

const REVIEW_SOURCE_LABELS: Record<string, string> = {
  google: 'Google',
  zillow: 'Zillow',
  testimonial_tree: 'Testimonial Tree',
};

function emptyForm(): FormData {
  return {
    businessName: '',
    phone: '',
    businessAddress: '',
    website: '',
    licenseNumber: '',
    mlsIds: '',
    gmbName: '',
    zillowProfile: '',
    bio: '',
    specialInstructions: '',
    otherEmails: '',
    serviceAreas: '',
    localContentAreas: '',
    topics: '',
    hashtags: '',
    platformEmail: '',
  };
}

/**
 * Generate a labeled placeholder PNG (200×200) as a real File. Used by the
 * ?test=fill auto-fill so agentPhoto / businessLogo (required uploads)
 * pass validation without manually picking a file.
 */
function makeStubImage(label: string): File {
  const canvas = document.createElement('canvas');
  canvas.width = 200;
  canvas.height = 200;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return new File([new Uint8Array()], `test-${label.toLowerCase()}.png`, { type: 'image/png' });
  }
  // Random pastel background so the two images look distinct
  const hue = Math.floor(Math.random() * 360);
  ctx.fillStyle = `hsl(${hue}, 60%, 80%)`;
  ctx.fillRect(0, 0, 200, 200);
  ctx.fillStyle = '#1B2E35';
  ctx.font = 'bold 28px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 100, 100);
  ctx.font = '14px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(27, 46, 53, 0.5)';
  ctx.fillText('test', 100, 130);
  // Canvas → blob → File (synchronous via toDataURL + atob)
  const dataUrl = canvas.toDataURL('image/png');
  const binary = atob(dataUrl.split(',')[1]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], `test-${label.toLowerCase()}.png`, { type: 'image/png' });
}

/** Stub data for testing — used by the ?test=fill URL param. */
const TEST_STUB: FormData = {
  businessName: 'Test Realty Group',
  phone: '(555) 123-4567',
  businessAddress: '123 Test Street, Miami, FL 33101',
  website: 'https://testrealty.example.com',
  licenseNumber: 'TEST-12345',
  mlsIds: 'Test MLS — TM00001',
  gmbName: 'Test Realty Group',
  zillowProfile: 'https://www.zillow.com/profile/testrealty',
  bio: 'Miami-based agent specializing in residential real estate. 10+ years experience helping clients find homes across South Florida. Bilingual English/Spanish.',
  specialInstructions: 'Brand should feel modern and approachable. Use coastal-inspired tones.',
  otherEmails: '',
  serviceAreas: 'Miami, Coral Gables, Coconut Grove, Brickell',
  localContentAreas: 'Miami, Coral Gables, Coconut Grove',
  topics: 'First-time buyers, Luxury condos, Investment properties',
  hashtags: '#TestRealty #MiamiHomes #SouthFloridaAgent',
  platformEmail: '',
};

function prefillFromCustomer(customer: Customer): FormData {
  return {
    businessName: customer.businessName || '',
    phone: customer.phone || '',
    businessAddress: customer.businessAddress || '',
    website: customer.website || '',
    licenseNumber: customer.licenseNumber || '',
    mlsIds: customer.mlsIds || '',
    gmbName: customer.gmbName || '',
    zillowProfile: customer.zillowProfile || '',
    bio: customer.bio || '',
    specialInstructions: customer.specialInstructions || '',
    otherEmails: customer.otherEmails || '',
    serviceAreas: customer.serviceAreas || '',
    // Default Neighborhood News to their service areas (often the same) so it's
    // not empty — independent from then on (no runtime mirroring).
    localContentAreas: customer.localContentAreas || customer.serviceAreas || '',
    topics: customer.topics || '',
    hashtags: customer.hashtags || '',
    platformEmail: customer.platformEmail || '',
  };
}

// Seed file slots from assets already on the customer row (B2B: agent photo +
// brokerage logo imported at create). D2C customers have empty asset arrays, so
// this returns empty slots and the required-file check stays in force for them.
function prefillFilesFromCustomer(customer: Customer): FileState {
  const toSlots = (assets: AirtableAttachment[] | undefined): FileSlot[] =>
    (assets ?? [])
      .filter((a) => a && a.url)
      .map((a) => ({ kind: 'existing', url: a.url, filename: a.filename || 'asset' }));
  return {
    agentPhoto: toSlots(customer.agentPhoto),
    businessLogo: toSlots(customer.businessLogo),
    otherAssets: toSlots(customer.otherAssets),
  };
}

// Parse an areas textarea into trimmed, non-empty entries.
// Accepts either newlines or commas as delimiters (or both).
function parseAreas(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter(Boolean);
}

// ─── Sub-components ─────────────────────────────────────────────────

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
    </svg>
  );
}

function StepIndicator({ current, total, steps }: { current: number; total: number; steps: StepDef[] }) {
  return (
    <div className="mb-8">
      <p className="mb-3 text-xs font-medium text-[#1B2E35]/54 uppercase tracking-wide font-[family-name:var(--font-outfit)]">
        Step {current + 1} of {total} — {steps[current].label}
      </p>
      <div className="flex gap-1.5">
        {steps.map((step, i) => (
          <div
            key={step.name}
            className={`h-1.5 flex-1 rounded-full transition-colors ${
              i < current
                ? 'bg-[#05C68E]'
                : i === current
                  ? 'bg-[#6C4AB6]'
                  : 'bg-[#E0DEE4]'
            }`}
            title={step.label}
          />
        ))}
      </div>
    </div>
  );
}

function FieldLabel({ label, required }: { label: string; required?: boolean }) {
  return (
    <label className="block text-sm font-semibold text-[#1B2E35]/87 mb-1">
      {label}
      {required && <span className="text-[#EC531A] ml-0.5">*</span>}
    </label>
  );
}

function HelperText({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 text-xs text-[#1B2E35]/50">{children}</p>;
}

/**
 * Amber "please review" wrapper for fields pre-filled from the brokerage roster
 * that agents commonly skim past (website = broker site, photo, logo). Amber —
 * not red — so it reads as a heads-up, not an error. Only render this around a
 * field when it was actually broker-prefilled (so D2C, which enters from
 * scratch, never sees it).
 */
function ReviewNudge({
  note,
  active = true,
  children,
}: {
  note: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  if (!active) return <div>{children}</div>;
  return (
    <div className="rounded-lg border border-[#E0A93B]/60 bg-[#FBF3E2] px-4 py-3">
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-[#9A6700]">
        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 3v1.5M3 21v-6m0 0 2.77-.693a9 9 0 0 1 6.208.682l.108.054a9 9 0 0 0 6.086.71l3.114-.732a48.524 48.524 0 0 1-.005-10.499l-3.11.732a9 9 0 0 1-6.085-.711l-.108-.054a9 9 0 0 0-6.208-.682L3 4.5M3 15V4.5" />
        </svg>
        Please double-check
      </span>
      <div className="mt-2">{children}</div>
      <p className="mt-2 text-xs font-medium text-[#9A6700]">{note}</p>
    </div>
  );
}

function FilePreview({
  slot,
  onRemove,
  large,
  onEnlarge,
}: {
  slot: FileSlot;
  onRemove?: () => void;
  // Larger preview tile for single-file fields (photo/logo) so they don't read
  // as low quality in a tiny grid cell.
  large?: boolean;
  // Open the full-size image in a lightbox.
  onEnlarge?: (url: string, name: string) => void;
}) {
  const name = slot.kind === 'file' ? slot.file.name : slot.filename;
  // Existing (imported) assets are images in practice — the importer only
  // accepts image/* content types — so render them via <img> unless the name
  // is clearly a PDF. Picked files use their MIME type.
  const isImage =
    slot.kind === 'existing'
      ? !/\.pdf$/i.test(slot.filename)
      : slot.file.type.startsWith('image/');
  // Object URLs MUST be created/revoked in an effect (not useMemo) — strict
  // mode runs effects twice in dev and would revoke the URL while the memo
  // still references it, leaving a broken <img> src. The setState below
  // triggers one extra render, but that's correct and necessary here.
  const [url, setUrl] = useState<string | null>(
    slot.kind === 'existing' ? slot.url : null,
  );
  // Captured from the loaded image — a concrete "this is high-res" signal.
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    if (slot.kind === 'existing') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setUrl(slot.url);
      return;
    }
    if (!slot.file.type.startsWith('image/')) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(slot.file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [slot]);

  const canEnlarge = Boolean(isImage && url && onEnlarge);

  return (
    <div
      className={`relative rounded-lg border border-[#E0DEE4] overflow-hidden bg-white ${large ? 'w-44' : ''}`}
    >
      <div
        className={`${large ? 'h-44' : 'aspect-square'} bg-[#F7F4EB] flex items-center justify-center p-1`}
      >
        {isImage && url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt={name}
            onLoad={(e) => {
              const img = e.currentTarget;
              if (img.naturalWidth) {
                setDims({ w: img.naturalWidth, h: img.naturalHeight });
              }
            }}
            onClick={canEnlarge ? () => onEnlarge!(url!, name) : undefined}
            className={`max-w-full max-h-full object-contain ${canEnlarge ? 'cursor-zoom-in' : ''}`}
          />
        ) : (
          <div className="text-xs font-medium text-[#1B2E35]/50 px-1 text-center">
            {name.split('.').pop()?.toUpperCase() ?? 'FILE'}
          </div>
        )}
      </div>
      <div className="px-1.5 py-1">
        <p className="text-[10px] text-[#1B2E35]/70 truncate" title={name}>
          {name}
        </p>
        {dims && (
          <p className="text-[10px] text-[#1B2E35]/45">
            {dims.w}×{dims.h}
            {canEnlarge ? ' · click to enlarge' : ''}
          </p>
        )}
      </div>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          aria-label={`Remove ${name}`}
          className="absolute top-1 right-1 rounded-full bg-white/95 px-1.5 text-xs leading-5 text-[#1B2E35]/70 hover:text-[#EC531A] shadow-sm"
        >
          ×
        </button>
      )}
    </div>
  );
}

function DropZone({
  label,
  required,
  multiple,
  files,
  onFiles,
  onRemove,
  allowRemoveExisting,
  error,
}: {
  label: string;
  required?: boolean;
  multiple?: boolean;
  files: FileSlot[];
  onFiles: (files: FileList) => void;
  onRemove?: (index: number) => void;
  // When false (default), the remove "×" is hidden on existing (already-imported)
  // assets — a persisted delete isn't supported, so required single-file fields
  // offer replace-only. Picked (not-yet-uploaded) files are always removable.
  allowRemoveExisting?: boolean;
  error?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [lightbox, setLightbox] = useState<{ url: string; name: string } | null>(null);

  const fileList = files;
  // Single-file field that already has an asset → lead with the preview and
  // demote upload to a small "Replace" control instead of a big empty dropzone.
  const filledSingle = !multiple && fileList.length > 0;

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files);
  }

  return (
    <div>
      <FieldLabel label={label} required={required} />
      {/* Hidden input shared by the big dropzone AND the compact Replace button. */}
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        accept={ACCEPTED_FORMATS}
        multiple={multiple}
        onChange={(e) => { if (e.target.files?.length) onFiles(e.target.files); }}
      />

      {filledSingle ? (
        // Already have this asset: preview is the hero, upload shrinks to Replace.
        <div className="flex items-start gap-4">
          {(() => {
            const f = fileList[0];
            const removable =
              onRemove && (f.kind === 'file' || allowRemoveExisting);
            return (
              <FilePreview
                slot={f}
                large
                onEnlarge={(url, name) => setLightbox({ url, name })}
                onRemove={removable ? () => onRemove(0) : undefined}
              />
            );
          })()}
          <div className="flex flex-col items-start gap-1.5 pt-1">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="inline-flex items-center gap-2 rounded-full border border-[#E0DEE4] px-5 py-2.5 text-sm font-medium text-[#1B2E35] transition-colors hover:border-[#6C4AB6]/50 hover:text-[#6C4AB6]"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.6} stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
              </svg>
              Replace
            </button>
            <span className="text-xs text-[#1B2E35]/45">PNG, SVG, JPG · up to 3.5MB</span>
          </div>
        </div>
      ) : (
        <>
          <div
            className={`flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 text-center cursor-pointer transition-colors ${
              error
                ? 'border-[#EC531A] bg-[#EC531A]/5'
                : dragOver
                  ? 'border-[#6C4AB6] bg-[#6C4AB6]/5'
                  : 'border-[#E0DEE4] hover:border-[#6C4AB6]/50'
            }`}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
          >
            <svg className="mb-2 h-8 w-8 text-[#E0DEE4]" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
            </svg>
            <p className="text-sm text-[#1B2E35]/60">
              Drag & drop or <span className="font-medium text-[#1B2E35] underline">browse</span>
            </p>
          </div>
          {error && (
            <p className="mt-1 text-xs text-[#EC531A]">Please upload a file to continue.</p>
          )}
          {fileList.length > 0 && (
            // Multi-file (Other Assets) — compact grid of previews below the dropzone.
            <div className="mt-3 grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-2">
              {fileList.map((f, i) => {
                const removable =
                  onRemove && (f.kind === 'file' || allowRemoveExisting);
                return (
                  <FilePreview
                    key={f.kind === 'existing' ? `e-${f.url}` : `f-${f.file.name}-${i}`}
                    slot={f}
                    onEnlarge={(url, name) => setLightbox({ url, name })}
                    onRemove={removable ? () => onRemove(i) : undefined}
                  />
                );
              })}
            </div>
          )}
        </>
      )}
      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setLightbox(null)}
          role="dialog"
          aria-modal="true"
          aria-label={`Preview: ${lightbox.name}`}
        >
          <div className="relative w-[90vw] max-w-2xl" onClick={(e) => e.stopPropagation()}>
            {/* w-full forces small vector logos to scale UP to fill the box;
                max-h caps tall photos and object-contain letterboxes them. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={lightbox.url}
              alt={lightbox.name}
              className="max-h-[85vh] w-full rounded-lg bg-white object-contain p-3"
            />
            <button
              type="button"
              onClick={() => setLightbox(null)}
              aria-label="Close preview"
              className="absolute -top-3 -right-3 rounded-full bg-white px-2 leading-7 text-lg text-[#1B2E35] shadow-md hover:text-[#EC531A]"
            >
              ×
            </button>
            <p className="mt-2 text-center text-xs text-white/80">{lightbox.name}</p>
          </div>
        </div>
      )}
    </div>
  );
}

function AreasTextarea({
  label,
  required,
  value,
  onChange,
  placeholder,
  helper,
  invalid,
}: {
  label: string;
  required?: boolean;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  helper: string;
  invalid?: boolean;
}) {
  const parsed = parseAreas(value);
  const count = parsed.length;
  // Soft suggestion — never blocks. Rejig caps at MAX_AREAS for best results,
  // but agents can list more and trim later.
  const overSuggested = count > MAX_AREAS;

  return (
    <div>
      <FieldLabel label={label} required={required} />
      {/* Helper above the field (like the Review Sources intro) so the guidance
          is read before typing; the count nudge stays below as feedback. */}
      <p className="mb-1.5 text-xs text-[#1B2E35]/55">{helper}</p>
      <textarea
        rows={5}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`block w-full rounded-lg border bg-white px-3 py-2 text-sm text-[#1B2E35] placeholder:text-[#1B2E35]/40 focus:outline-none focus:ring-2 focus:ring-[#6C4AB6]/20 focus:border-[#6C4AB6] resize-y ${
          invalid ? 'border-[#EC531A]' : 'border-[#E0DEE4]'
        }`}
      />
      {overSuggested && (
        <p className="mt-1 text-xs font-medium text-[#9A6700]">
          You&apos;ve added {count} — we suggest up to {MAX_AREAS} for the best results.
        </p>
      )}
    </div>
  );
}

// ─── Review Section ─────────────────────────────────────────────────

function ReviewSection({
  title,
  stepIndex,
  fields,
  onEdit,
}: {
  title: string;
  stepIndex: number;
  fields: { label: string; value: string }[];
  onEdit: (step: number) => void;
}) {
  const hasContent = fields.some((f) => f.value.trim());
  return (
    <div className="rounded-lg border border-[#E0DEE4] p-4">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-semibold text-[#1B2E35]">{title}</h4>
        <button
          type="button"
          onClick={() => onEdit(stepIndex)}
          className="text-xs font-medium text-[#6C4AB6] hover:text-[#6C4AB6]/80 transition-colors"
        >
          Edit
        </button>
      </div>
      {hasContent ? (
        <dl className="space-y-1.5">
          {fields.filter((f) => f.value.trim()).map((f) => (
            <div key={f.label} className="flex gap-2 text-sm">
              <dt className="shrink-0 text-[#1B2E35]/50 w-36">{f.label}</dt>
              <dd className="text-[#1B2E35] whitespace-pre-wrap break-words">{f.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-sm text-[#1B2E35]/40 italic">No information entered</p>
      )}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────

export default function FormTask({
  task,
  onComplete,
  customerId,
  customer,
}: {
  task: Task;
  onComplete: () => void;
  customerId: string;
  customer?: Customer;
}) {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<FormData>(
    customer ? prefillFromCustomer(customer) : emptyForm,
  );
  // Hydrate file slots from existing customer assets once. Kept in a ref too so
  // removing a replacement on a single-file field can revert to the original
  // imported asset (or empty for D2C, which has none).
  const initialFilesRef = useRef<FileState | null>(null);
  if (initialFilesRef.current === null) {
    initialFilesRef.current = customer
      ? prefillFilesFromCustomer(customer)
      : { agentPhoto: [], businessLogo: [], otherAssets: [] };
  }
  const [files, setFiles] = useState<FileState>(initialFilesRef.current);
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // "Please double-check" nudges show ONLY for B2B (the only path where we
  // pre-fill from the brokerage roster) AND only when the field actually carries
  // a broker-provided value. D2C enters from scratch → never B2B-typed here →
  // never sees any nudge. (Gating on type, not just value, matters for website:
  // an admin-created D2C customer could have a website but no brokerage.)
  const isB2B = customer?.type === 'B2B';
  const websitePrefilled = isB2B && Boolean(customer?.website);
  const photoPrefilled = isB2B && (customer?.agentPhoto?.length ?? 0) > 0;
  const brokerLogoPresent = isB2B && (customer?.businessLogo?.length ?? 0) > 0;

  // Review-source multi-select — its own state (not part of `form`). Seed from
  // the saved set, and auto-include a platform when its identifier is already on
  // file so a prefilled value surfaces under its checkbox.
  const [reviewSources, setReviewSources] = useState<string[]>(() => {
    const seed = new Set(customer?.reviewSources ?? []);
    if (customer?.gmbName) seed.add('google');
    if (customer?.zillowProfile) seed.add('zillow');
    return [...seed];
  });
  const toggleSource = useCallback((src: string) => {
    setReviewSources((prev) =>
      prev.includes(src) ? prev.filter((s) => s !== src) : [...prev, src],
    );
  }, []);

  // Dev-only: ?test=fill on the portal URL exposes an "Auto-fill" button
  // that populates all form fields with stub data. Real customers won't
  // know the param exists.
  const searchParams = useSearchParams();
  const testFillEnabled = searchParams?.get('test') === 'fill';
  const handleAutoFill = useCallback(() => {
    // Use the customer's actual contact email for platformEmail so it passes
    // the "real email" validation (the stub email isn't deliverable)
    setForm({
      ...TEST_STUB,
      platformEmail: customer?.contactEmail || TEST_STUB.platformEmail,
    });
    setTouched(new Set(Object.keys(TEST_STUB)));
    setFiles({
      agentPhoto: [{ kind: 'file', file: makeStubImage('Agent') }],
      businessLogo: [{ kind: 'file', file: makeStubImage('Logo') }],
      otherAssets: [],
    });
    setReviewSources(['google', 'zillow', 'testimonial_tree']);
    // Jump to last step so the user can submit immediately
    setStep(STEPS.length - 1);
  }, [customer]);

  const update = useCallback((field: keyof FormData, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setTouched((prev) => new Set(prev).add(field));
  }, []);

  // ── Feedback Form (simple rating + comments) ──
  const isFeedbackForm = task.taskName.toLowerCase().includes('feedback');
  const [rating, setRating] = useState(0);
  const [comments, setComments] = useState('');

  if (isFeedbackForm) {
    async function handleFeedbackSubmit() {
      if (rating === 0) return;
      setSubmitting(true);
      setError(null);
      try {
        await fetch(`/api/customers/${customerId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            feedbackRating: rating,
            ...(comments.trim() ? { feedbackComments: comments.trim() } : {}),
          }),
        });
        await fetch(`/api/tasks/${task.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'Completed' }),
        });
        onComplete();
      } catch {
        setError('Something went wrong. Please try again.');
      } finally {
        setSubmitting(false);
      }
    }

    return (
      <div className="space-y-6">
        {task.instructions && (
          <p className="text-[#1B2E35]/70 leading-relaxed">{task.instructions}</p>
        )}

        {/* Star rating */}
        <div>
          <p className="text-sm font-semibold text-[#1B2E35]/87 mb-2">How was your onboarding experience?</p>
          <div className="flex gap-1">
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                key={star}
                type="button"
                onClick={() => setRating(star)}
                className="p-1 transition-transform hover:scale-110"
              >
                <svg
                  className={`h-8 w-8 ${star <= rating ? 'text-[#DABA21] fill-[#DABA21]' : 'text-[#E0DEE4] hover:text-[#DABA21]/50'}`}
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                  stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 0 1 1.04 0l2.125 5.111a.563.563 0 0 0 .475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 0 0-.182.557l1.285 5.385a.562.562 0 0 1-.84.61l-4.725-2.885a.562.562 0 0 0-.586 0L6.982 20.54a.562.562 0 0 1-.84-.61l1.285-5.386a.562.562 0 0 0-.182-.557l-4.204-3.602a.562.562 0 0 1 .321-.988l5.518-.442a.563.563 0 0 0 .475-.345L11.48 3.5Z" />
                </svg>
              </button>
            ))}
          </div>
        </div>

        {/* Comments */}
        <div>
          <label className="block text-sm font-semibold text-[#1B2E35]/87 mb-1">
            Any comments? <span className="font-normal text-[#1B2E35]/40">(optional)</span>
          </label>
          <textarea
            value={comments}
            onChange={(e) => setComments(e.target.value)}
            placeholder="Tell us what went well or what could be improved..."
            rows={4}
            className="w-full rounded-lg border border-[#E0DEE4] bg-white px-3 py-2 text-sm text-[#1B2E35] placeholder:text-[#1B2E35]/40 focus:border-[#6C4AB6] focus:outline-none focus:ring-2 focus:ring-[#6C4AB6]/20"
          />
        </div>

        {error && (
          <div className="rounded-lg border border-[#EC531A]/30 bg-[#EC531A]/5 px-4 py-3 text-sm text-[#EC531A]">
            {error}
          </div>
        )}

        <button
          onClick={handleFeedbackSubmit}
          disabled={submitting || rating === 0}
          className="inline-flex items-center gap-2 rounded-full bg-[#05C68E] px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#04946A] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? (
            <>
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
              Submitting…
            </>
          ) : (
            'Submit Feedback'
          )}
        </button>
      </div>
    );
  }

  // ── Helpers ──

  function isInvalid(field: keyof FormData) {
    return touched.has(field) && isRequired(field) && !form[field].trim();
  }

  function isRequired(field: keyof FormData) {
    for (const fields of Object.values(REQUIRED_FIELDS)) {
      if (fields.includes(field)) return true;
    }
    return false;
  }

  function inputClass(field: keyof FormData) {
    return `block w-full rounded-lg border bg-white px-3 py-2 text-sm text-[#1B2E35] placeholder:text-[#1B2E35]/40 focus:outline-none focus:ring-2 focus:ring-[#6C4AB6]/20 focus:border-[#6C4AB6] ${
      isInvalid(field) ? 'border-[#EC531A]' : 'border-[#E0DEE4]'
    }`;
  }

  function textareaClass(field: keyof FormData) {
    return `${inputClass(field)} resize-y`;
  }

  function isFileMissing(file: keyof FileState): boolean {
    return files[file].length === 0;
  }

  // ── Navigation ──

  function handleNext() {
    // Required text fields for current step
    const required = REQUIRED_FIELDS[step];
    if (required) {
      setTouched((prev) => {
        const next = new Set(prev);
        for (const f of required) next.add(f);
        return next;
      });
      if (required.some((f) => !form[f].trim())) return;
    }

    // Required files for current step
    const requiredFiles = REQUIRED_FILES[step];
    if (requiredFiles) {
      setTouched((prev) => {
        const next = new Set(prev);
        for (const f of requiredFiles) next.add(`file:${f}`);
        return next;
      });
      if (requiredFiles.some(isFileMissing)) return;
    }

    // Area counts are a soft suggestion now — no hard block, and Neighborhood
    // News is its own list (defaulted at prefill), not auto-mirrored from
    // Market Reports — so the two are clearly meant to differ.

    const nextStep = Math.min(step + 1, STEPS.length - 1);
    setStep(nextStep);
  }

  function handleBack() {
    setStep((s) => Math.max(s - 1, 0));
  }

  // ── Submit ──

  async function handleSubmit() {
    // Re-check ALL required text fields
    const allRequired = Object.values(REQUIRED_FIELDS).flat();
    const missingText = allRequired.filter((f) => !form[f].trim());
    // Re-check ALL required files
    const allRequiredFiles = Object.values(REQUIRED_FILES).flat();
    const missingFiles = allRequiredFiles.filter(isFileMissing);

    if (missingText.length || missingFiles.length) {
      setTouched((prev) => {
        const next = new Set(prev);
        for (const f of missingText) next.add(f);
        for (const f of missingFiles) next.add(`file:${f}`);
        return next;
      });
      setError('Please fix the highlighted fields before submitting.');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const uploadFile = async (file: File, fieldName: string) => {
        if (file.size > 3_500_000) {
          throw new Error(`"${file.name}" is too large (${(file.size / 1_000_000).toFixed(1)}MB). Maximum is 3.5MB.`);
        }
        const fd = new FormData();
        fd.append('file', file);
        fd.append('customerId', customerId);
        fd.append('fieldName', fieldName);
        const res = await fetch('/api/upload', { method: 'POST', body: fd });
        if (!res.ok) {
          const err = await res.json().catch(() => null);
          throw new Error(err?.error || `Failed to upload ${file.name}`);
        }
      };

      // Only upload newly-picked files. Existing (already-imported) assets are
      // already in Blob + on the customer row, so skip them.
      for (const slot of files.agentPhoto) {
        if (slot.kind === 'file') await uploadFile(slot.file, 'Agent Photo');
      }
      for (const slot of files.businessLogo) {
        if (slot.kind === 'file') await uploadFile(slot.file, 'Business Logo');
      }
      for (const slot of files.otherAssets) {
        if (slot.kind === 'file') await uploadFile(slot.file, 'Other Assets');
      }

      // Build payload — normalize area textareas to comma-separated, trim everything
      const payload: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(form)) {
        // gmbName / zillowProfile are review-source identifiers — handled below,
        // gated on the source being selected (not by the generic non-empty rule).
        if (key === 'gmbName' || key === 'zillowProfile') continue;
        if (key === 'serviceAreas' || key === 'localContentAreas') {
          const parsed = parseAreas(value);
          if (parsed.length) payload[key] = parsed.join(', ');
        } else if (value.trim()) {
          payload[key] = value.trim();
        }
      }

      // Review sources (own state) + identifiers, sent only when selected.
      payload.reviewSources = reviewSources;
      if (reviewSources.includes('google') && form.gmbName.trim()) {
        payload.gmbName = form.gmbName.trim();
      }
      if (reviewSources.includes('zillow') && form.zillowProfile.trim()) {
        payload.zillowProfile = form.zillowProfile.trim();
      }

      const custRes = await fetch(`/api/customers/${customerId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!custRes.ok) {
        const err = await custRes.json().catch(() => null);
        throw new Error(err?.error || 'Failed to save your information');
      }

      const taskRes = await fetch(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'Completed' }),
      });

      if (!taskRes.ok) {
        throw new Error('Failed to mark task as complete');
      }

      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  // ─── Step Renders ─────────────────────────────────────────────────

  function renderStep() {
    switch (step) {
      // Step 1 — Your Business
      case 0:
        return (
          <div className="space-y-4">
            <div>
              <FieldLabel label="Business Name" required />
              <input
                type="text"
                className={inputClass('businessName')}
                placeholder="Your business or team name"
                value={form.businessName}
                onChange={(e) => update('businessName', e.target.value)}
              />
            </div>
            <div>
              <FieldLabel label="Phone" required />
              <input
                type="tel"
                className={inputClass('phone')}
                placeholder="(555) 123-4567"
                value={form.phone}
                onChange={(e) => update('phone', e.target.value)}
              />
            </div>
            <div>
              <FieldLabel label="Business Address" />
              <textarea
                className={textareaClass('businessAddress')}
                rows={2}
                placeholder="Office or mailing address"
                value={form.businessAddress}
                onChange={(e) => update('businessAddress', e.target.value)}
              />
            </div>
            <ReviewNudge
              active={websitePrefilled}
              note="This is your brokerage's website. If you have your own site, replace it here."
            >
              <FieldLabel label="Website" required />
              <input
                type="url"
                className={inputClass('website')}
                placeholder="https://yoursite.com"
                value={form.website}
                onChange={(e) => update('website', e.target.value)}
              />
            </ReviewNudge>
            <div>
              <FieldLabel label="License Number" />
              <input
                type="text"
                className={inputClass('licenseNumber')}
                placeholder="Real estate license number"
                value={form.licenseNumber}
                onChange={(e) => update('licenseNumber', e.target.value)}
              />
            </div>
            <div>
              <FieldLabel label="MLS Name & ID" required />
              <input
                type="text"
                className={inputClass('mlsIds')}
                placeholder="e.g., Miami MLS — 12345"
                value={form.mlsIds}
                onChange={(e) => update('mlsIds', e.target.value)}
              />
              <HelperText>Enter both the MLS name and your ID. If you have more than one, list each.</HelperText>
            </div>
          </div>
        );

      // Step 2 — You & Your Brand
      case 1:
        return (
          <div className="space-y-5">
            <div>
              <FieldLabel label="Bio" required />
              <textarea
                className={textareaClass('bio')}
                rows={6}
                placeholder="Tell us about yourself — your experience, specialties, and what makes you unique"
                value={form.bio}
                onChange={(e) => update('bio', e.target.value)}
              />
            </div>
            <ReviewNudge
              active={photoPrefilled}
              note="This is the photo we have on file. Upload a different one if you'd prefer."
            >
              <DropZone
                label="Agent Photo"
                required
                files={files.agentPhoto}
                onFiles={(fl) => {
                  // Single-file field — latest pick replaces (an existing imported
                  // asset too). Browsing twice ends up with one file, not two.
                  const arr = Array.from(fl).map((file) => ({ kind: 'file' as const, file }));
                  setFiles((prev) => ({ ...prev, agentPhoto: arr.slice(-1) }));
                  setTouched((prev) => new Set(prev).add('file:agentPhoto'));
                }}
                onRemove={() =>
                  // Removing a replacement reverts to the original imported asset
                  // (or empty for D2C, which had none → required re-applies).
                  setFiles((prev) => ({ ...prev, agentPhoto: initialFilesRef.current!.agentPhoto }))
                }
                error={touched.has('file:agentPhoto') && files.agentPhoto.length === 0}
              />
            </ReviewNudge>
            <DropZone
              label="Business Logo"
              required
              files={files.businessLogo}
              onFiles={(fl) => {
                // Single-file field — latest pick replaces.
                const arr = Array.from(fl).map((file) => ({ kind: 'file' as const, file }));
                setFiles((prev) => ({ ...prev, businessLogo: arr.slice(-1) }));
                setTouched((prev) => new Set(prev).add('file:businessLogo'));
              }}
              onRemove={() =>
                setFiles((prev) => ({ ...prev, businessLogo: initialFilesRef.current!.businessLogo }))
              }
              error={touched.has('file:businessLogo') && files.businessLogo.length === 0}
            />
            <ReviewNudge
              active={brokerLogoPresent}
              note="Have your own or a team logo to use alongside the brokerage logo above? Upload it here."
            >
              <DropZone
                label="Other Brand Assets"
                multiple
                files={files.otherAssets}
                onFiles={(fl) =>
                  setFiles((prev) => {
                    // Dedup picked files by identity (name+size+lastModified) so the
                    // customer can't accidentally double-add the same file.
                    const seen = new Set(
                      prev.otherAssets
                        .filter((s): s is PickedFile => s.kind === 'file')
                        .map((s) => `${s.file.name}::${s.file.size}::${s.file.lastModified}`),
                    );
                    const fresh = Array.from(fl)
                      .filter((f) => !seen.has(`${f.name}::${f.size}::${f.lastModified}`))
                      .map((file) => ({ kind: 'file' as const, file }));
                    return { ...prev, otherAssets: [...prev.otherAssets, ...fresh] };
                  })
                }
                onRemove={(i) =>
                  setFiles((prev) => ({
                    ...prev,
                    otherAssets: prev.otherAssets.filter((_, idx) => idx !== i),
                  }))
                }
              />
            </ReviewNudge>
            <p className="text-xs text-[#1B2E35]/40">
              Accepted formats: PNG, SVG, JPG, PDF
            </p>
            <div>
              <FieldLabel label="Special Instructions for Design" />
              <textarea
                className={textareaClass('specialInstructions')}
                rows={3}
                placeholder="Notes for our design team — color preferences, style, etc."
                value={form.specialInstructions}
                onChange={(e) => update('specialInstructions', e.target.value)}
              />
            </div>
            {/* "CC'd on design proofs" only applies to D2C — B2B has no design
                proof/approval workflow (design is team-created, never sent for
                approval), so hide this field for B2B. */}
            {!isB2B && (
              <div>
                <FieldLabel label="Other Emails" />
                <input
                  type="text"
                  className={inputClass('otherEmails')}
                  placeholder="comma-separated"
                  value={form.otherEmails}
                  onChange={(e) => update('otherEmails', e.target.value)}
                />
                <HelperText>Anyone else who should be CC&apos;d on design proofs.</HelperText>
              </div>
            )}
          </div>
        );

      // Step 3 — Content Direction
      case 2:
        return (
          <div className="space-y-5">
            <AreasTextarea
              label="Monthly Market Reports"
              required
              value={form.serviceAreas}
              onChange={(v) => update('serviceAreas', v)}
              placeholder={'One per line\ne.g.\nBrickell\nCoral Gables\nCoconut Grove'}
              helper="Choose up to 5 counties, cities, or neighborhoods you'd like monthly AI market reports for. These can be smaller, specific neighborhoods."
              invalid={isInvalid('serviceAreas')}
            />
            <AreasTextarea
              label="Neighborhood News"
              value={form.localContentAreas}
              onChange={(v) => update('localContentAreas', v)}
              placeholder={'One per line\ne.g.\nMiami\nFort Lauderdale'}
              helper="Choose up to 5 areas for AI to curate local news posts. Tip: broader, higher-population areas (cities or counties) give richer content."
            />
            <div>
              <FieldLabel label="Topics" required />
              <p className="mb-1.5 text-xs text-[#1B2E35]/55">
                Our AI curates and creates content for you based on these topics of interest — and we&apos;ll also draw topics from your bio.
              </p>
              <textarea
                className={textareaClass('topics')}
                rows={3}
                placeholder="e.g., Luxury Real Estate, Market Updates, First-Time Buyers"
                value={form.topics}
                onChange={(e) => update('topics', e.target.value)}
              />
            </div>
            <div>
              <FieldLabel label="Hashtags" />
              <input
                type="text"
                className={inputClass('hashtags')}
                placeholder="#MiamiRealEstate #LuxuryLiving"
                value={form.hashtags}
                onChange={(e) => update('hashtags', e.target.value)}
              />
            </div>

            <div className="border-t border-[#E0DEE4] pt-5">
              <h3 className="text-sm font-semibold text-[#1B2E35]/87">Review Sources</h3>
              <p className="mt-1 mb-1.5 text-xs text-[#1B2E35]/55">
                Where do you collect client reviews? Rejig can automatically pull
                these and turn new reviews into posts.
              </p>
              <div className="mt-3 space-y-2">
                {[
                  { id: 'google', label: 'Google' },
                  { id: 'zillow', label: 'Zillow' },
                  { id: 'testimonial_tree', label: 'Testimonial Tree' },
                ].map((src) => (
                  <label
                    key={src.id}
                    className="flex cursor-pointer items-center gap-2.5 text-sm text-[#1B2E35]"
                  >
                    <input
                      type="checkbox"
                      checked={reviewSources.includes(src.id)}
                      onChange={() => toggleSource(src.id)}
                      className="h-4 w-4 rounded border-[#E0DEE4] text-[#6C4AB6] focus:ring-[#6C4AB6]/30"
                    />
                    {src.label}
                  </label>
                ))}
              </div>
              {reviewSources.includes('google') && (
                <div className="mt-4">
                  <FieldLabel label="Google My Business Name" />
                  <p className="mb-1.5 text-xs text-[#1B2E35]/55">
                    The name as it appears on Google — we&apos;ll find your reviews from it.
                  </p>
                  <input
                    type="text"
                    className={inputClass('gmbName')}
                    placeholder="Name as it appears on Google"
                    value={form.gmbName}
                    onChange={(e) => update('gmbName', e.target.value)}
                  />
                </div>
              )}
              {reviewSources.includes('zillow') && (
                <div className="mt-4">
                  <FieldLabel label="Zillow profile (URL or your name on Zillow)" />
                  <p className="mb-1.5 text-xs text-[#1B2E35]/55">
                    Optional — if you&apos;re not sure, leave it blank and we&apos;ll find it.
                  </p>
                  <input
                    type="text"
                    className={inputClass('zillowProfile')}
                    placeholder="Paste your Zillow profile link, or your name on Zillow"
                    value={form.zillowProfile}
                    onChange={(e) => update('zillowProfile', e.target.value)}
                  />
                </div>
              )}
            </div>
          </div>
        );

      // Step 4 — Account Access
      case 3:
        return (
          <div className="space-y-4">
            <div>
              <FieldLabel
                label="What email should we use to log in to your Rejig account?"
                required
              />
              <input
                type="email"
                className={inputClass('platformEmail')}
                placeholder="you@example.com"
                value={form.platformEmail}
                onChange={(e) => update('platformEmail', e.target.value)}
              />
              <HelperText>
                This is the email you&apos;ll use to sign in at app.rejig.ai. We&apos;ll also send a notification here whenever new content is published to your account.
              </HelperText>
            </div>
          </div>
        );

      // Step 5 — Review & Submit
      case 4:
        return (
          <div className="space-y-4">
            <ReviewSection
              title="Your Business"
              stepIndex={0}
              onEdit={setStep}
              fields={[
                { label: 'Business Name', value: form.businessName },
                { label: 'Phone', value: form.phone },
                { label: 'Business Address', value: form.businessAddress },
                { label: 'Website', value: form.website },
                { label: 'License Number', value: form.licenseNumber },
                { label: 'MLS Name & ID', value: form.mlsIds },
              ]}
            />
            <ReviewSection
              title="You & Your Brand"
              stepIndex={1}
              onEdit={setStep}
              fields={[
                { label: 'Bio', value: form.bio },
                { label: 'Special Instructions', value: form.specialInstructions },
                // Hidden for B2B (no design-proof workflow); empty → row hidden.
                { label: 'Other Emails', value: isB2B ? '' : form.otherEmails },
              ]}
            />
            <div className="rounded-lg border border-[#E0DEE4] p-4">
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-sm font-semibold text-[#1B2E35]">Brand Assets</h4>
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  className="text-xs font-medium text-[#6C4AB6] hover:text-[#6C4AB6]/80 transition-colors"
                >
                  Edit
                </button>
              </div>
              {files.agentPhoto.length > 0 || files.businessLogo.length > 0 || files.otherAssets.length > 0 ? (
                <ul className="space-y-1 text-sm text-[#1B2E35]">
                  {files.agentPhoto.map((f, i) => (
                    <li key={`p-${i}`} className="flex items-center gap-2">
                      <CheckIcon className="h-3.5 w-3.5 text-[#05C68E] shrink-0" />
                      Agent Photo: {f.kind === 'file' ? f.file.name : f.filename}
                    </li>
                  ))}
                  {files.businessLogo.map((f, i) => (
                    <li key={`l-${i}`} className="flex items-center gap-2">
                      <CheckIcon className="h-3.5 w-3.5 text-[#05C68E] shrink-0" />
                      Business Logo: {f.kind === 'file' ? f.file.name : f.filename}
                    </li>
                  ))}
                  {files.otherAssets.map((f, i) => (
                    <li key={`o-${i}`} className="flex items-center gap-2">
                      <CheckIcon className="h-3.5 w-3.5 text-[#05C68E] shrink-0" />
                      {f.kind === 'file' ? f.file.name : f.filename}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-[#1B2E35]/40 italic">No files selected</p>
              )}
            </div>
            <ReviewSection
              title="Content Direction"
              stepIndex={2}
              onEdit={setStep}
              fields={[
                { label: 'Monthly Market Reports', value: form.serviceAreas },
                { label: 'Neighborhood News', value: form.localContentAreas },
                { label: 'Topics', value: form.topics },
                { label: 'Hashtags', value: form.hashtags },
              ]}
            />
            <ReviewSection
              title="Review Sources"
              stepIndex={2}
              onEdit={setStep}
              fields={[
                {
                  label: 'Sources',
                  value: reviewSources
                    .map((s) => REVIEW_SOURCE_LABELS[s] ?? s)
                    .join(', '),
                },
                {
                  label: 'Google Business Name',
                  value: reviewSources.includes('google') ? form.gmbName : '',
                },
                {
                  label: 'Zillow',
                  value: reviewSources.includes('zillow') ? form.zillowProfile : '',
                },
              ]}
            />
            <ReviewSection
              title="Account Access"
              stepIndex={3}
              onEdit={setStep}
              fields={[
                { label: 'Account Email', value: form.platformEmail },
              ]}
            />

            {error && (
              <div className="rounded-lg border border-[#EC531A]/30 bg-[#EC531A]/5 px-4 py-3 text-sm text-[#EC531A]">
                {error}
              </div>
            )}
          </div>
        );
    }
  }

  // ─── Render ───────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      {task.instructions && (
        <p className="text-[#1B2E35]/70 leading-relaxed">{task.instructions}</p>
      )}

      {testFillEnabled && (
        <div className="flex items-center justify-between rounded-lg border border-dashed border-[#6C4AB6]/40 bg-[#6C4AB6]/5 px-4 py-2 text-xs">
          <span className="text-[#6C4AB6]">Test mode — fill all fields with stub data?</span>
          <button
            type="button"
            onClick={handleAutoFill}
            className="rounded-full bg-[#6C4AB6] px-3 py-1 font-medium text-white hover:bg-[#5A3DA5]"
          >
            Auto-fill
          </button>
        </div>
      )}

      <StepIndicator current={step} total={STEPS.length} steps={STEPS} />

      {renderStep()}

      {/* Navigation */}
      <div className="flex items-center justify-between pt-4 border-t border-[#E0DEE4]">
        <button
          type="button"
          onClick={handleBack}
          className={`inline-flex items-center gap-2 rounded-full border border-[#1B2E35]/20 bg-white px-5 py-2.5 text-sm font-medium text-[#1B2E35] transition-colors hover:bg-[#F7F4EB] ${
            step === 0 ? 'invisible' : ''
          }`}
        >
          Back
        </button>

        {step < STEPS.length - 1 ? (
          <button
            type="button"
            onClick={handleNext}
            className="inline-flex items-center gap-2 rounded-full bg-[#05C68E] px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#04946A]"
          >
            Next
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="inline-flex items-center gap-2 rounded-full bg-[#05C68E] px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#04946A] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? (
              <>
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                Submitting…
              </>
            ) : (
              'Submit'
            )}
          </button>
        )}
      </div>
    </div>
  );
}
