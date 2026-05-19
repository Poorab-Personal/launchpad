import Link from 'next/link';
import { requireSession, isAdminWriter } from '@/lib/auth/dal';
import { getTeamMemberById } from '@/lib/db';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const writer = isAdminWriter(session);
  const member = await getTeamMemberById(session.memberId);

  return (
    <div className="min-h-screen bg-[#F7F4EB] text-[#1B2E35]">
      <header className="border-b border-[#E0DEE4] bg-white">
        <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 lg:px-8 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link
              href="/admin"
              className="font-[var(--font-outfit)] text-lg font-semibold tracking-tight text-[#1B2E35] hover:text-[#6C4AB6] transition-colors"
            >
              LaunchPad Admin
            </Link>
            <Link
              href="/workspace"
              className="text-sm text-[#1B2E35]/70 hover:text-[#6C4AB6] transition-colors"
            >
              Workspace &rarr;
            </Link>
          </div>
          <div className="flex items-center gap-3">
            <span
              className={
                writer
                  ? 'inline-flex items-center rounded-full bg-[#05C68E]/15 px-2.5 py-0.5 text-xs font-medium text-[#04946A]'
                  : 'inline-flex items-center rounded-full bg-[#1B2E35]/10 px-2.5 py-0.5 text-xs font-medium text-[#1B2E35]/70'
              }
            >
              {writer ? 'Write access' : 'Read-only'}
            </span>
            <div className="text-right">
              <p className="text-sm font-medium text-[#1B2E35]">
                {member?.name ?? session.email}
              </p>
              <p className="text-xs text-[#1B2E35]/60">{session.role}</p>
            </div>
            <form action="/auth/signout" method="POST">
              <button
                type="submit"
                className="rounded-full border border-[#E0DEE4] px-3 py-1.5 text-xs text-[#1B2E35]/70 hover:bg-[#F7F4EB] hover:text-[#1B2E35] transition-colors"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        {children}
      </main>
    </div>
  );
}
