'use client';

import { useState } from 'react';

export default function PortalLinkActions({
  customerId,
  portalBaseUrl,
}: {
  customerId: string;
  portalBaseUrl?: string;
}) {
  const [copied, setCopied] = useState(false);

  function buildUrl() {
    if (typeof window === 'undefined') return '';
    const base = portalBaseUrl || window.location.origin;
    return `${base}/r/${customerId}`;
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(buildUrl());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore — older browsers / permission denied
    }
  }

  const url = buildUrl();

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={handleCopy}
        title="Copy portal link"
        aria-label="Copy portal link"
        className="rounded-md border border-[#E0DEE4] bg-white px-2 py-1 text-xs text-[#1B2E35]/70 hover:border-[#6C4AB6] hover:text-[#6C4AB6] transition-colors"
      >
        {copied ? '✓ Copied' : 'Copy link'}
      </button>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        title="Open portal as customer"
        className="rounded-md border border-[#E0DEE4] bg-white px-2 py-1 text-xs text-[#1B2E35]/70 hover:border-[#6C4AB6] hover:text-[#6C4AB6] transition-colors"
      >
        Open ↗
      </a>
    </div>
  );
}
