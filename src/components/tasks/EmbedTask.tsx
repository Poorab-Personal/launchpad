'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import Script from 'next/script';
import type { Task } from '@/types';

/**
 * Calendly only fires postMessage events ("calendly.event_scheduled",
 * "calendly.profile_page_viewed", etc.) when the embedded URL includes
 * `embed_domain` and `embed_type=Inline` query params. Without these,
 * the iframe loads but our parent page never learns when the booking is
 * confirmed. We append the params client-side from window.location.host.
 */
function withCalendlyEmbedParams(url: string): string {
  if (typeof window === 'undefined') return url;
  try {
    const u = new URL(url);
    if (!u.searchParams.has('embed_domain')) {
      u.searchParams.set('embed_domain', window.location.host);
    }
    if (!u.searchParams.has('embed_type')) {
      u.searchParams.set('embed_type', 'Inline');
    }
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * HubSpot Meetings: ensure `?embed=true` is set so the embedded experience
 * fires postMessage events (`event.data.meetingBookSucceeded`).
 */
function withHubSpotMeetingsParams(url: string): string {
  try {
    const u = new URL(url);
    if (!u.searchParams.has('embed')) u.searchParams.set('embed', 'true');
    return u.toString();
  } catch {
    return url;
  }
}

export default function EmbedTask({
  task,
  onComplete,
}: {
  task: Task;
  onComplete: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [iframeLoading, setIframeLoading] = useState(true);
  const [iframeError, setIframeError] = useState(false);
  const [booked, setBooked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Defer the iframe until after mount so the Calendly embed-params
  // (which depend on window.location.host) don't cause a hydration mismatch.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Dev-only: ?test=fill exposes a "Simulate booking" button that creates
  // a synthetic Calls record + marks the task complete in one shot.
  // Skips Calendly entirely. Test endpoint is gated by env var server-side.
  const searchParams = useSearchParams();
  const testFillEnabled = searchParams?.get('test') === 'fill';
  const customerId = task.customer[0] ?? '';
  const [simulating, setSimulating] = useState(false);
  async function handleSimulateBooking() {
    setSimulating(true);
    setError(null);
    try {
      const res = await fetch('/api/test/simulate-call-booking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId, taskId: task.id }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw new Error(err?.error || `Simulate failed (${res.status})`);
      }
      setBooked(true);
      setTimeout(() => onComplete(), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Simulate failed');
    } finally {
      setSimulating(false);
    }
  }

  const isVideo =
    task.taskName.toLowerCase().includes('video') ||
    task.taskName.toLowerCase().includes('watch');

  const isCalendly = task.embedUrl?.includes('calendly.com') ?? false;
  const isHubSpotMeetings = task.embedUrl?.includes('meetings.hubspot.com') ?? false;
  const isBookingEmbed = isCalendly || isHubSpotMeetings;

  // For Calendly: append embed_domain + embed_type so postMessage events fire.
  // For HubSpot Meetings: append embed=true so the embedded UX fires events.
  // Other embeds (videos) pass through unchanged.
  const embedUrl = useMemo(() => {
    if (!mounted || !task.embedUrl) return '';
    if (isCalendly) return withCalendlyEmbedParams(task.embedUrl);
    if (isHubSpotMeetings) return withHubSpotMeetingsParams(task.embedUrl);
    return task.embedUrl;
  }, [mounted, task.embedUrl, isCalendly, isHubSpotMeetings]);

  const handleBookingConfirmed = useCallback(async () => {
    setBooked(true);
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'Completed' }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw new Error(err?.error || 'Booking saved but task status update failed. Please refresh.');
      }
      setTimeout(() => onComplete(), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong saving your booking.');
    } finally {
      setLoading(false);
    }
  }, [task.id, onComplete]);

  // Listen for booking confirmations from either scheduler.
  //
  // Calendly events: event.data.event === 'calendly.event_scheduled' (plus
  // 'calendly.profile_page_viewed' / 'calendly.event_type_viewed' as the
  // load-done signal).
  //
  // HubSpot Meetings events: event.data.meetingBookSucceeded === true.
  // HubSpot doesn't have a distinct "widget loaded" event we can reliably
  // catch — we dismiss the spinner on iframe onLoad instead.
  useEffect(() => {
    if (!isBookingEmbed) return;
    function handleMessage(event: MessageEvent) {
      // Calendly
      const calEv = event.data?.event;
      if (typeof calEv === 'string' && calEv.startsWith('calendly.')) {
        if (calEv === 'calendly.profile_page_viewed' || calEv === 'calendly.event_type_viewed') {
          setIframeLoading(false);
        }
        if (calEv === 'calendly.event_scheduled') {
          handleBookingConfirmed();
        }
        return;
      }
      // HubSpot Meetings
      if (event.data?.meetingBookSucceeded) {
        handleBookingConfirmed();
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [isBookingEmbed, handleBookingConfirmed]);

  async function handleComplete() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'Completed' }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw new Error(err?.error || 'Failed to mark task complete');
      }
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  // Booking confirmed state
  if (booked) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg bg-[#05C68E]/10 border border-[#05C68E]/20 px-5 py-4 space-y-2">
          <div className="flex items-center gap-3">
            <svg className="h-5 w-5 text-[#05C68E] shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
            </svg>
            <span className="text-sm font-semibold text-[#1B2E35]">
              Booking confirmed!
            </span>
          </div>
          <p className="text-sm text-[#1B2E35]/70 ml-8">
            A calendar invite is on its way to your inbox. Updating your portal…
          </p>
          <div className="ml-8 flex items-center gap-2 text-xs text-[#1B2E35]/50">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-[#6C4AB6]/30 border-t-[#6C4AB6]" />
            One moment
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {task.instructions && (
        <p className="text-[#1B2E35]/70 leading-relaxed">{task.instructions}</p>
      )}
      {testFillEnabled &&
        (isBookingEmbed || task.taskName.toLowerCase().includes('schedule your onboarding')) && (
        <div className="flex items-center justify-between rounded-lg border border-dashed border-[#6C4AB6]/40 bg-[#6C4AB6]/5 px-4 py-2 text-xs">
          <span className="text-[#6C4AB6]">
            Test mode — skip the scheduler and simulate a completed booking?
          </span>
          <button
            type="button"
            onClick={handleSimulateBooking}
            disabled={simulating || !customerId}
            className="rounded-full bg-[#6C4AB6] px-3 py-1 font-medium text-white hover:bg-[#5A3DA5] disabled:opacity-50"
          >
            {simulating ? 'Simulating…' : 'Simulate booking'}
          </button>
        </div>
      )}
      {task.embedUrl ? (
        <div className={`relative overflow-hidden rounded-lg border border-[#E0DEE4] ${isBookingEmbed ? 'h-[800px]' : 'h-[700px]'}`}>
          {iframeLoading && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-[#F7F4EB] gap-3">
              <span className="h-8 w-8 animate-spin rounded-full border-2 border-[#6C4AB6]/30 border-t-[#6C4AB6]" />
              <p className="text-sm text-[#1B2E35]/60">
                {isBookingEmbed ? 'Loading your booking calendar…' : 'Loading…'}
              </p>
              {isBookingEmbed && (
                <p className="text-xs text-[#1B2E35]/40">
                  This can take a few seconds
                </p>
              )}
            </div>
          )}
          {iframeError ? (
            <div className="flex items-center justify-center p-10 text-sm text-[#1B2E35]/60">
              Failed to load content. Please try refreshing the page.
            </div>
          ) : mounted && isHubSpotMeetings ? (
            // HubSpot Meetings: their script renders the iframe inside this div.
            <>
              <Script
                src="https://static.hsappstatic.net/MeetingsEmbed/ex/MeetingsEmbedCode.js"
                strategy="afterInteractive"
                onLoad={() => setIframeLoading(false)}
                onError={() => { setIframeLoading(false); setIframeError(true); }}
              />
              <div
                className="meetings-iframe-container w-full h-full"
                data-src={embedUrl}
              />
            </>
          ) : mounted ? (
            <iframe
              src={embedUrl}
              className="w-full h-full border-0"
              allow="camera; microphone; fullscreen"
              loading="lazy"
              onLoad={() => {
                // For non-Calendly embeds (videos), iframe.onLoad means ready.
                // For Calendly, we wait for postMessage events to confirm
                // the widget is interactive (handled in the effect above).
                if (!isCalendly) setIframeLoading(false);
              }}
              onError={() => { setIframeLoading(false); setIframeError(true); }}
            />
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-[#E0DEE4] p-10 text-center">
          <svg className="mb-3 h-10 w-10 text-[#E0DEE4]" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m9.86-9.86a4.5 4.5 0 0 0-6.364 0l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244" />
          </svg>
          <p className="text-sm text-[#1B2E35]/60">
            {isVideo ? 'Video will appear here once available.' : 'Booking link will appear here once available.'}
          </p>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-[#EC531A]/30 bg-[#EC531A]/5 px-4 py-3 text-sm text-[#EC531A]">
          {error}
        </div>
      )}

      {/* Hide Mark Complete for booking embeds — they auto-complete via postMessage. */}
      {!isBookingEmbed && (
        <button
          onClick={handleComplete}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-full bg-[#05C68E] px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#04946A] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? (
            <>
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
              Completing…
            </>
          ) : isVideo ? (
            "I've Watched This"
          ) : (
            'Mark Complete'
          )}
        </button>
      )}
    </div>
  );
}
