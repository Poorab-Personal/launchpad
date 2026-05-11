import { NextRequest } from 'next/server';
import { getRecords, updateRecord, createRecord } from '@/lib/airtable-client';
import { createEvent, checkAndAdvanceStage } from '@/lib/db';

/** Airtable single select fields may be strings or { name: string } objects */
function selectVal(field: unknown): string {
  if (typeof field === 'string') return field;
  if (field && typeof field === 'object' && 'name' in field) return (field as { name: string }).name;
  return '';
}

function linkedId(field: unknown): string | null {
  if (!Array.isArray(field) || field.length === 0) return null;
  const first = field[0];
  return typeof first === 'string' ? first : first?.id ?? null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: customerId } = await params;
  const body = await request.json();
  const { approval, feedback } = body as {
    approval: 'Approved' | 'Changes Requested';
    feedback?: string;
  };

  if (!approval || !['Approved', 'Changes Requested'].includes(approval)) {
    return Response.json(
      { error: 'approval must be "Approved" or "Changes Requested"' },
      { status: 400 },
    );
  }

  // Update customer Design Approval + Design Feedback
  const customerFields: Record<string, unknown> = {
    'Design Approval': approval,
  };
  if (feedback) {
    customerFields['Design Feedback'] = feedback;
  }
  await updateRecord('Customers', customerId, customerFields);

  if (approval === 'Approved') {
    // Find "Review & Approve Your Brand Kit" task and mark it Completed
    const allTaskRecords = await getRecords('Tasks', {
      sort: [{ field: 'Task Order', direction: 'asc' }],
    });
    const reviewTask = allTaskRecords.find(
      (t) =>
        linkedId(t.fields['Customer']) === customerId &&
        (t.fields['Task Name'] as string) === 'Review & Approve Your Brand Kit',
    );

    if (reviewTask) {
      const nowIsoOuter = new Date().toISOString();
      await updateRecord('Tasks', reviewTask.id, {
        Status: 'Completed',
        'Completed At': nowIsoOuter,
      });

      // Auto-complete any pending revision tasks (Revise Design, Review Revision,
      // Upload Revised Proof — across all rounds, customer-driven OR senior-driven
      // internal). Once the customer approves, these are stale and would otherwise
      // sit in designers' queues forever.
      const REVISION_TASK_RE = /^(Revise Design|Review Revision|Upload Revised Proof) \((Internal )?Round /;
      const pendingRevisions = allTaskRecords.filter(
        (t) =>
          linkedId(t.fields['Customer']) === customerId &&
          REVISION_TASK_RE.test((t.fields['Task Name'] as string) ?? '') &&
          selectVal(t.fields['Status']) !== 'Completed',
      );
      for (const t of pendingRevisions) {
        const existingNotes = (t.fields['Notes'] as string) ?? '';
        const note = '[Auto-completed: customer approved final design]';
        await updateRecord('Tasks', t.id, {
          Status: 'Completed',
          'Completed At': nowIsoOuter,
          Notes: existingNotes ? `${existingNotes}\n${note}` : note,
        });
      }

      // Activate dependent tasks — scoped to Core product only
      // (design approval is a Core-only flow)
      const customerTasks = allTaskRecords.filter(
        (t) => linkedId(t.fields['Customer']) === customerId,
      );
      const coreTasks = customerTasks.filter((t) => {
        const prod = selectVal(t.fields['Product']);
        return prod === 'Core' || !prod;
      });
      const completedNames = new Set<string>();
      const cancelledIds = new Set(pendingRevisions.map((t) => t.id));
      for (const t of coreTasks) {
        if (
          t.id === reviewTask.id ||
          cancelledIds.has(t.id) ||
          selectVal(t.fields['Status']) === 'Completed'
        ) {
          completedNames.add(t.fields['Task Name'] as string);
        }
      }

      for (const t of coreTasks) {
        if (selectVal(t.fields['Status']) !== 'Draft') continue;
        const dependsOnRaw = (t.fields['Depends On'] as string) ?? '';
        if (!dependsOnRaw) continue;
        const deps = dependsOnRaw.split(',').map((d) => d.trim());
        if (deps.every((dep) => completedNames.has(dep))) {
          await updateRecord('Tasks', t.id, { Status: 'Active', 'Activated At': nowIsoOuter });
        }
      }

      // Check if all Core tasks in the current stage are completed → advance stage
      const reviewTaskStage = reviewTask.fields['Stage'] as string;
      await checkAndAdvanceStage(
        customerId,
        reviewTaskStage,
        customerTasks,
        completedNames,
        reviewTask.id,
        'Core',
      );
    }

    await createEvent(
      customerId,
      'Design Approved',
      'Customer',
      'Customer approved their brand kit design.',
      reviewTask?.id,
    );

    return Response.json({ customerId, approval: 'Approved', taskCompleted: reviewTask?.id ?? null });
  }

  // Changes Requested: create 3-task revision chain, reset approval to Pending
  // Get revision count to determine round number
  const customerRecord = await getRecords('Customers', {
    filterByFormula: `RECORD_ID() = '${customerId}'`,
    maxRecords: 1,
  });
  const revisionCount = (customerRecord[0]?.fields['Design Revision Count'] as number) ?? 0;
  const round = revisionCount + 1;

  // Find designer and senior designer assignments from original tasks
  const allTaskRecords = await getRecords('Tasks', {
    sort: [{ field: 'Task Order', direction: 'asc' }],
  });
  const createDesignsTask = allTaskRecords.find(
    (t) =>
      linkedId(t.fields['Customer']) === customerId &&
      (t.fields['Task Name'] as string) === 'Create Designs',
  );
  const reviewDesignsTask = allTaskRecords.find(
    (t) =>
      linkedId(t.fields['Customer']) === customerId &&
      (t.fields['Task Name'] as string) === 'Review Designs',
  );
  const designerAssignment = createDesignsTask?.fields['Assigned To'] ?? [];
  const seniorAssignment = reviewDesignsTask?.fields['Assigned To'] ?? [];

  // Create 3-task revision chain
  const reviseTaskName = `Revise Design (Round ${round})`;
  const reviewTaskName = `Review Revision (Round ${round})`;
  const uploadTaskName = `Upload Revised Proof (Round ${round})`;

  // Task 1: Revise Design — Active immediately
  const reviseTask = await createRecord('Tasks', {
    'Task Name': reviseTaskName,
    Customer: [customerId],
    'Task Type': 'Team',
    Stage: 'Review Your Designs',
    'Stage Order': 2,
    Status: 'Active',
    'Activated At': new Date().toISOString(),
    'Task Order': 10 + round,
    'Visible To Client': false,
    'Attachment Type': 'None',
    Product: 'Core',
    Instructions: `Revise the design based on customer feedback (Round ${round}).`,
    Notes: feedback ?? '',
    ...(Array.isArray(designerAssignment) && designerAssignment.length > 0
      ? { 'Assigned To': designerAssignment }
      : {}),
  });

  // Task 2: Review Revision — depends on Revise Design
  await createRecord('Tasks', {
    'Task Name': reviewTaskName,
    Customer: [customerId],
    'Task Type': 'Team',
    Stage: 'Review Your Designs',
    'Stage Order': 2,
    Status: 'Draft',
    'Task Order': 11 + round,
    'Visible To Client': false,
    'Depends On': reviseTaskName,
    'Attachment Type': 'None',
    Product: 'Core',
    Instructions: `Review the revised design (Round ${round}). Approve or send back.`,
    ...(Array.isArray(seniorAssignment) && seniorAssignment.length > 0
      ? { 'Assigned To': seniorAssignment }
      : {}),
  });

  // Task 3: Upload Revised Proof — depends on Review Revision
  await createRecord('Tasks', {
    'Task Name': uploadTaskName,
    Customer: [customerId],
    'Task Type': 'Team',
    Stage: 'Review Your Designs',
    'Stage Order': 2,
    Status: 'Draft',
    'Task Order': 12 + round,
    'Visible To Client': false,
    'Depends On': reviewTaskName,
    'Attachment Type': 'None',
    Product: 'Core',
    Instructions: `Upload the revised proof for customer review (Round ${round}).`,
    ...(Array.isArray(designerAssignment) && designerAssignment.length > 0
      ? { 'Assigned To': designerAssignment }
      : {}),
  });

  // Increment revision count and reset approval to Pending
  await updateRecord('Customers', customerId, {
    'Design Approval': 'Pending',
    'Design Revision Count': round,
  });

  await createEvent(
    customerId,
    'Design Changes Requested',
    'Customer',
    `Customer requested design changes (Round ${round}).${feedback ? ` Feedback: ${feedback}` : ''}`,
    reviseTask.id,
  );

  return Response.json({
    customerId,
    approval: 'Changes Requested',
    round,
    tasksCreated: [reviseTaskName, reviewTaskName, uploadTaskName],
  });
}
