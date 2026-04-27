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
        className="mb-6 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
        </svg>
        Add Customer
      </button>
    );
  }

  return (
    <div className="mb-6 rounded-lg border border-gray-700 bg-gray-900 p-5">
      <h2 className="mb-4 text-lg font-semibold text-white">Add Customer</h2>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1 block text-sm text-gray-400">Name</label>
            <input
              name="name"
              required
              className="w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
              placeholder="Jane Smith"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-gray-400">Email</label>
            <input
              name="email"
              type="email"
              required
              className="w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
              placeholder="jane@example.com"
            />
          </div>
          <div className="col-span-2">
            <label className="mb-1 block text-sm text-gray-400">Workflow</label>
            <select
              required
              value={selectedWorkflow}
              onChange={(e) => setSelectedWorkflow(e.target.value)}
              className="w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none"
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
            <label className="mb-1 block text-sm text-gray-400">Business Name <span className="text-gray-600">(optional)</span></label>
            <input
              name="businessName"
              className="w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
              placeholder="Acme Realty"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-gray-400">Website <span className="text-gray-600">(optional)</span></label>
            <input
              name="website"
              type="url"
              className="w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
              placeholder="https://example.com"
            />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={loading || !selectedWorkflow}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {loading ? 'Creating...' : 'Create Customer'}
          </button>
          <button
            type="button"
            onClick={() => { setOpen(false); setResult(null); setSelectedWorkflow(''); }}
            className="text-sm text-gray-400 hover:text-gray-300"
          >
            Cancel
          </button>
          {result && (
            <span className="text-sm text-green-400">
              Created with {result.tasksCreated} tasks.{' '}
              <a
                href={`/r/${result.id}`}
                target="_blank"
                className="underline hover:text-green-300"
              >
                Portal link
              </a>
            </span>
          )}
        </div>
      </form>
    </div>
  );
}
