'use client';

import { useState } from 'react';

/**
 * Label + value pair with a copy-to-clipboard button next to the value.
 *
 * Empty values render as a dash. Copy is disabled when empty (no point
 * clipboard'ing nothing). Click → writes raw `value` to clipboard, shows
 * "Copied!" inline for 1.5s, then resets.
 *
 * Pass `expandable` for long fields like Bio — renders as a <details>
 * with a 3-line clamp + tap-to-expand. The copy button still works in
 * the collapsed state.
 */
export default function CopyableField({
  label,
  value,
  expandable,
  className,
}: {
  label: string;
  value: string | null | undefined;
  expandable?: boolean;
  /** Tailwind classes to merge onto the outer wrapper. */
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const trimmed = (value ?? '').trim();
  const hasValue = trimmed.length > 0;

  async function copy() {
    if (!hasValue) return;
    try {
      await navigator.clipboard.writeText(trimmed);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Permissions might block (insecure context / iframes). Swallow.
    }
  }

  const valueDisplay = hasValue ? (
    <span className="whitespace-pre-wrap">{trimmed}</span>
  ) : (
    <span className="text-[#1B2E35]/40">—</span>
  );

  const labelEl = (
    <dt className="flex items-center justify-between gap-2 text-xs uppercase tracking-wide text-[#1B2E35]/50 font-medium">
      <span>{label}</span>
      {hasValue && (
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? 'Copied' : `Copy ${label}`}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[#1B2E35]/40 hover:bg-[#F7F4EB] hover:text-[#6C4AB6] transition-colors"
        >
          {copied ? (
            <span className="text-[#05C68E]">Copied!</span>
          ) : (
            <>
              <ClipboardIcon />
              <span className="sr-only sm:not-sr-only">Copy</span>
            </>
          )}
        </button>
      )}
    </dt>
  );

  if (expandable && hasValue && trimmed.length > 180) {
    return (
      <div className={className}>
        <details>
          <summary className="cursor-pointer list-none">
            {labelEl}
            <dd className="text-sm text-[#1B2E35] mt-1 line-clamp-3 whitespace-pre-wrap">
              {trimmed}
            </dd>
            <span className="text-[10px] text-[#6C4AB6] uppercase tracking-wider mt-1 inline-block">
              tap to expand
            </span>
          </summary>
          <dd className="text-sm text-[#1B2E35] mt-2 whitespace-pre-wrap">{trimmed}</dd>
        </details>
      </div>
    );
  }

  return (
    <div className={className}>
      {labelEl}
      <dd className="text-sm text-[#1B2E35] mt-1">{valueDisplay}</dd>
    </div>
  );
}

function ClipboardIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect x="4" y="3" width="8" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M6 3V2.5C6 1.94772 6.44772 1.5 7 1.5H9C9.55228 1.5 10 1.94772 10 2.5V3"
        stroke="currentColor"
        strokeWidth="1.3"
      />
    </svg>
  );
}
