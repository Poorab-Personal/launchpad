import Link from 'next/link';
import { setViewAsRole } from '@/app/workspace/actions';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#F7F4EB] text-[#1B2E35]">
      <header className="border-b border-[#E0DEE4] bg-white">
        <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 lg:px-8 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/admin" className="font-[var(--font-outfit)] text-lg font-semibold tracking-tight text-[#1B2E35] hover:text-[#6C4AB6] transition-colors">
              LaunchPad Admin
            </Link>
            {/* Submitting an empty "role" clears any lingering view-as cookie
                and redirects to /workspace, so jumping from /admin always
                lands as Admin (not whatever role was last impersonated). */}
            <form action={setViewAsRole}>
              <input type="hidden" name="role" value="" />
              <button
                type="submit"
                className="text-sm text-[#1B2E35]/70 hover:text-[#6C4AB6] transition-colors"
              >
                Workspace &rarr;
              </button>
            </form>
          </div>
          <span className="inline-flex items-center rounded-full bg-[#6C4AB6]/10 px-2.5 py-0.5 text-xs font-medium text-[#6C4AB6]">
            Admin
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        {children}
      </main>
    </div>
  );
}
