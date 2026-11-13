'use client';

import { useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { upload } from '@vercel/blob/client';
import {
  brandKitMissing,
  emptyBrandKit,
  isHexColor,
  PALETTE_SLOTS,
  type BrandKit,
  type FontPick,
  type LogoSlot,
  type LogoVariant,
  type RejigOption,
} from '@/lib/brand-kit';
import type { ProductTier } from '@/types';
import { saveBrandKitAction, saveBrandKitLogoAction } from './brand-kit-actions';

/**
 * Structured brand kit the designer fills during Create Designs — replaces
 * posting palettes and logo screenshots into Internal Notes. Laid out like
 * Rejig's Manage Brand screen, because every field here is pushed to Rejig
 * as-is. Plan: docs/plans/rejig-account-sync.md.
 *
 * Logos save the moment they're uploaded; everything else saves with the
 * Save button. The two never overwrite each other (see db.ts).
 */

const VARIANT_LABELS: Record<LogoVariant, string> = {
  logo: 'Logo',
  logo_black: 'Black Logo',
  logo_white: 'White Logo',
};
const VARIANT_SLOT: Record<LogoVariant, LogoSlot> = {
  logo: 'primary',
  logo_black: 'black',
  logo_white: 'white',
};
const LOGO_TILES: { slot: LogoSlot; label: string; hint: string; dark: boolean; required: boolean }[] = [
  { slot: 'primary', label: 'Primary Logo', hint: 'Full colour', dark: false, required: true },
  { slot: 'black', label: 'Black Logo', hint: 'For light backgrounds', dark: false, required: false },
  { slot: 'white', label: 'White Logo', hint: 'For dark backgrounds', dark: true, required: false },
];
const FONT_ROLES = [
  { key: 'primary', label: 'Primary' },
  { key: 'secondary', label: 'Secondary' },
  { key: 'tertiary', label: 'Tertiary' },
] as const;

const inputClass =
  'w-full rounded-lg border border-[#E0DEE4] bg-white px-3 py-2 text-sm text-[#1B2E35] placeholder:text-[#1B2E35]/30 focus:outline-none focus:ring-2 focus:ring-[#6C4AB6]/30 focus:border-[#6C4AB6] disabled:bg-[#F7F4EB]/60 disabled:text-[#1B2E35]/70';
const labelClass = 'block text-xs uppercase tracking-wide text-[#1B2E35]/60 font-semibold mb-1.5';

function fill<T>(arr: T[], value: T): T[] {
  return Array.from({ length: PALETTE_SLOTS }, (_, i) => arr[i] ?? value);
}

function splitTags(raw: string): string[] {
  return raw.split(',').map((t) => t.trim()).filter(Boolean);
}

/**
 * Dropdown with type-to-filter for Rejig's long lists: click to scroll the
 * whole list, or type to narrow it. Only an option from the list can be
 * picked; clearing the text clears the pick. A saved value missing from the
 * list still shows.
 */
function SearchSelect({
  options,
  selected,
  disabled,
  placeholder,
  onChange,
}: {
  options: RejigOption[];
  selected: RejigOption | null;
  disabled: boolean;
  placeholder: string;
  onChange: (opt: RejigOption | null) => void;
}) {
  const [query, setQuery] = useState<string | null>(null);
  const q = (query ?? '').trim().toLowerCase();
  const matches = useMemo(
    () => (query === null ? [] : q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options),
    [options, query, q],
  );

  return (
    <div className="relative">
      <input
        type="text"
        disabled={disabled}
        value={query ?? selected?.label ?? ''}
        // While open, the current pick stays visible as the placeholder.
        placeholder={query !== null && selected ? selected.label : placeholder}
        onFocus={() => setQuery('')}
        onBlur={() => setQuery(null)}
        onChange={(e) => {
          setQuery(e.target.value);
          if (e.target.value === '' && selected) onChange(null);
        }}
        className={`${inputClass} pr-9`}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-[#1B2E35]/50"
      >
        ▾
      </span>
      {query !== null && (
        <ul className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-[#E0DEE4] bg-white py-1 text-sm shadow-lg">
          {matches.length === 0 ? (
            <li className="px-3 py-1.5 text-[#1B2E35]/40">No matches</li>
          ) : (
            matches.map((o) => (
              <li key={o.value}>
                <button
                  type="button"
                  // mousedown, not click: fires before the input's blur closes the list.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onChange(o);
                    setQuery(null);
                  }}
                  className={`block w-full px-3 py-1.5 text-left hover:bg-[#6C4AB6]/10 ${
                    o.value === selected?.value ? 'font-semibold text-[#6C4AB6]' : 'text-[#1B2E35]'
                  }`}
                >
                  {o.label}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

export default function BrandKitCard({
  customerId,
  brandKit,
  productTier,
  canEdit,
  kitInProgress,
  affiliations,
  fonts,
}: {
  customerId: string;
  brandKit: BrandKit | null;
  productTier: ProductTier | null;
  canEdit: boolean;
  /** The customer is at the step where the kit gets filled (Create Designs / Create Customer Account active). */
  kitInProgress: boolean;
  affiliations: RejigOption[];
  fonts: RejigOption[];
}) {
  const router = useRouter();
  const initial = brandKit ?? emptyBrandKit();
  const [kit, setKit] = useState<BrandKit>({
    ...initial,
    palette: fill(initial.palette, ''),
    logoSelection: fill(initial.logoSelection, 'logo'),
    teamLogoSelection: fill(initial.teamLogoSelection, 'logo'),
  });
  const [accountType, setAccountType] = useState<ProductTier | ''>(productTier ?? '');
  const [imageTags, setImageTags] = useState(initial.imageSearchTags.join(', '));
  const [videoTags, setVideoTags] = useState(initial.videoSearchTags.join(', '));
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<LogoSlot | null>(null);
  const [pending, startTransition] = useTransition();
  // Open straight into the editor only when the kit is being worked on now:
  // the customer is at that step and it's incomplete. Everyone else — and
  // every older customer, none of whom has a kit — gets the summary.
  const [editing, setEditing] = useState(
    () => canEdit && kitInProgress && brandKitMissing(brandKit, productTier).length > 0,
  );
  const fileInputs = useRef<Partial<Record<LogoSlot, HTMLInputElement | null>>>({});

  // Logos come from props (saved immediately), fields from local state.
  const logos = useMemo(() => brandKit?.logos ?? {}, [brandKit]);
  const missing = useMemo(
    () => brandKitMissing({ ...kit, logos }, accountType || null),
    [kit, logos, accountType],
  );

  function update(patch: Partial<BrandKit>) {
    setKit((k) => ({ ...k, ...patch }));
    setDirty(true);
    setSaved(false);
  }

  function setAt<K extends 'palette' | 'logoSelection' | 'teamLogoSelection'>(
    key: K,
    i: number,
    value: BrandKit[K][number],
  ) {
    const next = [...kit[key]] as BrandKit[K];
    next[i] = value;
    update({ [key]: next } as Partial<BrandKit>);
  }

  function setFont(role: 'primary' | 'secondary' | 'tertiary', patch: Partial<FontPick>) {
    const current: FontPick = kit.fonts[role] ?? { value: '', label: '', lineHeight: 1 };
    update({ fonts: { ...kit.fonts, [role]: { ...current, ...patch } } });
  }

  function handleSave() {
    setError(null);
    startTransition(async () => {
      const res = await saveBrandKitAction({
        customerId,
        accountType: accountType || null,
        fields: { ...kit, imageSearchTags: splitTags(imageTags), videoSearchTags: splitTags(videoTags) },
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setDirty(false);
      setSaved(true);
      router.refresh();
    });
  }

  async function handleLogo(slot: LogoSlot, file: File | null) {
    setError(null);
    setUploading(slot);
    try {
      let attachment: { url: string; filename: string } | null = null;
      if (file) {
        const blob = await upload(`brand-kit/${customerId}/${slot}-${file.name}`, file, {
          access: 'public',
          handleUploadUrl: '/api/workspace/brand-kit/sign',
          clientPayload: JSON.stringify({ customerId }),
        });
        attachment = { url: blob.url, filename: file.name };
      }
      const res = await saveBrandKitLogoAction({ customerId, slot, attachment });
      if (!res.ok) setError(res.error);
      else router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setUploading(null);
      const input = fileInputs.current[slot];
      if (input) input.value = '';
    }
  }

  const disabled = !canEdit || pending;

  if (!editing) {
    return (
      <BrandKitSummary
        brandKit={brandKit}
        productTier={productTier}
        canEdit={canEdit}
        onEdit={() => setEditing(true)}
      />
    );
  }

  return (
    <section className="rounded-xl bg-white border border-[#E0DEE4] p-6 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-[#1B2E35]/70">Brand Kit</h2>
          <p className="text-xs text-[#1B2E35]/50 mt-0.5">
            Sent to Rejig as-is when the account is synced. Laid out like Rejig&apos;s Manage Brand screen.
          </p>
        </div>
        <StatusPill missing={missing} />
      </div>
      {missing.length > 0 && (
        <p className="-mt-3 text-xs text-[#B45309]">Missing: {missing.join(' · ')}</p>
      )}

      {/* Logos */}
      <div>
        <h3 className="text-sm font-semibold text-[#1B2E35] mb-3">Brand Logo</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {LOGO_TILES.map((t) => {
            const current = logos[t.slot];
            return (
              <div key={t.slot} className="rounded-lg border border-[#E0DEE4] p-3 space-y-2">
                <div
                  className={`flex h-28 items-center justify-center rounded-md p-3 ${
                    t.dark ? 'bg-[#1B2E35]' : 'bg-[#F7F4EB]'
                  }`}
                >
                  {current ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={current.url} alt={t.label} className="max-h-full max-w-full object-contain" />
                  ) : (
                    <span className={`text-xs ${t.dark ? 'text-white/50' : 'text-[#1B2E35]/40'}`}>No logo</span>
                  )}
                </div>
                <div>
                  <p className="text-sm font-medium text-[#1B2E35]">
                    {t.label}
                    {!t.required && <span className="ml-1 text-xs font-normal text-[#1B2E35]/40">optional</span>}
                  </p>
                  <p className="text-xs text-[#1B2E35]/50">{t.hint}</p>
                </div>
                {canEdit && (
                  <div className="flex items-center gap-3 text-xs">
                    <input
                      ref={(el) => {
                        fileInputs.current[t.slot] = el;
                      }}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="hidden"
                      onChange={(e) => handleLogo(t.slot, e.target.files?.[0] ?? null)}
                    />
                    <button
                      type="button"
                      disabled={uploading !== null}
                      onClick={() => fileInputs.current[t.slot]?.click()}
                      className="font-medium text-[#6C4AB6] hover:underline disabled:opacity-50"
                    >
                      {uploading === t.slot ? 'Uploading…' : current ? 'Replace' : 'Upload'}
                    </button>
                    {current && (
                      <button
                        type="button"
                        disabled={uploading !== null}
                        onClick={() => handleLogo(t.slot, null)}
                        className="text-[#1B2E35]/50 hover:text-[#EC531A] disabled:opacity-50"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-[#1B2E35]/50">PNG, JPEG or WebP. Use a large PNG with a transparent background.</p>
      </div>

      {/* Colours + logo selection */}
      <div>
        <h3 className="text-sm font-semibold text-[#1B2E35] mb-1">Brand Colors &amp; Logo Selection</h3>
        <p className="text-xs text-[#1B2E35]/50 mb-3">
          Five colours. Under each, the logo Rejig puts on that colour — for the agent brand and for the team.
        </p>
        <div className="grid grid-cols-5 gap-2">
          {Array.from({ length: PALETTE_SLOTS }, (_, i) => {
            const hex = kit.palette[i];
            const valid = isHexColor(hex);
            const previewLogo = logos[VARIANT_SLOT[kit.logoSelection[i]]];
            return (
              <div key={i} className="space-y-1.5">
                <label
                  className={`relative flex h-16 items-center justify-center overflow-hidden rounded-md border border-[#E0DEE4] ${
                    canEdit ? 'cursor-pointer' : ''
                  }`}
                  style={{ backgroundColor: valid ? hex : '#FFFFFF' }}
                >
                  <input
                    type="color"
                    disabled={disabled}
                    value={valid ? hex : '#ffffff'}
                    onChange={(e) => setAt('palette', i, e.target.value.toUpperCase())}
                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default"
                    aria-label={`Colour ${i + 1}`}
                  />
                  {previewLogo ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={previewLogo.url} alt="" className="pointer-events-none max-h-10 max-w-[80%] object-contain" />
                  ) : !valid ? (
                    <span className="pointer-events-none text-[10px] text-[#1B2E35]/40">pick</span>
                  ) : null}
                </label>
                <input
                  type="text"
                  disabled={disabled}
                  value={hex}
                  placeholder="#000000"
                  maxLength={7}
                  onChange={(e) => setAt('palette', i, e.target.value.trim())}
                  className={`${inputClass} px-2 py-1 text-xs font-mono ${hex && !valid ? 'border-[#EC531A]' : ''}`}
                />
                <select
                  disabled={disabled}
                  value={kit.logoSelection[i]}
                  onChange={(e) => setAt('logoSelection', i, e.target.value as LogoVariant)}
                  className={`${inputClass} px-2 py-1 text-xs`}
                  aria-label={`Logo on colour ${i + 1}`}
                >
                  {Object.entries(VARIANT_LABELS).map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </select>
                <select
                  disabled={disabled}
                  value={kit.teamLogoSelection[i]}
                  onChange={(e) => setAt('teamLogoSelection', i, e.target.value as LogoVariant)}
                  className={`${inputClass} px-2 py-1 text-xs`}
                  aria-label={`Team logo on colour ${i + 1}`}
                >
                  {Object.entries(VARIANT_LABELS).map(([v, l]) => (
                    <option key={v} value={v}>Team: {l}</option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
        <Toggle
          label="Apply Fixed Logo Height"
          checked={kit.applyFixedLogoHeight}
          disabled={disabled}
          onChange={(v) => update({ applyFixedLogoHeight: v })}
        />
      </div>

      {/* Fonts */}
      <div>
        <h3 className="text-sm font-semibold text-[#1B2E35] mb-1">Brand Fonts</h3>
        <Toggle
          label="Apply Custom Font?"
          checked={kit.applyCustomFont}
          disabled={disabled}
          onChange={(v) => update({ applyCustomFont: v })}
        />
        {kit.applyCustomFont && (
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
            {FONT_ROLES.map(({ key, label }) => {
              const f = kit.fonts[key];
              return (
                <div key={key} className="space-y-2">
                  <label className={labelClass}>{label} Font</label>
                  <SearchSelect
                    options={fonts}
                    selected={f?.value ? { value: f.value, label: f.label } : null}
                    disabled={disabled}
                    placeholder="Search fonts…"
                    onChange={(opt) => setFont(key, { value: opt?.value ?? '', label: opt?.label ?? '' })}
                  />
                  <label className={labelClass}>{label} Line Height</label>
                  <input
                    type="number"
                    step="0.05"
                    min="0.1"
                    disabled={disabled}
                    value={f?.lineHeight ?? 1}
                    onChange={(e) => setFont(key, { lineHeight: Number(e.target.value) })}
                    className={inputClass}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Sizes */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
        {(
          [
            ['brandLogoSizes', 'Brand Logo Sizes'],
            ['teamLogoSizes', 'Team Logo Sizes'],
          ] as const
        ).map(([key, title]) => (
          <div key={key}>
            <h3 className="text-sm font-semibold text-[#1B2E35] mb-3">{title}</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>Facebook square</label>
                <input
                  type="number"
                  min="1"
                  disabled={disabled}
                  value={kit[key].facebookSquare}
                  onChange={(e) => update({ [key]: { ...kit[key], facebookSquare: Number(e.target.value) } })}
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>Instagram 4_5</label>
                <input
                  type="number"
                  min="1"
                  disabled={disabled}
                  value={kit[key].instagram}
                  onChange={(e) => update({ [key]: { ...kit[key], instagram: Number(e.target.value) } })}
                  className={inputClass}
                />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Account + templates */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>Account type</label>
          <select
            disabled={disabled}
            value={accountType}
            onChange={(e) => {
              setAccountType(e.target.value as ProductTier | '');
              setDirty(true);
              setSaved(false);
            }}
            className={inputClass}
          >
            <option value="">Choose…</option>
            <option value="Premium">Premium</option>
            <option value="Luxury">Luxury</option>
          </select>
        </div>
        <div>
          <label className={labelClass}>Footer label</label>
          <input
            type="text"
            disabled={disabled}
            value={kit.footerLabel}
            placeholder="e.g. Keyes-Kristi-Dye-Footer"
            onChange={(e) => update({ footerLabel: e.target.value })}
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>Affiliation</label>
          <SearchSelect
            options={affiliations}
            selected={kit.affiliation}
            disabled={disabled}
            placeholder="Search affiliations…"
            onChange={(opt) => update({ affiliation: opt })}
          />
        </div>
        <div>
          <label className={labelClass}>Other affiliation</label>
          <input
            type="text"
            disabled={disabled}
            value={kit.otherAffiliation}
            placeholder="optional"
            onChange={(e) => update({ otherAffiliation: e.target.value })}
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>Image custom search tags</label>
          <input
            type="text"
            disabled={disabled}
            value={imageTags}
            placeholder="comma separated, e.g. luxury, keyes"
            onChange={(e) => {
              setImageTags(e.target.value);
              setDirty(true);
              setSaved(false);
            }}
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>Video custom search tags</label>
          <input
            type="text"
            disabled={disabled}
            value={videoTags}
            placeholder="comma separated"
            onChange={(e) => {
              setVideoTags(e.target.value);
              setDirty(true);
              setSaved(false);
            }}
            className={inputClass}
          />
        </div>
      </div>
      {(affiliations.length === 0 || fonts.length === 0) && (
        <p className="text-xs text-[#B45309]">
          Couldn&apos;t load Rejig&apos;s {affiliations.length === 0 ? 'affiliation' : 'font'} list. Try reloading in a
          minute.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={pending || !dirty}
          className="rounded-full bg-[#6C4AB6] px-5 py-2 text-sm font-medium text-white hover:bg-[#5A3FA0] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {pending ? 'Saving…' : 'Save brand kit'}
        </button>
        {dirty && !pending && <span className="text-xs text-[#B45309]">Unsaved changes</span>}
        {saved && !dirty && <span className="text-xs text-[#04946A]">Saved</span>}
        {error && <span className="text-xs text-[#EC531A]">{error}</span>}
        <button
          type="button"
          onClick={() => setEditing(false)}
          disabled={dirty || pending || uploading !== null}
          title={dirty ? 'Save or undo your changes first' : undefined}
          className="ml-auto text-xs font-medium text-[#1B2E35]/50 hover:text-[#1B2E35] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Close
        </button>
      </div>
    </section>
  );
}

function StatusPill({ missing }: { missing: string[] }) {
  return missing.length === 0 ? (
    <span className="inline-flex items-center rounded-full bg-[#05C68E]/15 px-2.5 py-0.5 text-xs font-medium text-[#04946A]">
      Complete
    </span>
  ) : (
    <span
      className="inline-flex items-center rounded-full bg-[#D97706]/15 px-2.5 py-0.5 text-xs font-medium text-[#B45309]"
      title={missing.join(', ')}
    >
      {missing.length} missing
    </span>
  );
}

/**
 * Read-at-a-glance view of the saved kit: what the Account Creator checks
 * before syncing, and what a designer sees once the kit is complete.
 */
function BrandKitSummary({
  brandKit,
  productTier,
  canEdit,
  onEdit,
}: {
  brandKit: BrandKit | null;
  productTier: ProductTier | null;
  canEdit: boolean;
  onEdit: () => void;
}) {
  const missing = brandKitMissing(brandKit, productTier);
  const kit = brandKit ?? emptyBrandKit();
  const rowLabel = 'text-[11px] uppercase tracking-wide text-[#1B2E35]/50 font-semibold pt-1';
  const fontLine = kit.applyCustomFont
    ? FONT_ROLES.map(({ key }) => kit.fonts[key])
        .filter((f): f is FontPick => !!f?.value)
        .map((f) => `${f.label} ${f.lineHeight}`)
        .join(' · ') || 'Custom font on, none chosen'
    : 'Rejig defaults (custom font off)';
  const team = kit.teamLogoSelection.map((v) => VARIANT_LABELS[v]?.replace(' Logo', '') ?? v).join(' · ');

  return (
    <section className="rounded-xl bg-white border border-[#E0DEE4] p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-[#1B2E35]/70">Brand Kit</h2>
          <p className="text-xs text-[#1B2E35]/50 mt-0.5">The final kit Rejig will use. Filled by the designer.</p>
        </div>
        <div className="flex items-center gap-2">
          <StatusPill missing={missing} />
          {canEdit && (
            <button
              type="button"
              onClick={onEdit}
              className="rounded-full border border-[#E0DEE4] px-3 py-1 text-xs font-medium text-[#6C4AB6] hover:border-[#6C4AB6]/40"
            >
              Edit
            </button>
          )}
        </div>
      </div>
      {missing.length > 0 && (
        <p className="mt-2 text-xs text-[#B45309]">Missing: {missing.join(' · ')}</p>
      )}

      {!brandKit ? (
        <p className="mt-4 text-sm italic text-[#1B2E35]/40">Not started yet.</p>
      ) : (
        <div className="mt-5 grid grid-cols-1 md:grid-cols-[auto_1fr] gap-x-8 gap-y-5">
          <p className={rowLabel}>Logos</p>
          <div className="flex flex-wrap gap-3">
            {LOGO_TILES.map((t) => {
              const logo = kit.logos[t.slot];
              return (
                <div key={t.slot} className="space-y-1">
                  <div
                    className={`flex h-20 w-24 items-center justify-center rounded-md border border-[#E0DEE4] p-1.5 ${
                      t.dark ? 'bg-[#1B2E35]' : 'bg-[#F7F4EB]'
                    }`}
                  >
                    {logo ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={logo.url} alt={t.label} className="max-h-full max-w-full object-contain" />
                    ) : (
                      <span className={`text-[11px] ${t.dark ? 'text-white/50' : 'text-[#1B2E35]/40'}`}>None</span>
                    )}
                  </div>
                  <p className="text-[11px] text-[#1B2E35]/60">{t.label.replace(' Logo', '')}</p>
                </div>
              );
            })}
          </div>

          <p className={rowLabel}>Colours</p>
          <div className="min-w-0 space-y-1.5">
            <div className="flex">
              {Array.from({ length: PALETTE_SLOTS }, (_, i) => {
                const hex = kit.palette[i] ?? '';
                const logo = kit.logos[VARIANT_SLOT[kit.logoSelection[i] ?? 'logo']];
                return (
                  <div
                    key={i}
                    className="flex h-12 flex-1 items-center justify-center border-y border-[#E0DEE4] first:rounded-l-md first:border-l last:rounded-r-md last:border-r"
                    style={{ backgroundColor: isHexColor(hex) ? hex : '#FFFFFF' }}
                  >
                    {logo && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={logo.url} alt="" className="max-h-8 max-w-[75%] object-contain" />
                    )}
                  </div>
                );
              })}
            </div>
            <p className="text-[11px] font-mono text-[#1B2E35]/60">
              {kit.palette.filter(Boolean).join(' · ') || 'No colours yet'}
            </p>
            <p className="text-[11px] text-[#1B2E35]/60">
              Team logos: {team || '—'} · Fixed logo height: {kit.applyFixedLogoHeight ? 'Yes' : 'No'}
            </p>
          </div>

          <p className={rowLabel}>Fonts</p>
          <p className="text-sm text-[#1B2E35]">{fontLine}</p>

          <p className={rowLabel}>Account</p>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {(
              [
                ['Account type', productTier ?? '—'],
                ['Affiliation', kit.affiliation?.label ?? '—'],
                ['Footer label', kit.footerLabel || '—'],
                [
                  'Logo sizes',
                  `Brand ${kit.brandLogoSizes.facebookSquare}/${kit.brandLogoSizes.instagram} · Team ${kit.teamLogoSizes.facebookSquare}/${kit.teamLogoSizes.instagram}`,
                ],
                ['Image tags', kit.imageSearchTags.join(', ') || '—'],
                ['Video tags', kit.videoSearchTags.join(', ') || '—'],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="text-[11px] uppercase tracking-wide text-[#1B2E35]/50 font-semibold">{label}</dt>
                <dd className="break-words text-sm text-[#1B2E35]">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </section>
  );
}

function Toggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="mt-3 flex items-center justify-between rounded-lg bg-[#F7F4EB]/60 px-3 py-2">
      <span className="text-sm text-[#1B2E35]">{label}</span>
      <div className="flex items-center gap-2 text-xs">
        <span className={checked ? 'text-[#1B2E35]/40' : 'font-semibold text-[#1B2E35]'}>NO</span>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-label={label}
          disabled={disabled}
          onClick={() => onChange(!checked)}
          className={`relative h-6 w-11 rounded-full transition-colors disabled:opacity-60 ${
            checked ? 'bg-[#05C68E]' : 'bg-[#E0DEE4]'
          }`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
              checked ? 'left-[22px]' : 'left-0.5'
            }`}
          />
        </button>
        <span className={checked ? 'font-semibold text-[#1B2E35]' : 'text-[#1B2E35]/40'}>YES</span>
      </div>
    </div>
  );
}
