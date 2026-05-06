import { redirect } from 'next/navigation';
import { requireSession, getEffectiveContext } from '@/lib/auth/dal';

export default async function WorkspaceLanding() {
  const session = await requireSession();
  const ctx = await getEffectiveContext(session);

  // MVP: Designer queue is built. Admin (default) lands there too as overview.
  if (
    ctx.role === 'Designer' ||
    ctx.role === 'Senior Designer' ||
    ctx.role === 'Admin'
  ) {
    redirect('/workspace/queue');
  }

  // Sales: view-only over the customer list — see stage, copy portal link.
  if (ctx.role === 'Sales') {
    redirect('/workspace/customers');
  }

  // Other roles: placeholder until P1
  return (
    <div className="mx-auto max-w-2xl py-16 text-center">
      <h1 className="text-2xl font-bold text-[#1B2E35] mb-3">
        {ctx.label} workspace coming soon
      </h1>
      <p className="text-[#1B2E35]/70 mb-6">
        Your role-specific dashboard is under construction. For now, please
        continue using Airtable for {ctx.role} workflows.
      </p>
      <div className="inline-flex items-center gap-2 rounded-full bg-[#6C4AB6]/10 px-3 py-1.5 text-sm text-[#6C4AB6]">
        Role: {ctx.role}
      </div>
    </div>
  );
}
