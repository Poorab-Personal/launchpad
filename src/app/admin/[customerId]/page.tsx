import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getCustomerById, getTasksForCustomer, getTeamMembers, getBrokerageById } from '@/lib/airtable';
import type { TaskStatus } from '@/types';

const statusColor: Record<TaskStatus, string> = {
  Draft: 'bg-gray-700 text-gray-300',
  Active: 'bg-blue-900 text-blue-300',
  'In Review': 'bg-yellow-900 text-yellow-300',
  Completed: 'bg-green-900 text-green-300',
  Rejected: 'bg-red-900 text-red-300',
};

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ customerId: string }>;
}) {
  const { customerId } = await params;
  const customer = await getCustomerById(customerId);

  if (!customer) {
    notFound();
  }

  const tasks = await getTasksForCustomer(customer.id);
  const teamMembers = await getTeamMembers();
  const memberNameMap = new Map(teamMembers.map((m) => [m.id, m.name]));
  const brokerageName = customer.type === 'B2B' && customer.brokerage.length > 0
    ? (await getBrokerageById(customer.brokerage[0]))?.name ?? ''
    : '';

  return (
    <div>
      <Link href="/admin" className="mb-4 inline-block text-sm text-gray-400 hover:text-gray-200">
        &larr; Back to customers
      </Link>

      {/* Customer header */}
      <div className="mb-6 rounded-lg border border-gray-800 bg-gray-900 p-6">
        <h1 className="mb-1 text-2xl font-bold text-white">{customer.name}</h1>
        {customer.businessName && (
          <p className="text-sm text-gray-400">{customer.businessName}</p>
        )}
      </div>

      {/* Identity */}
      <Section title="Identity">
        <Field label="Type" value={customer.type} />
        <Field label="Channel" value={customer.channel} />
        <Field label="Contact Email" value={customer.contactEmail} />
        <Field label="Platform Email" value={customer.platformEmail} />
        <Field label="Phone" value={customer.phone} />
      </Section>

      {/* Business Info */}
      {(customer.businessName || customer.website || customer.bio) && (
        <Section title="Business Info">
          <Field label="Business Name" value={customer.businessName} />
          <Field label="Website" value={customer.website} />
          <Field label="Business Address" value={customer.businessAddress} />
          <Field label="Service Areas" value={customer.serviceAreas} />
          <Field label="Bio" value={customer.bio} />
          <Field label="License Number" value={customer.licenseNumber} />
        </Section>
      )}

      {/* Assets */}
      {(customer.agentPhoto.length > 0 || customer.businessLogo.length > 0 || customer.otherAssets.length > 0) && (
        <Section title="Assets">
          <Field label="Agent Photo" value={customer.agentPhoto.length > 0 ? `${customer.agentPhoto.length} file(s)` : ''} />
          <Field label="Business Logo" value={customer.businessLogo.length > 0 ? `${customer.businessLogo.length} file(s)` : ''} />
          <Field label="Other Assets" value={customer.otherAssets.length > 0 ? `${customer.otherAssets.length} file(s)` : ''} />
        </Section>
      )}

      {/* Payment (D2C only) */}
      {customer.type === 'D2C' && (
        <Section title="Payment">
          <Field label="Product Tier" value={customer.productTier ?? ''} />
          <Field label="Payment Status" value={customer.paymentStatus ?? ''} />
          <Field label="HubSpot Deal ID" value={customer.hubspotDealId} />
          <Field label="Stripe Payment ID" value={customer.stripePaymentId} />
        </Section>
      )}

      {/* Design (D2C only) */}
      {customer.type === 'D2C' && customer.designApproval && (
        <Section title="Design">
          <Field label="Design Approval" value={customer.designApproval} />
          <Field label="Design Feedback" value={customer.designFeedback} />
        </Section>
      )}

      {/* Enterprise (B2B only) */}
      {customer.type === 'B2B' && (
        <Section title="Enterprise">
          <Field label="Brokerage" value={brokerageName} />
        </Section>
      )}

      {/* Status */}
      <Section title="Status">
        <Field label="Current Stage" value={customer.currentStage} />
        <Field label="Stage Entered At" value={customer.stageEnteredAt ? new Date(customer.stageEnteredAt).toLocaleDateString() : ''} />
        <Field label="Account Created" value={customer.accountCreated ? 'Yes' : 'No'} />
        <Field label="Credentials Sent" value={customer.credentialsSent ? 'Yes' : 'No'} />
        <Field label="Call Booked" value={customer.callBooked ? 'Yes' : 'No'} />
        <Field label="Call Completed" value={customer.callCompleted ? 'Yes' : 'No'} />
        <Field label="CSM Assigned" value={customer.csmAssigned.length > 0 ? memberNameMap.get(customer.csmAssigned[0]) ?? customer.csmAssigned[0] : ''} />
      </Section>

      {/* Tasks */}
      <h2 className="mt-8 mb-3 text-lg font-semibold text-white">Tasks ({tasks.length})</h2>
      <div className="mb-8 overflow-x-auto rounded-lg border border-gray-800">
        <table className="min-w-full divide-y divide-gray-800">
          <thead className="bg-gray-900">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-400">Task Name</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-400">Type</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-400">Stage</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-400">Status</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-400">Assigned To</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-400">Depends On</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800 bg-gray-950">
            {tasks.map((task) => (
              <tr key={task.id} className="hover:bg-gray-900">
                <td className="whitespace-nowrap px-4 py-3 text-sm font-medium text-gray-200">
                  <span className="flex items-center gap-2">
                    {task.taskName}
                    {task.hasTeamReview && (
                      <span className="inline-flex rounded-full bg-amber-900/50 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">Review</span>
                    )}
                  </span>
                  {task.embedUrl && (
                    <a href={task.embedUrl} target="_blank" rel="noopener noreferrer" className="block text-xs text-blue-400 hover:text-blue-300 truncate max-w-xs">{task.embedUrl}</a>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-300">
                  <span className={task.taskType === 'Team' ? 'text-purple-400' : 'text-cyan-400'}>{task.taskType}</span>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-300">{task.stage}</td>
                <td className="whitespace-nowrap px-4 py-3 text-sm">
                  <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusColor[task.status]}`}>
                    {task.status}
                  </span>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-400">
                  {task.assignedTo.length > 0 ? memberNameMap.get(task.assignedTo[0]) ?? task.assignedTo[0] : '—'}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-400">{task.dependsOn || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6 rounded-lg border border-gray-800 bg-gray-900 p-5">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-400">{title}</h2>
      <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-3">
        {children}
      </dl>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div>
      <dt className="text-xs font-medium uppercase text-gray-500">{label}</dt>
      <dd className="text-sm text-gray-200">{value}</dd>
    </div>
  );
}
