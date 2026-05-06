import Link from 'next/link';
import { requireSession, getEffectiveContext } from '@/lib/auth/dal';
import { getTeamMemberById, getTeamMembers } from '@/lib/airtable';
import { readViewAs } from '@/lib/auth/view-as';
import RoleSwitcher from './RoleSwitcher';

export default async function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireSession();
  const [member, view, effective, allMembers] = await Promise.all([
    getTeamMemberById(session.memberId),
    readViewAs(),
    getEffectiveContext(session),
    session.role === 'Admin' ? getTeamMembers() : Promise.resolve([]),
  ]);

  // Compute the current select value for the switcher
  let switcherValue = '';
  if (view.kind === 'role') switcherValue = `role:${view.role}`;
  if (view.kind === 'member') switcherValue = `member:${view.memberId}`;

  // Active members only, excluding self (no point impersonating yourself)
  const switcherMembers = allMembers
    .filter((m) => m.active && m.id !== session.memberId)
    .map((m) => ({ id: m.id, name: m.name, role: m.role }));

  return (
    <div className="min-h-screen bg-[#F7F4EB] text-[#1B2E35]">
      <header className="border-b border-[#E0DEE4] bg-white">
        <div className="mx-auto max-w-7xl px-4 py-3 sm:px-6 lg:px-8 flex items-center justify-between gap-4">
          <div className="flex items-center gap-6">
            <Link
              href="/workspace"
              className="font-[var(--font-outfit)] text-lg font-semibold tracking-tight text-[#1B2E35] hover:text-[#6C4AB6] transition-colors"
            >
              LaunchPad
            </Link>
            <nav className="hidden sm:flex items-center gap-4 text-sm">
              <Link
                href="/workspace/queue"
                className="text-[#1B2E35]/70 hover:text-[#6C4AB6] transition-colors"
              >
                Design Queue
              </Link>
              <Link
                href="/workspace/book"
                className="text-[#1B2E35]/70 hover:text-[#6C4AB6] transition-colors"
              >
                CSM Book
              </Link>
              <Link
                href="/workspace/account-queue"
                className="text-[#1B2E35]/70 hover:text-[#6C4AB6] transition-colors"
              >
                Account Queue
              </Link>
              <Link
                href="/workspace/customers"
                className="text-[#1B2E35]/70 hover:text-[#6C4AB6] transition-colors"
              >
                All Customers
              </Link>
            </nav>
          </div>
          <div className="flex items-center gap-3">
            {session.role === 'Admin' && (
              <RoleSwitcher current={switcherValue} members={switcherMembers} />
            )}
            <div className="text-right">
              <p className="text-sm font-medium text-[#1B2E35]">
                {member?.name ?? session.email}
              </p>
              <p className="text-xs text-[#1B2E35]/60">
                {effective.isViewAs ? (
                  <span className="text-[#6C4AB6]">Viewing as {effective.label}</span>
                ) : (
                  session.role
                )}
              </p>
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
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">{children}</main>
    </div>
  );
}
