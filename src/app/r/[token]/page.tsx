import { notFound } from 'next/navigation';
import { getCustomerByToken, getTasksForCustomer } from '@/lib/db';
import TaskList from '@/components/TaskList';

export const dynamic = 'force-dynamic';

export default async function PortalPage(props: PageProps<'/r/[token]'>) {
  const { token } = await props.params;

  const customer = await getCustomerByToken(token);
  if (!customer) notFound();

  const tasks = await getTasksForCustomer(customer.id);

  return (
    <div className="min-h-full bg-[#F7F4EB]">
      {/* Top bar with logo */}
      <div className="bg-white border-b border-[#E0DEE4]">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 py-4 flex items-center justify-between">
          <img
            src="https://rejig.ai/wp-content/themes/rejigchild/assets/images/rejig-logo-1.png"
            alt="Rejig.ai"
            className="h-8"
          />
          <div className="flex items-center gap-3">
            <span className="text-sm text-[#1B2E35]/60">{customer.name}</span>
            <span className="inline-flex items-center rounded-full bg-[#6C4AB6]/10 px-2.5 py-0.5 text-xs font-medium text-[#6C4AB6]">
              {customer.type}
            </span>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
        {/* Welcome header */}
        <header className="mb-8">
          <h1 className="text-2xl font-bold text-[#1B2E35]">
            Welcome, {customer.name.split(' ')[0]}
          </h1>
          {customer.businessName && (
            <p className="mt-1 text-sm text-[#1B2E35]/60">{customer.businessName}</p>
          )}
        </header>

        {/* Task list */}
        <TaskList
          initialTasks={tasks}
          customerId={customer.id}
          currentStage={customer.currentStage}
          customer={customer}
        />
      </div>
    </div>
  );
}
