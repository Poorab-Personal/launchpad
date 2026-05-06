'use client';

import { useTransition } from 'react';
import { setBookFilter } from './actions';

export type CSMOption = {
  id: string;
  name: string;
};

export default function BookFilter({
  current,
  csms,
}: {
  /** Cookie-formatted value: "my" | "unassigned" | "all" | "member:recXXX" */
  current: string;
  csms: CSMOption[];
}) {
  const [pending, startTransition] = useTransition();

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value;
    const fd = new FormData();
    fd.set('filter', value);
    startTransition(() => {
      setBookFilter(fd);
    });
  }

  return (
    <div className="flex items-center gap-2">
      <label className="text-xs text-[#1B2E35]/50">Show:</label>
      <select
        value={current}
        onChange={handleChange}
        disabled={pending}
        className="rounded-full border border-[#E0DEE4] bg-white px-3 py-1.5 text-sm text-[#1B2E35] focus:border-[#6C4AB6] focus:outline-none focus:ring-1 focus:ring-[#6C4AB6]/30 disabled:opacity-50 max-w-[16rem]"
      >
        <option value="my">My Book</option>
        <option value="unassigned">Unassigned</option>
        <option value="all">All customers</option>
        {csms.length > 0 && (
          <optgroup label="Other CSMs">
            {csms.map((m) => {
              const first = m.name.split(' ')[0];
              return (
                <option key={m.id} value={`member:${m.id}`}>
                  {first}&apos;s book
                </option>
              );
            })}
          </optgroup>
        )}
      </select>
    </div>
  );
}
