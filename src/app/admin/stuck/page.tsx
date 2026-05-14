import Link from 'next/link';
import {
  getStuckCustomers,
  STUCK_THRESHOLD_DAYS,
  STUCK_WORKFLOW_KEYS,
  type StuckThreshold,
  type StuckWorkflowKey,
} from '@/lib/db';

// HubSpot portal ID for Rejig — same constant as /admin/[customerId]/page.tsx.
const HUBSPOT_PORTAL_ID = '44956899';

function hubspotTicketUrl(id: string): string | null {
  if (!id) return null;
  return `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-5/${id}`;
}

function isValidWorkflow(s: string | undefined): s is StuckWorkflowKey {
  return !!s && (STUCK_WORKFLOW_KEYS as readonly string[]).includes(s);
}

function isValidThreshold(n: number): n is StuckThreshold {
  return (STUCK_THRESHOLD_DAYS as readonly number[]).includes(n);
}

/**
 * Drill-down: customers stuck in pre-launch stages beyond a threshold,
 * filtered by workflow. Linked from the Stuck Customers tile on /admin.
 *
 * Read-only. No mutations. Pure SQL view over `customers`. Phase 4 BI
 * cron will eventually replace this with an attention_reason-keyed view.
 */
export default async function StuckCustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ workflow?: string; threshold?: string; noCard?: string }>;
}) {
  const params = await searchParams;
  const workflow = isValidWorkflow(params.workflow) ? params.workflow : 'D2C-Standard';
  const thresholdRaw = Number(params.threshold);
  const threshold: StuckThreshold = isValidThreshold(thresholdRaw) ? thresholdRaw : 3;
  const noCardOnly = params.noCard === '1' && workflow === 'B2B-Keyes' && threshold === 7;

  const rows = await getStuckCustomers({
    workflowKey: workflow,
    thresholdDays: threshold,
    noCardOnly,
  });

  return (
    <div>
      <Link
        href="/admin"
        className="mb-4 inline-flex items-center gap-1 text-sm text-[#6C4AB6] hover:text-[#6C4AB6]/80 transition-colors"
      >
        &larr; Back to customers
      </Link>

      <div className="mb-6">
        <h1 className="font-[var(--font-outfit)] text-2xl font-bold text-[#1B2E35]">
          Stuck Customers
        </h1>
        <p className="mt-1 text-sm text-[#1B2E35]/60">
          Pre-launch customers whose current stage was entered more than {threshold} days ago.
        </p>
      </div>

      {/* Filter bar — workflow + threshold + (optional) no-card toggle */}
      <div className="mb-6 rounded-lg border border-[#E0DEE4] bg-white p-4 shadow-[0px_4px_12px_#1B2E3514]">
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-[#1B2E35]/54">Workflow:</span>
            <div className="flex gap-1.5">
              {STUCK_WORKFLOW_KEYS.map((wk) => (
                <Link
                  key={wk}
                  href={`/admin/stuck?workflow=${encodeURIComponent(wk)}&threshold=${threshold}`}
                  className={`rounded-full px-2.5 py-0.5 font-mono text-xs transition-colors ${
                    wk === workflow
                      ? 'bg-[#6C4AB6] text-white'
                      : 'bg-[#6C4AB6]/10 text-[#6C4AB6] hover:bg-[#6C4AB6]/20'
                  }`}
                >
                  {wk}
                </Link>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[#1B2E35]/54">Threshold:</span>
            <div className="flex gap-1.5">
              {STUCK_THRESHOLD_DAYS.map((t) => (
                <Link
                  key={t}
                  href={`/admin/stuck?workflow=${encodeURIComponent(workflow)}&threshold=${t}`}
                  className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
                    t === threshold
                      ? t === 7
                        ? 'bg-[#EC531A] text-white'
                        : 'bg-[#DABA21] text-white'
                      : 'bg-[#E0DEE4]/50 text-[#1B2E35]/70 hover:bg-[#E0DEE4]'
                  }`}
                >
                  &gt;{t}d
                </Link>
              ))}
            </div>
          </div>

          {workflow === 'B2B-Keyes' && threshold === 7 && (
            <div className="flex items-center gap-2">
              <Link
                href={
                  noCardOnly
                    ? `/admin/stuck?workflow=B2B-Keyes&threshold=7`
                    : `/admin/stuck?workflow=B2B-Keyes&threshold=7&noCard=1`
                }
                className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
                  noCardOnly
                    ? 'bg-[#EC531A] text-white'
                    : 'bg-[#EC531A]/10 text-[#EC531A] hover:bg-[#EC531A]/20'
                }`}
              >
                {noCardOnly ? 'No-card only' : 'Show no-card only'}
              </Link>
            </div>
          )}

          <div className="ml-auto text-xs text-[#1B2E35]/40">
            {rows.length} customer{rows.length !== 1 ? 's' : ''}
          </div>
        </div>
      </div>

      {/* Results table */}
      <div className="overflow-x-auto rounded-lg border border-[#E0DEE4] bg-white shadow-[0px_4px_12px_#1B2E3514]">
        <table className="min-w-full divide-y divide-[#E0DEE4]">
          <thead className="bg-[#F7F4EB]">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[#1B2E35]/54">
                Name
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[#1B2E35]/54">
                Workflow
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[#1B2E35]/54">
                Current Stage
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[#1B2E35]/54">
                Days Stuck
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[#1B2E35]/54">
                Stage Entered
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[#1B2E35]/54">
                Card
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[#1B2E35]/54">
                Links
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#E0DEE4] bg-white">
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-8 text-center text-sm text-[#1B2E35]/40"
                >
                  No customers match this filter.
                </td>
              </tr>
            ) : (
              rows.map((c) => {
                const ticketUrl = hubspotTicketUrl(c.hubspotTicketId);
                const cardClass =
                  c.workflowKey === 'B2B-Keyes' && !c.stripeSubscriptionId
                    ? 'text-[#EC531A] font-medium'
                    : c.stripeSubscriptionId
                      ? 'text-[#05C68E]'
                      : 'text-[#1B2E35]/40';
                const cardLabel =
                  c.workflowKey === 'B2B-Keyes'
                    ? c.stripeSubscriptionId
                      ? 'On file'
                      : 'Missing'
                    : '—';
                return (
                  <tr key={c.id} className="hover:bg-[#F7F4EB]/60 transition-colors">
                    <td className="whitespace-nowrap px-4 py-3">
                      <Link
                        href={`/admin/${c.id}`}
                        className="font-medium text-[#6C4AB6] hover:text-[#6C4AB6]/80 transition-colors"
                      >
                        {c.name}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-[#1B2E35]/70">
                      {c.workflowKey}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-[#1B2E35]/70">
                      {c.currentStage}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                          c.daysStuck >= 7
                            ? 'bg-[#EC531A]/10 text-[#EC531A]'
                            : 'bg-[#DABA21]/10 text-[#DABA21]'
                        }`}
                      >
                        {c.daysStuck}d
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-[#1B2E35]/60">
                      {c.stageEnteredAt
                        ? new Date(c.stageEnteredAt).toLocaleDateString()
                        : '—'}
                    </td>
                    <td className={`whitespace-nowrap px-4 py-3 text-xs ${cardClass}`}>
                      {cardLabel}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm">
                      <a
                        href={`/r/${c.accessToken}`}
                        target="_blank"
                        className="text-[#05C68E] hover:text-[#04946A] font-medium transition-colors"
                      >
                        Portal &rarr;
                      </a>
                      {ticketUrl ? (
                        <a
                          href={ticketUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ml-3 text-[#6C4AB6] hover:text-[#6C4AB6]/80 font-medium transition-colors"
                        >
                          HubSpot &rarr;
                        </a>
                      ) : (
                        <span className="ml-3 text-[#1B2E35]/30 text-xs">no ticket</span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
