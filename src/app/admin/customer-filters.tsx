'use client';

import { useRouter, useSearchParams } from 'next/navigation';

const TYPES = ['D2C', 'B2B'];

export default function CustomerFilters() {
  const router = useRouter();
  const searchParams = useSearchParams();

  function handleChange(key: string, value: string) {
    const params = new URLSearchParams(searchParams);
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
    router.replace(`/admin?${params.toString()}`);
  }

  return (
    <div className="mb-4 flex gap-3">
      <select
        value={searchParams.get('type') ?? ''}
        onChange={(e) => handleChange('type', e.target.value)}
        className="rounded border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm text-gray-200"
      >
        <option value="">All Types</option>
        {TYPES.map((t) => (
          <option key={t} value={t}>{t}</option>
        ))}
      </select>
    </div>
  );
}
