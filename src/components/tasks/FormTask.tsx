'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import type { Task, Customer } from '@/types';

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

interface FileState {
  agentPhoto: File[];
  businessLogo: File[];
  otherAssets: File[];
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

function emptyForm(): FormData {
  return {
    businessName: '',
    phone: '',
    businessAddress: '',
    website: '',
    licenseNumber: '',
    mlsIds: '',
    gmbName: '',
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

function prefillFromCustomer(customer: Customer): FormData {
  return {
    businessName: customer.businessName || '',
    phone: customer.phone || '',
    businessAddress: customer.businessAddress || '',
    website: customer.website || '',
    licenseNumber: customer.licenseNumber || '',
    mlsIds: customer.mlsIds || '',
    gmbName: customer.gmbName || '',
    bio: customer.bio || '',
    specialInstructions: customer.specialInstructions || '',
    otherEmails: customer.otherEmails || '',
    serviceAreas: customer.serviceAreas || '',
    localContentAreas: customer.localContentAreas || '',
    topics: customer.topics || '',
    hashtags: customer.hashtags || '',
    platformEmail: customer.platformEmail || '',
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

function FilePreview({ file, onRemove }: { file: File; onRemove?: () => void }) {
  const isImage = file.type.startsWith('image/');
  // Object URLs MUST be created/revoked in an effect (not useMemo) — strict
  // mode runs effects twice in dev and would revoke the URL while the memo
  // still references it, leaving a broken <img> src. The setState below
  // triggers one extra render, but that's correct and necessary here.
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!isImage) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file, isImage]);

  return (
    <div className="relative rounded-lg border border-[#E0DEE4] overflow-hidden bg-white">
      <div className="aspect-square bg-[#F7F4EB] flex items-center justify-center p-1">
        {isImage && url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt={file.name}
            className="max-w-full max-h-full object-contain"
          />
        ) : (
          <div className="text-xs font-medium text-[#1B2E35]/50 px-1 text-center">
            {file.name.split('.').pop()?.toUpperCase() ?? 'FILE'}
          </div>
        )}
      </div>
      <p className="text-[10px] text-[#1B2E35]/70 px-1.5 py-1 truncate" title={file.name}>
        {file.name}
      </p>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          aria-label={`Remove ${file.name}`}
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
  error,
}: {
  label: string;
  required?: boolean;
  multiple?: boolean;
  files: File[];
  onFiles: (files: FileList) => void;
  onRemove?: (index: number) => void;
  error?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const fileList = files;

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files);
  }

  return (
    <div>
      <FieldLabel label={label} required={required} />
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
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          accept={ACCEPTED_FORMATS}
          multiple={multiple}
          onChange={(e) => { if (e.target.files?.length) onFiles(e.target.files); }}
        />
      </div>
      {error && (
        <p className="mt-1 text-xs text-[#EC531A]">Please upload a file to continue.</p>
      )}
      {fileList.length > 0 && (
        <div className="mt-3 grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-2">
          {fileList.map((f, i) => (
            <FilePreview
              key={`${f.name}-${i}`}
              file={f}
              onRemove={onRemove ? () => onRemove(i) : undefined}
            />
          ))}
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
  const overLimit = count > MAX_AREAS;

  let counterClass = 'text-[#1B2E35]/50';
  if (overLimit) counterClass = 'text-[#EC531A] font-medium';
  else if (count > 0) counterClass = 'text-[#05C68E]';

  return (
    <div>
      <FieldLabel label={label} required={required} />
      <textarea
        rows={5}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`block w-full rounded-lg border bg-white px-3 py-2 text-sm text-[#1B2E35] placeholder:text-[#1B2E35]/40 focus:outline-none focus:ring-2 focus:ring-[#6C4AB6]/20 focus:border-[#6C4AB6] resize-y ${
          overLimit || invalid ? 'border-[#EC531A]' : 'border-[#E0DEE4]'
        }`}
      />
      <div className="mt-1 flex items-start justify-between gap-3">
        <p className="text-xs text-[#1B2E35]/50 flex-1">{helper}</p>
        <p className={`shrink-0 text-xs ${counterClass}`}>
          {overLimit
            ? `${count} of ${MAX_AREAS} — please trim ${count - MAX_AREAS} to continue`
            : `${count} of ${MAX_AREAS}`}
        </p>
      </div>
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
  const [files, setFiles] = useState<FileState>({
    agentPhoto: [],
    businessLogo: [],
    otherAssets: [],
  });
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

    // Max-5 area textareas: block if over limit on Content step
    if (step === 2) {
      if (parseAreas(form.serviceAreas).length > MAX_AREAS) return;
      if (parseAreas(form.localContentAreas).length > MAX_AREAS) return;
    }

    const nextStep = Math.min(step + 1, STEPS.length - 1);

    // Pre-fill Local Content Areas from Service Areas when entering Step 3
    // for the first time (user hasn't touched it, and it's empty).
    // Normalize through parseAreas so comma- AND newline-separated input
    // both pre-fill correctly as one-per-line.
    if (
      nextStep === 2 &&
      !touched.has('localContentAreas') &&
      !form.localContentAreas.trim() &&
      form.serviceAreas.trim()
    ) {
      const parsed = parseAreas(form.serviceAreas).slice(0, MAX_AREAS);
      if (parsed.length > 0) {
        setForm((prev) => ({ ...prev, localContentAreas: parsed.join('\n') }));
      }
    }

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
    // Re-check area limits
    const overAreas =
      parseAreas(form.serviceAreas).length > MAX_AREAS ||
      parseAreas(form.localContentAreas).length > MAX_AREAS;

    if (missingText.length || missingFiles.length || overAreas) {
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

      for (const photo of files.agentPhoto) {
        await uploadFile(photo, 'Agent Photo');
      }
      for (const logo of files.businessLogo) {
        await uploadFile(logo, 'Business Logo');
      }
      for (const asset of files.otherAssets) {
        await uploadFile(asset, 'Other Assets');
      }

      // Build payload — normalize area textareas to comma-separated, trim everything
      const payload: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(form)) {
        if (key === 'serviceAreas' || key === 'localContentAreas') {
          const parsed = parseAreas(value);
          if (parsed.length) payload[key] = parsed.join(', ');
        } else if (value.trim()) {
          payload[key] = value.trim();
        }
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
            <div>
              <FieldLabel label="Website" required />
              <input
                type="url"
                className={inputClass('website')}
                placeholder="https://yoursite.com"
                value={form.website}
                onChange={(e) => update('website', e.target.value)}
              />
            </div>
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
            <div>
              <FieldLabel label="Google My Business Name" />
              <input
                type="text"
                className={inputClass('gmbName')}
                placeholder="Name as it appears on Google"
                value={form.gmbName}
                onChange={(e) => update('gmbName', e.target.value)}
              />
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
            <DropZone
              label="Agent Photo"
              required
              multiple
              files={files.agentPhoto}
              onFiles={(fl) => {
                setFiles((prev) => ({
                  ...prev,
                  agentPhoto: [...prev.agentPhoto, ...Array.from(fl)],
                }));
                setTouched((prev) => new Set(prev).add('file:agentPhoto'));
              }}
              onRemove={(i) =>
                setFiles((prev) => ({
                  ...prev,
                  agentPhoto: prev.agentPhoto.filter((_, idx) => idx !== i),
                }))
              }
              error={touched.has('file:agentPhoto') && files.agentPhoto.length === 0}
            />
            <DropZone
              label="Business Logo"
              required
              multiple
              files={files.businessLogo}
              onFiles={(fl) => {
                setFiles((prev) => ({
                  ...prev,
                  businessLogo: [...prev.businessLogo, ...Array.from(fl)],
                }));
                setTouched((prev) => new Set(prev).add('file:businessLogo'));
              }}
              onRemove={(i) =>
                setFiles((prev) => ({
                  ...prev,
                  businessLogo: prev.businessLogo.filter((_, idx) => idx !== i),
                }))
              }
              error={touched.has('file:businessLogo') && files.businessLogo.length === 0}
            />
            <DropZone
              label="Other Brand Assets"
              multiple
              files={files.otherAssets}
              onFiles={(fl) =>
                setFiles((prev) => ({
                  ...prev,
                  otherAssets: [...prev.otherAssets, ...Array.from(fl)],
                }))
              }
              onRemove={(i) =>
                setFiles((prev) => ({
                  ...prev,
                  otherAssets: prev.otherAssets.filter((_, idx) => idx !== i),
                }))
              }
            />
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
          </div>
        );

      // Step 3 — Content Direction
      case 2:
        return (
          <div className="space-y-5">
            <AreasTextarea
              label="Service Areas"
              required
              value={form.serviceAreas}
              onChange={(v) => {
                // Live-sync into Local Content Areas if user hasn't customized
                // it yet. Stops as soon as they touch the Local Content field.
                setForm((prev) => {
                  const next: FormData = { ...prev, serviceAreas: v };
                  if (!touched.has('localContentAreas')) {
                    next.localContentAreas = parseAreas(v)
                      .slice(0, MAX_AREAS)
                      .join('\n');
                  }
                  return next;
                });
                setTouched((prev) => new Set(prev).add('serviceAreas'));
              }}
              placeholder={'One per line\ne.g.\nBrickell\nCoral Gables\nCoconut Grove'}
              helper="Our AI creates monthly market reports for these areas. Max 5."
              invalid={isInvalid('serviceAreas')}
            />
            <AreasTextarea
              label="Local Content Areas"
              value={form.localContentAreas}
              onChange={(v) => update('localContentAreas', v)}
              placeholder={'One per line, max 5'}
              helper="Where we'll source local stories and trends. Pre-filled from your service areas — edit if different. Max 5."
            />
            <div>
              <FieldLabel label="Topics" required />
              <textarea
                className={textareaClass('topics')}
                rows={3}
                placeholder="e.g., Luxury Real Estate, Market Updates, First-Time Buyers"
                value={form.topics}
                onChange={(e) => update('topics', e.target.value)}
              />
              <HelperText>What kinds of posts should we create for you?</HelperText>
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
                { label: 'Google My Business', value: form.gmbName },
              ]}
            />
            <ReviewSection
              title="You & Your Brand"
              stepIndex={1}
              onEdit={setStep}
              fields={[
                { label: 'Bio', value: form.bio },
                { label: 'Special Instructions', value: form.specialInstructions },
                { label: 'Other Emails', value: form.otherEmails },
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
                      Agent Photo: {f.name}
                    </li>
                  ))}
                  {files.businessLogo.map((f, i) => (
                    <li key={`l-${i}`} className="flex items-center gap-2">
                      <CheckIcon className="h-3.5 w-3.5 text-[#05C68E] shrink-0" />
                      Business Logo: {f.name}
                    </li>
                  ))}
                  {files.otherAssets.map((f, i) => (
                    <li key={`o-${i}`} className="flex items-center gap-2">
                      <CheckIcon className="h-3.5 w-3.5 text-[#05C68E] shrink-0" />
                      {f.name}
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
                { label: 'Service Areas', value: form.serviceAreas },
                { label: 'Local Content Areas', value: form.localContentAreas },
                { label: 'Topics', value: form.topics },
                { label: 'Hashtags', value: form.hashtags },
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
