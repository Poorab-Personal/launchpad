import { NextRequest } from 'next/server';
import { getRecords, updateRecord } from '@/lib/airtable-client';

/**
 * Calendly Webhook — backend confirmation for bookings.
 *
 * Called by Calendly's webhook system when an event is scheduled.
 * This is the reliable backend confirmation — the portal's postMessage
 * listener handles instant UI feedback.
 *
 * Calendly webhook payload includes:
 * - event: "invitee.created"
 * - payload.invitee.email
 * - payload.event.start_time
 * - payload.event.end_time
 *
 * We also accept a simplified payload (for Zapier or manual testing):
 * { customerEmail, eventDate, assigneeEmail }
 */

export async function POST(request: NextRequest) {
  const body = await request.json();

  // Handle both Calendly native and simplified payloads
  let customerEmail: string;
  let eventDate: string;

  if (body.event === 'invitee.created' && body.payload) {
    // Calendly native webhook format
    customerEmail = body.payload.invitee?.email ?? '';
    eventDate = body.payload.event?.start_time ?? '';
  } else {
    // Simplified format (Zapier or manual)
    customerEmail = body.customerEmail ?? '';
    eventDate = body.eventDate ?? '';
  }

  if (!customerEmail) {
    return Response.json({ error: 'No customer email found' }, { status: 400 });
  }

  // Find the customer by email
  const customers = await getRecords('Customers', {
    filterByFormula: `{Contact Email} = '${customerEmail}'`,
    maxRecords: 1,
  });

  if (customers.length === 0) {
    return Response.json({ error: 'Customer not found', email: customerEmail }, { status: 404 });
  }

  const custId = customers[0].id;

  // Find the active "Schedule" task for this customer
  const allTasks = await getRecords('Tasks');
  const scheduleTask = allTasks.find((t) => {
    const linked = t.fields['Customer'];
    const isCustomer = Array.isArray(linked) && JSON.stringify(linked).includes(custId);
    const name = (t.fields['Task Name'] as string) ?? '';
    const status = typeof t.fields['Status'] === 'object'
      ? (t.fields['Status'] as { name: string }).name
      : t.fields['Status'];
    return isCustomer && name.includes('Schedule') && status === 'Active';
  });

  // Mark the task as completed (if not already)
  if (scheduleTask) {
    await updateRecord('Tasks', scheduleTask.id, {
      Status: 'Completed',
      'Completed At': new Date().toISOString(),
    });
  }

  // Update customer record
  const customerUpdate: Record<string, unknown> = {
    'Call Booked': true,
  };
  if (eventDate) {
    customerUpdate['Call Date'] = eventDate;
  }
  await updateRecord('Customers', custId, customerUpdate);

  return Response.json({
    ok: true,
    customerId: custId,
    callDate: eventDate || null,
    taskCompleted: scheduleTask?.id ?? null,
  });
}
