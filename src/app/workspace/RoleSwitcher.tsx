'use client';

import { useTransition } from 'react';
import { setViewAsRole } from './actions';

const ROLES = ['Designer', 'Senior Designer', 'CSM', 'Account Creator', 'Onboarding Ops', 'Sales'] as const;

export type ViewAsMember = {
  id: string;
  name: string;
  role: string;
};

export default function RoleSwitcher({
  current,
  members,
}: {
  current: string;
  members: ViewAsMember[];
}) {
  const [pending, startTransition] = useTransition();

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value;
    const fd = new FormData();
    fd.set('role', value);
    startTransition(() => {
      setViewAsRole(fd);
    });
  }

  return (
    <div className="flex items-center gap-2">
      <label className="text-xs text-[#1B2E35]/50">View as:</label>
      <select
        value={current}
        onChange={handleChange}
        disabled={pending}
        className="rounded-full border border-[#E0DEE4] bg-white px-3 py-1 text-xs text-[#1B2E35] focus:border-[#6C4AB6] focus:outline-none focus:ring-1 focus:ring-[#6C4AB6]/30 disabled:opacity-50 max-w-[14rem]"
      >
        <option value="">Admin (default)</option>
        <optgroup label="Role view">
          {ROLES.map((r) => (
            <option key={r} value={`role:${r}`}>
              {r}
            </option>
          ))}
        </optgroup>
        {members.length > 0 && (
          <optgroup label="Impersonate user">
            {members.map((m) => (
              <option key={m.id} value={`member:${m.id}`}>
                {m.name} ({m.role})
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </div>
  );
}
