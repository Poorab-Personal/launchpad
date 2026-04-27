// Airtable Automation Script: New Customer → Generate Tasks from Workflow Templates
//
// Trigger: When a record is created in the Customers table
// Input variables (configured in Airtable automation UI):
//   - recordId:  Record ID of the new customer
//   - type:      Customer's Type field (D2C or B2B)
//   - channel:   Customer's Channel field (Standard, Keyes, BW, etc.)

const config = input.config();
const { recordId, type, channel } = config;

const workflowKey = `${type}-${channel}`;
console.log(`Customer: ${recordId}, Workflow Key: ${workflowKey}`);

// ── 1. Fetch matching workflow templates ────────────────────────────────

const templatesTable = base.getTable('Workflow Templates');
const templatesQuery = await templatesTable.selectRecordsAsync({
    fields: [
        'Workflow Key', 'Stage', 'Stage Order', 'Task Title', 'Task Type',
        'Task Order', 'Visible To Client', 'Assigned Role', 'Initial Status',
        'Depends On', 'Has Team Review', 'Attachment Type', 'Embed URL', 'Instructions',
    ],
});

const templates = templatesQuery.records
    .filter(r => r.getCellValueAsString('Workflow Key') === workflowKey)
    .sort((a, b) => {
        const soA = Number(a.getCellValue('Stage Order')) || 0;
        const soB = Number(b.getCellValue('Stage Order')) || 0;
        if (soA !== soB) return soA - soB;
        return (Number(a.getCellValue('Task Order')) || 0) - (Number(b.getCellValue('Task Order')) || 0);
    });

if (templates.length === 0) {
    console.log(`No templates found for workflow key: ${workflowKey}`);
    throw new Error(`No workflow templates found for key "${workflowKey}"`);
}

console.log(`Found ${templates.length} templates for ${workflowKey}`);

// ── 2. Look up team members by role ─────────────────────────────────────

const teamTable = base.getTable('Team Members');
const teamQuery = await teamTable.selectRecordsAsync({
    fields: ['Name', 'Role', 'Active'],
});
const activeMembers = teamQuery.records.filter(r => r.getCellValue('Active'));

function getMembersByRole(role) {
    return activeMembers
        .filter(r => r.getCellValueAsString('Role') === role)
        .map(r => ({ id: r.id }));
}

// ── 3. Create a task for each template ──────────────────────────────────

const tasksTable = base.getTable('Tasks');

for (const tmpl of templates) {
    const taskFields = {
        'Task Name': tmpl.getCellValueAsString('Task Title'),
        'Customer': [{ id: recordId }],
        'Task Type': tmpl.getCellValue('Task Type'),
        'Stage': tmpl.getCellValueAsString('Stage'),
        'Stage Order': Number(tmpl.getCellValue('Stage Order')) || 0,
        'Status': tmpl.getCellValue('Initial Status'),
        'Task Order': tmpl.getCellValue('Task Order'),
        'Visible To Client': tmpl.getCellValue('Visible To Client') || false,
        'Depends On': tmpl.getCellValueAsString('Depends On') || '',
        'Has Team Review': tmpl.getCellValue('Has Team Review') || false,
        'Attachment Type': tmpl.getCellValue('Attachment Type'),
        'Instructions': tmpl.getCellValueAsString('Instructions') || '',
    };

    // Copy Embed URL if present
    const embedUrl = tmpl.getCellValueAsString('Embed URL');
    if (embedUrl) {
        taskFields['Embed URL'] = embedUrl;
    }

    // Assign team member by role
    const assignedRole = tmpl.getCellValueAsString('Assigned Role');
    if (assignedRole) {
        const members = getMembersByRole(assignedRole);
        if (members.length > 0) {
            taskFields['Assigned To'] = members;
        }
    }

    await tasksTable.createRecordAsync(taskFields);
    console.log(`  Created: "${taskFields['Task Name']}" [${tmpl.getCellValueAsString('Initial Status')}]`);
}

// ── 4. Set the customer's initial stage ─────────────────────────────────

const firstStageName = templates[0].getCellValueAsString('Stage');

const customersTable = base.getTable('Customers');
await customersTable.updateRecordAsync(recordId, {
    'Current Stage': firstStageName,
    'Stage Entered At': new Date(),
});

// ── 5. Log event ────────────────────────────────────────────────────────

const eventsTable = base.getTable('Events');
await eventsTable.createRecordAsync({
    'Customer': [{ id: recordId }],
    'Event Type': { name: 'Customer Created' },
    'Actor Type': { name: 'System' },
    'Details': `${type} customer created via ${channel}. ${templates.length} tasks generated from ${workflowKey} workflow.`,
});

console.log(`Done. ${templates.length} tasks created, stage set to "${firstStageName}".`);
