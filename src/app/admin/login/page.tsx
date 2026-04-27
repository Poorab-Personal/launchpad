'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function AdminLoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');

    const res = await fetch('/api/admin-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });

    if (res.ok) {
      router.push('/admin');
    } else {
      setError('Invalid password');
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F7F4EB]">
      <div className="w-full max-w-sm">
        <div className="flex justify-center mb-6">
          <img
            src="https://rejig.ai/wp-content/themes/rejigchild/assets/images/rejig-logo-1.png"
            alt="Rejig.ai"
            className="h-8"
          />
        </div>
        <div className="rounded-lg border border-[#E0DEE4] bg-white p-8 shadow-[0px_4px_12px_#1B2E3514]">
          <h1 className="text-xl font-bold text-[#1B2E35] mb-1">LaunchPad Admin</h1>
          <p className="text-sm text-[#1B2E35]/60 mb-6">Enter password to continue</p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              autoFocus
              className="w-full rounded-lg border border-[#E0DEE4] bg-white px-3 py-2.5 text-sm text-[#1B2E35] placeholder:text-[#1B2E35]/40 focus:border-[#6C4AB6] focus:outline-none focus:ring-2 focus:ring-[#6C4AB6]/20"
            />
            {error && (
              <p className="text-sm text-[#EC531A]">{error}</p>
            )}
            <button
              type="submit"
              disabled={loading || !password}
              className="w-full rounded-full bg-[#05C68E] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#04946A] disabled:opacity-50"
            >
              {loading ? 'Checking...' : 'Sign In'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
