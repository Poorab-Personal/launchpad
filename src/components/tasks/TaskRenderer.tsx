'use client';

import type { Task, Customer } from '@/types';
import PlainTask from './PlainTask';
import FormTask from './FormTask';
import FileUploadTask from './FileUploadTask';
import EmbedTask from './EmbedTask';
import ProofTask from './ProofTask';
import PaymentSetupTask from './PaymentSetupTask';
import SignInTask from './SignInTask';

export default function TaskRenderer({
  task,
  customerId,
  customer,
  revisionInFlight = false,
  onComplete,
}: {
  task: Task;
  customerId: string;
  customer?: Customer;
  /** True when a customer-facing revision round (Revise / Review Revision /
   *  Upload Revised Proof) is Active. Only ProofTask uses it today — surfaces
   *  a "designer is working on your revisions" acknowledgment in place of
   *  the standard approve/request-changes buttons. */
  revisionInFlight?: boolean;
  onComplete: () => void;
}) {
  // Special-case by task name (template Attachment Type is None for these,
  // but we want a richer renderer than PlainTask).
  if (task.taskName === 'Sign In & Reset Password') {
    return <SignInTask task={task} customer={customer} onComplete={onComplete} />;
  }

  switch (task.attachmentType) {
    case 'Form':
      return <FormTask task={task} onComplete={onComplete} customerId={customerId} customer={customer} />;
    case 'File Upload':
      return <FileUploadTask task={task} customerId={customerId} onComplete={onComplete} />;
    case 'Embed':
      return <EmbedTask task={task} onComplete={onComplete} />;
    case 'Proof':
      return <ProofTask task={task} customerId={customerId} customer={customer} revisionInFlight={revisionInFlight} onComplete={onComplete} />;
    case 'Payment Setup':
      return (
        <PaymentSetupTask
          task={task}
          customerId={customerId}
          customer={customer}
          workflowKey={customer?.workflowKey ?? ''}
          onComplete={onComplete}
        />
      );
    case 'None':
    default:
      return <PlainTask task={task} onComplete={onComplete} />;
  }
}
