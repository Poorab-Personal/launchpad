import { notFound } from 'next/navigation';
import { getCustomerByToken, getTasksForCustomer } from '@/lib/airtable';
import TaskList from '@/components/TaskList';

export const dynamic = 'force-dynamic';

export default async function PortalPage(props: PageProps<'/r/[token]'>) {
  const { token } = await props.params;

  const customer = await getCustomerByToken(token);
  if (!customer) notFound();

  const tasks = await getTasksForCustomer(customer.id);

  return (
    <div className="min-h-full bg-[#F7F4EB]">
      <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6 sm:py-16">
        {/* Header */}
        <header className="mb-10">
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold text-[#1B2E35]">
              Welcome, {customer.name.split(' ')[0]}
            </h1>
            <span className="inline-flex items-center rounded-full bg-[#6C4AB6] px-2.5 py-0.5 text-xs font-medium text-white">
              {customer.type}
            </span>
          </div>
          {customer.businessName && (
            <p className="text-sm text-[#1B2E35]/60">{customer.businessName}</p>
          )}
        </header>

        {/* Task list (client component) */}
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
