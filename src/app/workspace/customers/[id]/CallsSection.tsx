import { connection } from 'next/server';
import { getCallsForCustomer, getTeamMembers } from '@/lib/airtable';
import type { Call, CallStatus, TeamMember } from '@/types';
import CallNotesEditor from './CallNotesEditor';

const NOTES_PREVIEW_LIMIT = 200;

const STATUS_STYLES: Record<CallStatus, string> = {
  Scheduled: 'bg-[#6C4AB6]/10 text-[#6C4AB6]',
  Completed: 'bg-[#05C68E]/10 text-[#04946A]',
  'No Show': 'bg-[#EC531A]/10 text-[#EC531A]',
  Rescheduled: 'bg-[#D97706]/10 text-[#D97706]',
  Canceled: 'bg-[#1B2E35]/10 text-[#1B2E35]/60',
};

function StatusBadge({ status }: { status: CallStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[status] ?? STATUS_STYLES.Scheduled}`}
    >
      {status}
    </span>
  );
}

function formatDateTime(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${date} · ${time}`;
}

function buildCalendlyEventUrl(uuid: string): string | null {
  if (!uuid) return null;
  // Calendly's user-facing event URL pattern.
  return `https://calendly.com/events/${uuid}`;
}

/**
 * Partition calls into upcoming (Scheduled + future) vs. past.
 * Lives outside the component so React's purity rules don't flag the
 * `Date.now()` call here as a render-time impurity.
 */
function partitionCalls(calls: Call[]): { upcoming: Call[]; past: Call[] } {
  const now = Date.now();
  const upcoming: Call[] = [];
  const past: Call[] = [];
  for (const call of calls) {
    const t = Date.parse(call.scheduledDate);
    const isFuture = !Number.isNaN(t) && t >= now;
    if (call.status === 'Scheduled' && isFuture) {
      upcoming.push(call);
    } else {
      past.push(call);
    }
  }
  upcoming.sort((a, b) => (a.scheduledDate || '').localeCompare(b.scheduledDate || ''));
  past.sort((a, b) => (b.scheduledDate || '').localeCompare(a.scheduledDate || ''));
  return { upcoming, past };
}

function MemberNames({
  ids,
  members,
}: {
  ids: string[];
  members: Map<string, TeamMember>;
}) {
  if (ids.length === 0) return <span className="text-[#1B2E35]/40">—</span>;
  return (
    <span>
      {ids
        .map((id) => members.get(id)?.name ?? id)
        .join(', ')}
    </span>
  );
}

function NotesDisplay({ notes }: { notes: string }) {
  if (!notes) return null;
  if (notes.length <= NOTES_PREVIEW_LIMIT) {
    return (
      <p className="text-sm text-[#1B2E35]/70 whitespace-pre-wrap mt-2">{notes}</p>
    );
  }
  return (
    <details className="mt-2">
      <summary className="cursor-pointer list-none">
        <p className="text-sm text-[#1B2E35]/70 whitespace-pre-wrap">
          {notes.slice(0, NOTES_PREVIEW_LIMIT)}
          <span className="text-[#6C4AB6] hover:underline ml-1">… show more</span>
        </p>
      </summary>
      <p className="text-sm text-[#1B2E35]/70 whitespace-pre-wrap mt-2">{notes}</p>
    </details>
  );
}

function UpcomingCallRow({
  call,
  customerId,
  members,
  canEdit,
}: {
  call: Call;
  customerId: string;
  members: Map<string, TeamMember>;
  canEdit: boolean;
}) {
  const calendlyUrl = buildCalendlyEventUrl(call.calendlyEventUuid);
  return (
    <li className="rounded-lg border border-[#E0DEE4] bg-white p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-[#1B2E35]">{call.type}</p>
            <StatusBadge status={call.status} />
          </div>
          <p className="text-xs text-[#1B2E35]/60 mt-0.5">
            {formatDateTime(call.scheduledDate)}
          </p>
          <p className="text-xs text-[#1B2E35]/50 mt-0.5">
            CSM: <MemberNames ids={call.csm} members={members} />
          </p>
        </div>
        {calendlyUrl && (
          <a
            href={calendlyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-[#6C4AB6] hover:underline"
          >
            View on Calendly →
          </a>
        )}
      </div>
      {canEdit && (
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-[11px] uppercase tracking-wide text-[#1B2E35]/50 font-medium mb-1">
              Notes
            </label>
            <CallNotesEditor
              callId={call.id}
              customerId={customerId}
              initialValue={call.notes}
              field="notes"
              rows={2}
            />
          </div>
          <div>
            <label className="block text-[11px] uppercase tracking-wide text-[#1B2E35]/50 font-medium mb-1">
              Recording URL
            </label>
            <CallNotesEditor
              callId={call.id}
              customerId={customerId}
              initialValue={call.recordingUrl}
              field="recording"
            />
          </div>
        </div>
      )}
      {!canEdit && call.notes && <NotesDisplay notes={call.notes} />}
    </li>
  );
}

function PastCallRow({
  call,
  customerId,
  members,
  canEdit,
}: {
  call: Call;
  customerId: string;
  members: Map<string, TeamMember>;
  canEdit: boolean;
}) {
  return (
    <li className="rounded-lg border border-[#E0DEE4] bg-white p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-[#1B2E35]">{call.type}</p>
            <StatusBadge status={call.status} />
          </div>
          <p className="text-xs text-[#1B2E35]/60 mt-0.5">
            {formatDateTime(call.scheduledDate)}
          </p>
          <p className="text-xs text-[#1B2E35]/50 mt-0.5">
            CSM: <MemberNames ids={call.csm} members={members} />
          </p>
        </div>
        {call.recordingUrl && !canEdit && (
          <a
            href={call.recordingUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-[#6C4AB6] hover:underline"
          >
            Recording →
          </a>
        )}
      </div>
      {canEdit ? (
        <div className="mt-3 space-y-3">
          <div>
            <label className="block text-[11px] uppercase tracking-wide text-[#1B2E35]/50 font-medium mb-1">
              Notes
            </label>
            <CallNotesEditor
              callId={call.id}
              customerId={customerId}
              initialValue={call.notes}
              field="notes"
              rows={3}
            />
          </div>
          <div>
            <label className="block text-[11px] uppercase tracking-wide text-[#1B2E35]/50 font-medium mb-1">
              Recording URL
            </label>
            <CallNotesEditor
              callId={call.id}
              customerId={customerId}
              initialValue={call.recordingUrl}
              field="recording"
            />
          </div>
        </div>
      ) : (
        <NotesDisplay notes={call.notes} />
      )}
    </li>
  );
}

/**
 * Past + upcoming Calls for one customer.
 *
 * `canEdit` should be true for CSM/Senior CSM/Admin sessions; passed in by
 * the parent so this component doesn't need to re-do role checks. The
 * server actions still gate by role server-side.
 */
export default async function CallsSection({
  customerId,
  canEdit,
}: {
  customerId: string;
  canEdit: boolean;
}) {
  // Opt out of static rendering — this section reflects "now" in past/upcoming
  // bucketing, so it must run per-request.
  await connection();

  const [calls, members] = await Promise.all([
    getCallsForCustomer(customerId),
    getTeamMembers(),
  ]);

  const memberMap = new Map<string, TeamMember>(members.map((m) => [m.id, m]));
  const { upcoming, past } = partitionCalls(calls);

  return (
    <section className="rounded-xl bg-white border border-[#E0DEE4] p-6">
      <div className="mb-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-[#1B2E35]/70">
          Calls
        </h2>
        <p className="text-xs text-[#1B2E35]/50 mt-0.5">
          Scheduled and completed calls with this customer.
        </p>
      </div>

      <div className="space-y-6">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-[#1B2E35]/60 mb-2">
            Upcoming ({upcoming.length})
          </h3>
          {upcoming.length === 0 ? (
            <p className="text-sm text-[#1B2E35]/40 italic">No upcoming calls.</p>
          ) : (
            <ul className="space-y-2">
              {upcoming.map((call) => (
                <UpcomingCallRow
                  key={call.id}
                  call={call}
                  customerId={customerId}
                  members={memberMap}
                  canEdit={canEdit}
                />
              ))}
            </ul>
          )}
        </div>

        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-[#1B2E35]/60 mb-2">
            Past ({past.length})
          </h3>
          {past.length === 0 ? (
            <p className="text-sm text-[#1B2E35]/40 italic">No past calls yet.</p>
          ) : (
            <ul className="space-y-2">
              {past.map((call) => (
                <PastCallRow
                  key={call.id}
                  call={call}
                  customerId={customerId}
                  members={memberMap}
                  canEdit={canEdit}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
