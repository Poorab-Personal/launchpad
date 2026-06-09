'use client';

import { useEffect, useState } from 'react';

/**
 * Client-side date renderers for `customer.callDate`. Run in the viewer's
 * local timezone — server-side rendering would resolve to UTC on Vercel,
 * which lies about "in N days" rollover and prints the wrong wall-clock
 * time. Both components mount-hydrate (returning null during SSR) to avoid
 * hydration-mismatch warnings — small "pop in" on first paint is acceptable
 * for an internal workspace surface.
 */

function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function relativeLabel(callMs: number, nowMs: number): string | null {
  const days = Math.round((startOfLocalDay(callMs) - startOfLocalDay(nowMs)) / (1000 * 60 * 60 * 24));
  if (days < 0) return null;
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

/** Small inline "📞 in 3d" badge for queue cards. Returns null on SSR + past dates. */
export function CallDateBadge({ callDateIso }: { callDateIso: string }) {
  const [view, setView] = useState<{ label: string; classes: string } | null>(null);
  useEffect(() => {
    const t = Date.parse(callDateIso);
    if (Number.isNaN(t)) return;
    const rel = relativeLabel(t, Date.now());
    if (!rel) return;
    const compact =
      rel === 'today' ? '📞 today'
      : rel === 'tomorrow' ? '📞 tomorrow'
      : `📞 ${rel.replace('in ', 'in ').replace(' days', 'd')}`;
    const days = Math.round((startOfLocalDay(t) - startOfLocalDay(Date.now())) / (1000 * 60 * 60 * 24));
    const classes =
      days <= 1 ? 'text-[#EC531A] font-semibold'
      : days <= 7 ? 'text-[#6C4AB6]'
      : 'text-[#1B2E35]/50';
    setView({ label: compact, classes });
  }, [callDateIso]);

  if (!view) return null;
  return <span className={view.classes}>{view.label}</span>;
}

/** Prominent callout for the customer detail page header. Renders the
 *  formatted wall-clock + relative-days in the viewer's local TZ. */
export function CallDateCallout({ callDateIso }: { callDateIso: string }) {
  const [view, setView] = useState<{ when: string; relative: string } | null>(null);
  useEffect(() => {
    const t = Date.parse(callDateIso);
    if (Number.isNaN(t)) return;
    const rel = relativeLabel(t, Date.now());
    if (!rel) return;
    const when = new Date(t).toLocaleString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    });
    setView({ when, relative: rel });
  }, [callDateIso]);

  if (!view) return null;
  return (
    <div className="mt-4 rounded-lg bg-[#6C4AB6]/5 border border-[#6C4AB6]/20 px-4 py-2.5 flex items-center gap-3">
      <span className="text-base">📞</span>
      <div className="flex-1 text-sm">
        <span className="font-semibold text-[#6C4AB6]">Onboarding call:</span>{' '}
        <span className="text-[#1B2E35]">{view.when}</span>
        <span className="text-[#1B2E35]/60"> · {view.relative}</span>
      </div>
    </div>
  );
}
