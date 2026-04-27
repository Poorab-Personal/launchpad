'use client';

import { useState, useRef, useCallback } from 'react';
import type { Task, Customer } from '@/types';

// ─── Types ──────────────────────────────────────────────────────────

interface FormData {
  platformEmail: string;
  phone: string;
  businessName: string;
  businessAddress: string;
  website: string;
  serviceAreas: string;
  bio: string;
  licenseNumber: string;
  mlsIds: string;
  gmbName: string;
  topics: string;
  hashtags: string;
  specialInstructions: string;
  otherEmails: string;
}

interface FileState {
  agentPhoto: File | null;
  businessLogo: File | null;
  otherAssets: File[];
}

interface StepDef {
  name: string;
  label: string;
}

const STEPS: StepDef[] = [
  { name: 'contact', label: 'Contact Info' },
  { name: 'business', label: 'Business Info' },
  { name: 'details', label: 'Agent Details' },
  { name: 'branding', label: 'Content & Branding' },
  { name: 'assets', label: 'Upload Assets' },
  { name: 'review', label: 'Review & Submit' },
];

const REQUIRED_FIELDS: Record<number, (keyof FormData)[]> = {
  0: ['platformEmail'],
  1: ['businessName'],
  2: ['bio'],
};

const ACCEPTED_FORMATS = '.png,.svg,.jpg,.jpeg,.pdf';

function emptyForm(): FormData {
  return {
    platformEmail: '',
    phone: '',
    businessName: '',
    businessAddress: '',
    website: '',
    serviceAreas: '',
    bio: '',
    licenseNumber: '',
    mlsIds: '',
    gmbName: '',
    topics: '',
    hashtags: '',
    specialInstructions: '',
    otherEmails: '',
  };
}

function prefillFromCustomer(customer: Customer): FormData {
  return {
    platformEmail: customer.platformEmail || '',
    phone: customer.phone || '',
    businessName: customer.businessName || '',
    businessAddress: customer.businessAddress || '',
    website: customer.website || '',
    serviceAreas: customer.serviceAreas || '',
    bio: customer.bio || '',
    licenseNumber: customer.licenseNumber || '',
    mlsIds: customer.mlsIds || '',
    gmbName: customer.gmbName || '',
    topics: customer.topics || '',
    hashtags: customer.hashtags || '',
    specialInstructions: customer.specialInstructions || '',
    otherEmails: customer.otherEmails || '',
  };
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

function DropZone({
  label,
  multiple,
  files,
  onFiles,
}: {
  label: string;
  multiple?: boolean;
  files: File | File[] | null;
  onFiles: (files: FileList) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const fileList = files
    ? Array.isArray(files)
      ? files
      : [files]
    : [];

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files);
  }

  return (
    <div>
      <FieldLabel label={label} />
      <div
        className={`flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 text-center cursor-pointer transition-colors ${
          dragOver ? 'border-[#6C4AB6] bg-[#6C4AB6]/5' : 'border-[#E0DEE4] hover:border-[#6C4AB6]/50'
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
      {fileList.length > 0 && (
        <ul className="mt-2 space-y-1">
          {fileList.map((f, i) => (
            <li key={i} className="flex items-center gap-2 text-xs text-[#1B2E35]/70">
              <svg className="h-3.5 w-3.5 text-[#05C68E] shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
              </svg>
              {f.name}
            </li>
          ))}
        </ul>
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
  const [files, setFiles] = useState<FileState>({
    agentPhoto: null,
    businessLogo: null,
    otherAssets: [],
  });
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Helpers ──

  const update = useCallback((field: keyof FormData, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setTouched((prev) => new Set(prev).add(field));
  }, []);

  function isInvalid(field: keyof FormData) {
    return touched.has(field) && isRequired(field) && !form[field].trim();
  }

  function isRequired(field: keyof FormData) {
    for (const [, fields] of Object.entries(REQUIRED_FIELDS)) {
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

  // ── Navigation ──

  function handleNext() {
    // Mark required fields for current step as touched
    const required = REQUIRED_FIELDS[step];
    if (required) {
      setTouched((prev) => {
        const next = new Set(prev);
        for (const f of required) next.add(f);
        return next;
      });
      // Block navigation if any required field for this step is empty
      if (required.some((f) => !form[f].trim())) return;
    }
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }

  function handleBack() {
    setStep((s) => Math.max(s - 1, 0));
  }

  // ── Submit ──

  async function handleSubmit() {
    // Check ALL required fields across all steps before submitting
    const allRequired = Object.values(REQUIRED_FIELDS).flat();
    const missing = allRequired.filter((f) => !form[f].trim());
    if (missing.length > 0) {
      setTouched((prev) => {
        const next = new Set(prev);
        for (const f of missing) next.add(f);
        return next;
      });
      setError('Please fill in all required fields before submitting.');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      // 1. Upload files if any
      const fileUrls: Record<string, Array<{ url: string; filename: string }>> = {};

      const filesToUpload: Array<{ field: string; file: File }> = [];
      if (files.agentPhoto) filesToUpload.push({ field: 'agentPhoto', file: files.agentPhoto });
      if (files.businessLogo) filesToUpload.push({ field: 'businessLogo', file: files.businessLogo });
      for (const f of files.otherAssets) filesToUpload.push({ field: 'otherAssets', file: f });

      if (filesToUpload.length > 0) {
        const formData = new FormData();
        for (const { file } of filesToUpload) {
          formData.append('files', file);
        }

        const uploadRes = await fetch('/api/upload', { method: 'POST', body: formData });
        if (!uploadRes.ok) throw new Error('Failed to upload files');
        const uploadData = await uploadRes.json();

        // Map uploaded files back to their fields
        let uploadIdx = 0;
        if (files.agentPhoto) {
          fileUrls.agentPhoto = [uploadData.files[uploadIdx]];
          uploadIdx++;
        }
        if (files.businessLogo) {
          fileUrls.businessLogo = [uploadData.files[uploadIdx]];
          uploadIdx++;
        }
        if (files.otherAssets.length > 0) {
          fileUrls.otherAssets = uploadData.files.slice(uploadIdx);
        }
      }

      // 2. Build payload — only non-empty text fields
      const payload: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(form)) {
        if (value.trim()) {
          payload[key] = value.trim();
        }
      }

      // TODO (production): Write public S3 URLs to Airtable attachment fields:
      // if (fileUrls.agentPhoto) payload.agentPhoto = fileUrls.agentPhoto;
      // if (fileUrls.businessLogo) payload.businessLogo = fileUrls.businessLogo;
      // if (fileUrls.otherAssets) payload.otherAssets = fileUrls.otherAssets;
      // For now, files are stored locally and viewable in the portal.

      // 3. PATCH customer with form data
      const custRes = await fetch(`/api/customers/${customerId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!custRes.ok) {
        const err = await custRes.json().catch(() => null);
        throw new Error(err?.error || 'Failed to save your information');
      }

      // PATCH task as completed
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
      case 0:
        return (
          <div className="space-y-4">
            <div>
              <FieldLabel label="Platform Email" required />
              <input
                type="email"
                className={inputClass('platformEmail')}
                placeholder="Email for your app.rejig.ai login"
                value={form.platformEmail}
                onChange={(e) => update('platformEmail', e.target.value)}
              />
            </div>
            <div>
              <FieldLabel label="Phone" />
              <input
                type="tel"
                className={inputClass('phone')}
                placeholder="(555) 123-4567"
                value={form.phone}
                onChange={(e) => update('phone', e.target.value)}
              />
            </div>
          </div>
        );

      case 1:
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
              <FieldLabel label="Website" />
              <input
                type="url"
                className={inputClass('website')}
                placeholder="https://yoursite.com"
                value={form.website}
                onChange={(e) => update('website', e.target.value)}
              />
            </div>
            <div>
              <FieldLabel label="Service Areas" />
              <textarea
                className={textareaClass('serviceAreas')}
                rows={2}
                placeholder="e.g., Brickell, Coral Gables, Coconut Grove"
                value={form.serviceAreas}
                onChange={(e) => update('serviceAreas', e.target.value)}
              />
            </div>
          </div>
        );

      case 2:
        return (
          <div className="space-y-4">
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
              <FieldLabel label="MLS IDs" />
              <input
                type="text"
                className={inputClass('mlsIds')}
                placeholder="Comma-separated MLS IDs"
                value={form.mlsIds}
                onChange={(e) => update('mlsIds', e.target.value)}
              />
            </div>
            <div>
              <FieldLabel label="Google My Business Name" />
              <input
                type="text"
                className={inputClass('gmbName')}
                placeholder="Google My Business name"
                value={form.gmbName}
                onChange={(e) => update('gmbName', e.target.value)}
              />
            </div>
          </div>
        );

      case 3:
        return (
          <div className="space-y-4">
            <div>
              <FieldLabel label="Topics" />
              <textarea
                className={textareaClass('topics')}
                rows={3}
                placeholder="e.g., Luxury Real Estate, Market Updates"
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
            <div>
              <FieldLabel label="Special Instructions" />
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
                placeholder="Additional emails for design sends"
                value={form.otherEmails}
                onChange={(e) => update('otherEmails', e.target.value)}
              />
            </div>
          </div>
        );

      case 4:
        return (
          <div className="space-y-5">
            <DropZone
              label="Agent Photo"
              files={files.agentPhoto}
              onFiles={(fl) => setFiles((prev) => ({ ...prev, agentPhoto: fl[0] }))}
            />
            <DropZone
              label="Business Logo"
              files={files.businessLogo}
              onFiles={(fl) => setFiles((prev) => ({ ...prev, businessLogo: fl[0] }))}
            />
            <DropZone
              label="Other Assets"
              multiple
              files={files.otherAssets}
              onFiles={(fl) =>
                setFiles((prev) => ({
                  ...prev,
                  otherAssets: [...prev.otherAssets, ...Array.from(fl)],
                }))
              }
            />
            <p className="text-xs text-[#1B2E35]/40">
              Accepted formats: PNG, SVG, JPG, PDF
            </p>
          </div>
        );

      case 5:
        return (
          <div className="space-y-4">
            <ReviewSection
              title="Contact Info"
              stepIndex={0}
              onEdit={setStep}
              fields={[
                { label: 'Platform Email', value: form.platformEmail },
                { label: 'Phone', value: form.phone },
              ]}
            />
            <ReviewSection
              title="Business Info"
              stepIndex={1}
              onEdit={setStep}
              fields={[
                { label: 'Business Name', value: form.businessName },
                { label: 'Business Address', value: form.businessAddress },
                { label: 'Website', value: form.website },
                { label: 'Service Areas', value: form.serviceAreas },
              ]}
            />
            <ReviewSection
              title="Agent Details"
              stepIndex={2}
              onEdit={setStep}
              fields={[
                { label: 'Bio', value: form.bio },
                { label: 'License Number', value: form.licenseNumber },
                { label: 'MLS IDs', value: form.mlsIds },
                { label: 'GMB Name', value: form.gmbName },
              ]}
            />
            <ReviewSection
              title="Content & Branding"
              stepIndex={3}
              onEdit={setStep}
              fields={[
                { label: 'Topics', value: form.topics },
                { label: 'Hashtags', value: form.hashtags },
                { label: 'Special Instructions', value: form.specialInstructions },
                { label: 'Other Emails', value: form.otherEmails },
              ]}
            />
            <div className="rounded-lg border border-[#E0DEE4] p-4">
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-sm font-semibold text-[#1B2E35]">Upload Assets</h4>
                <button
                  type="button"
                  onClick={() => setStep(4)}
                  className="text-xs font-medium text-[#6C4AB6] hover:text-[#6C4AB6]/80 transition-colors"
                >
                  Edit
                </button>
              </div>
              {files.agentPhoto || files.businessLogo || files.otherAssets.length > 0 ? (
                <ul className="space-y-1 text-sm text-[#1B2E35]">
                  {files.agentPhoto && (
                    <li className="flex items-center gap-2">
                      <CheckIcon className="h-3.5 w-3.5 text-[#05C68E] shrink-0" />
                      Agent Photo: {files.agentPhoto.name}
                    </li>
                  )}
                  {files.businessLogo && (
                    <li className="flex items-center gap-2">
                      <CheckIcon className="h-3.5 w-3.5 text-[#05C68E] shrink-0" />
                      Business Logo: {files.businessLogo.name}
                    </li>
                  )}
                  {files.otherAssets.map((f, i) => (
                    <li key={i} className="flex items-center gap-2">
                      <CheckIcon className="h-3.5 w-3.5 text-[#05C68E] shrink-0" />
                      {f.name}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-[#1B2E35]/40 italic">No files selected</p>
              )}
            </div>

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
