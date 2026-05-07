'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Workflow {
  workflowKey: string;
  type: string;
  channel: string;
}

export default function AddCustomerForm({ workflows }: { workflows: Workflow[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ id: string; tasksCreated: number } | null>(null);
  const [selectedWorkflow, setSelectedWorkflow] = useState('');

  const d2cWorkflows = workflows.filter((w) => w.type === 'D2C');
  const b2bWorkflows = workflows.filter((w) => w.type === 'B2B');

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setResult(null);

    const wf = workflows.find((w) => w.workflowKey === selectedWorkflow);
    if (!wf) return;

    const form = new FormData(e.currentTarget);
    const data: Record<string, string> = {
      name: form.get('name') as string,
      type: wf.type,
      channel: wf.channel,
      email: form.get('email') as string,
    };
    const businessName = (form.get('businessName') as string) || '';
    const website = (form.get('website') as string) || '';
    if (businessName) data.businessName = businessName;
    if (website) data.website = website;

    // Add-on flags
    const hasVoice = form.get('hasVoice') === 'on';
    const hasAvatar = form.get('hasAvatar') === 'on';
    if (hasVoice) (data as Record<string, unknown>).hasVoice = true;
    if (hasAvatar) (data as Record<string, unknown>).hasAvatar = true;

    const res = await fetch('/api/customers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

    const json = await res.json();
    setLoading(false);
    setResult({ id: json.id, tasksCreated: json.tasksCreated });
    router.refresh();
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mb-6 inline-flex items-center gap-2 rounded-full bg-[#05C68E] px-5 py-2.5 text-sm font-medium text-white hover:bg-[#04946A] transition-colors"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
        </svg>
        Add Customer
      </button>
    );
  }

  return (
    <div className="mb-6 rounded-lg border border-[#E0DEE4] bg-white p-5 shadow-[0px_4px_12px_#1B2E3514]">
      <h2 className="mb-4 font-[var(--font-outfit)] text-lg font-semibold text-[#1B2E35]">Add Customer</h2>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1 block text-sm font-semibold text-[#1B2E35]/87">Name</label>
            <input
              name="name"
              required
              className="w-full rounded-lg border border-[#E0DEE4] bg-white px-3 py-2 text-sm text-[#1B2E35] placeholder:text-[#1B2E35]/40 focus:border-[#6C4AB6] focus:outline-none focus:ring-2 focus:ring-[#6C4AB6]/20"
              placeholder="Jane Smith"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-semibold text-[#1B2E35]/87">Email</label>
            <input
              name="email"
              type="email"
              required
              className="w-full rounded-lg border border-[#E0DEE4] bg-white px-3 py-2 text-sm text-[#1B2E35] placeholder:text-[#1B2E35]/40 focus:border-[#6C4AB6] focus:outline-none focus:ring-2 focus:ring-[#6C4AB6]/20"
              placeholder="jane@example.com"
            />
          </div>
          <div className="col-span-2">
            <label className="mb-1 block text-sm font-semibold text-[#1B2E35]/87">Workflow</label>
            <select
              required
              value={selectedWorkflow}
              onChange={(e) => setSelectedWorkflow(e.target.value)}
              className="w-full rounded-lg border border-[#E0DEE4] bg-white px-3 py-2 text-sm text-[#1B2E35] focus:border-[#6C4AB6] focus:outline-none focus:ring-2 focus:ring-[#6C4AB6]/20"
            >
              <option value="">Select a workflow...</option>
              {d2cWorkflows.length > 0 && (
                <optgroup label="D2C">
                  {d2cWorkflows.map((w) => (
                    <option key={w.workflowKey} value={w.workflowKey}>
                      {w.channel}
                    </option>
                  ))}
                </optgroup>
              )}
              {b2bWorkflows.length > 0 && (
                <optgroup label="B2B">
                  {b2bWorkflows.map((w) => (
                    <option key={w.workflowKey} value={w.workflowKey}>
                      {w.channel}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-semibold text-[#1B2E35]/87">Business Name <span className="text-[#1B2E35]/40">(optional)</span></label>
            <input
              name="businessName"
              className="w-full rounded-lg border border-[#E0DEE4] bg-white px-3 py-2 text-sm text-[#1B2E35] placeholder:text-[#1B2E35]/40 focus:border-[#6C4AB6] focus:outline-none focus:ring-2 focus:ring-[#6C4AB6]/20"
              placeholder="Acme Realty"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-semibold text-[#1B2E35]/87">Website <span className="text-[#1B2E35]/40">(optional)</span></label>
            <input
              name="website"
              type="url"
              className="w-full rounded-lg border border-[#E0DEE4] bg-white px-3 py-2 text-sm text-[#1B2E35] placeholder:text-[#1B2E35]/40 focus:border-[#6C4AB6] focus:outline-none focus:ring-2 focus:ring-[#6C4AB6]/20"
              placeholder="https://example.com"
            />
          </div>
          <div className="col-span-2 flex gap-6">
            <label className="flex items-center gap-2 text-sm text-[#1B2E35]/70 cursor-pointer">
              <input type="checkbox" name="hasVoice" className="rounded border-[#E0DEE4] bg-white text-[#6C4AB6] focus:ring-[#6C4AB6]/30" />
              Has Voice Add-On
            </label>
            <label className="flex items-center gap-2 text-sm text-[#1B2E35]/70 cursor-pointer">
              <input type="checkbox" name="hasAvatar" className="rounded border-[#E0DEE4] bg-white text-[#6C4AB6] focus:ring-[#6C4AB6]/30" />
              Has Avatar Add-On
            </label>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={loading || !selectedWorkflow}
            className="inline-flex items-center gap-2 rounded-full bg-[#05C68E] px-5 py-2.5 text-sm font-medium text-white hover:bg-[#04946A] transition-colors disabled:opacity-50"
          >
            {loading ? 'Creating...' : 'Create Customer'}
          </button>
          <button
            type="button"
            onClick={() => { setOpen(false); setResult(null); setSelectedWorkflow(''); }}
            className="text-sm text-[#1B2E35]/60 hover:text-[#1B2E35] transition-colors"
          >
            Cancel
          </button>
          {result && (
            <span className="text-sm text-[#05C68E] font-medium">
              Created with {result.tasksCreated} tasks.{' '}
              <a
                href={`/r/${result.id}`}
                target="_blank"
                className="underline hover:text-[#04946A]"
              >
                Portal link
              </a>
              {' · '}
              <a
                href={`/r/${result.id}?test=fill`}
                target="_blank"
                className="underline text-[#6C4AB6]/80 hover:text-[#6C4AB6]"
                title="Opens portal with auto-fill button enabled"
              >
                Portal (test)
              </a>
            </span>
          )}
        </div>
      </form>
    </div>
  );
}
