'use client';

import type { Task, Customer } from '@/types';
import PlainTask from './PlainTask';
import FormTask from './FormTask';
import FileUploadTask from './FileUploadTask';
import EmbedTask from './EmbedTask';
import ProofTask from './ProofTask';
import PaymentSetupTask from './PaymentSetupTask';

export default function TaskRenderer({
  task,
  customerId,
  customer,
  onComplete,
}: {
  task: Task;
  customerId: string;
  customer?: Customer;
  onComplete: () => void;
}) {
  switch (task.attachmentType) {
    case 'Form':
      return <FormTask task={task} onComplete={onComplete} customerId={customerId} customer={customer} />;
    case 'File Upload':
      return <FileUploadTask task={task} customerId={customerId} onComplete={onComplete} />;
    case 'Embed':
      return <EmbedTask task={task} onComplete={onComplete} />;
    case 'Proof':
      return <ProofTask task={task} customerId={customerId} customer={customer} onComplete={onComplete} />;
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
