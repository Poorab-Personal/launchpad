// Airtable Automation Script: New Customer → Generate Tasks from Workflow Templates
//
// Trigger: When a record is created in the Customers table
// Input variables (configured in Airtable automation UI):
//   - recordId:    Record ID of the new customer
//   - type:        Customer's Type field (D2C or B2B) — may be empty for HubSpot-sourced
//   - channel:     Customer's Channel field (Standard, Keyes, BW, etc.) — may be empty for HubSpot-sourced
//   - firstName:   Customer's First Name field
//   - lastName:    Customer's Last Name field
//   - dealId:      Customer's HubSpot Deal ID field — may be empty

const HUBSPOT_PORTAL_ID = '44956899';

const config = input.config();
const { recordId, firstName, lastName, dealId } = config;
let { type, channel } = config;

// ── 0. Defaults + enrichment for HubSpot-sourced customers ──────────────

// Default Type and Channel if empty (HubSpot deals are always D2C-Standard)
if (!type) type = 'D2C';
if (!channel) channel = 'Standard';

const workflowKey = `${type}-${channel}`;
console.log(`Customer: ${recordId}, Workflow Key: ${workflowKey}`);

// Build full Name from First + Last if Name is empty
const customersTable = base.getTable('Customers');
const custQuery = await customersTable.selectRecordsAsync();
const custRecord = custQuery.records.find(r => r.id === recordId);
const existingName = custRecord ? custRecord.getCellValueAsString('Name') : '';

const customerUpdates = {};

if (!existingName && (firstName || lastName)) {
    const fullName = [firstName, lastName].filter(Boolean).join(' ');
    customerUpdates['Name'] = fullName;
    console.log(`Set Name: ${fullName}`);
}

// Set Type and Channel if they were defaulted
if (custRecord && !custRecord.getCellValueAsString('Type')) {
    customerUpdates['Type'] = type;
}
if (custRecord && !custRecord.getCellValueAsString('Channel')) {
    customerUpdates['Channel'] = channel;
}

// Build HubSpot URLs if Deal ID exists
if (dealId) {
    customerUpdates['HubSpot Deal URL'] = `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/deal/${dealId}`;
    console.log(`Set HubSpot Deal URL`);
}

// Apply customer updates if any
if (Object.keys(customerUpdates).length > 0) {
    await customersTable.updateRecordAsync(recordId, customerUpdates);
}

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
const activeMembers = teamQuery.records.filter(r => r.getCellValue('Active') === true);

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
        'Stage': tmpl.getCellValueAsString('Stage'),
        'Stage Order': Number(tmpl.getCellValue('Stage Order')) || 0,
        'Task Order': Number(tmpl.getCellValue('Task Order')) || 0,
        'Visible To Client': tmpl.getCellValue('Visible To Client') === true,
        'Has Team Review': tmpl.getCellValue('Has Team Review') === true,
    };

    // Single select fields — use { name } format
    const taskType = tmpl.getCellValueAsString('Task Type');
    if (taskType) taskFields['Task Type'] = { name: taskType };

    const status = tmpl.getCellValueAsString('Initial Status');
    if (status) taskFields['Status'] = { name: status };

    const attachmentType = tmpl.getCellValueAsString('Attachment Type');
    if (attachmentType) taskFields['Attachment Type'] = { name: attachmentType };

    // Text fields — only set if non-empty
    const dependsOn = tmpl.getCellValueAsString('Depends On');
    if (dependsOn) taskFields['Depends On'] = dependsOn;

    const instructions = tmpl.getCellValueAsString('Instructions');
    if (instructions) taskFields['Instructions'] = instructions;

    const embedUrl = tmpl.getCellValueAsString('Embed URL');
    if (embedUrl) taskFields['Embed URL'] = embedUrl;

    // Assign team member by role
    const assignedRole = tmpl.getCellValueAsString('Assigned Role');
    if (assignedRole) {
        const members = getMembersByRole(assignedRole);
        if (members.length > 0) {
            taskFields['Assigned To'] = members;
        }
    }

    await tasksTable.createRecordAsync(taskFields);
    console.log(`  Created: "${taskFields['Task Name']}" [${status || 'Draft'}]`);
}

// ── 4. Set the customer's initial stage ─────────────────────────────────

const firstStageName = templates[0].getCellValueAsString('Stage');

await customersTable.updateRecordAsync(recordId, {
    'Current Stage': firstStageName,
    'Stage Entered At': new Date().toISOString(),
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
