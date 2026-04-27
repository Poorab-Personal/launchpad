// Airtable Automation Script: Mark Onboarding Call Complete → Set CSM + Check-In Links
//
// Trigger: When a record in Tasks matches conditions:
//   Task Name = "Mark Onboarding Call Complete" AND Status = "Completed"
//
// Input variables:
//   - taskRecordId: Record ID of the completed task
//   - customerRecordId: Customer record ID (from Customer field, Display → ID)
//
// What it does:
// 1. Finds which team member completed this task (the actual CSM who took the call)
// 2. Updates Customer.CSM Assigned to that team member
// 3. Looks up the CSM's Calendly URL
// 4. Sets Embed URL on Check-In 1 and Check-In 2 tasks

const config = input.config();
const { taskRecordId, customerRecordId: rawCustomerId } = config;
const customerRecordId = Array.isArray(rawCustomerId) ? rawCustomerId[0] : rawCustomerId;

if (!taskRecordId || !customerRecordId) {
    throw new Error('Missing taskRecordId or customerRecordId.');
}

console.log(`Call complete for customer: ${customerRecordId}`);

// 1. Find who is assigned to this task (the CSM who completed the call)
const tasksTable = base.getTable('Tasks');
const taskQuery = await tasksTable.selectRecordsAsync();
const callTask = taskQuery.records.find(r => r.id === taskRecordId);

if (!callTask) {
    console.log('Task not found — skipping.');
    return;
}

const assignedTo = callTask.getCellValue('Assigned To');
const csmId = assignedTo && assignedTo.length > 0 ? assignedTo[0].id : null;

if (!csmId) {
    console.log('No CSM assigned to this task — skipping CSM update.');
    return;
}

console.log(`CSM who completed the call: ${csmId}`);

// 2. Update Customer.CSM Assigned
const customersTable = base.getTable('Customers');
await customersTable.updateRecordAsync(customerRecordId, {
    'CSM Assigned': [{ id: csmId }],
});
console.log('Updated Customer.CSM Assigned');

// 3. Look up CSM's Calendly URL
const teamTable = base.getTable('Team Members');
const teamQuery = await teamTable.selectRecordsAsync();
const csm = teamQuery.records.find(r => r.id === csmId);
const csmCalendlyUrl = csm ? csm.getCellValueAsString('Calendly URL') : '';

if (!csmCalendlyUrl) {
    console.log('CSM has no Calendly URL set — check-in links not updated.');
    return;
}

console.log(`CSM Calendly URL: ${csmCalendlyUrl}`);

// 4. Find Check-In tasks and set their Embed URL
const customerTasks = taskQuery.records.filter(r => {
    const linked = r.getCellValue('Customer');
    return linked && JSON.stringify(linked).includes(customerRecordId);
});

let updated = 0;
for (const task of customerTasks) {
    const name = task.getCellValueAsString('Task Name');
    if (name === 'Schedule Check-In 1' || name === 'Schedule Check-In 2') {
        await tasksTable.updateRecordAsync(task.id, {
            'Embed URL': csmCalendlyUrl,
        });
        updated++;
        console.log(`  Set Embed URL on "${name}"`);
    }
}

console.log(`Done. Updated ${updated} check-in tasks with CSM Calendly URL.`);
