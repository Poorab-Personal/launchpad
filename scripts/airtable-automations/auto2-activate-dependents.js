// Airtable Automation Script: Task Completed → Activate Dependents + Advance Stage
//
// Trigger: When a record matches conditions in Tasks table (Status = "Completed")
// Input variables (configured in Airtable automation UI):
//   - taskRecordId:     Record ID of the completed task
//   - taskName:         Task Name of the completed task
//   - customerRecordId: Record ID of the linked customer (from Customer field)
//   - taskStage:        Stage of the completed task

const config = input.config();
const { taskRecordId, taskName, customerRecordId, taskStage } = config;

console.log(`Task completed: "${taskName}" in stage "${taskStage}"`);

// ── 1. Get all tasks for this customer ──────────────────────────────────

const tasksTable = base.getTable('Tasks');
const tasksQuery = await tasksTable.selectRecordsAsync({
    fields: ['Task Name', 'Customer', 'Stage', 'Stage Order', 'Status', 'Depends On', 'Task Order', 'Has Team Review'],
});

const customerTasks = tasksQuery.records.filter(r => {
    const linked = r.getCellValue('Customer');
    return linked && linked.some(c => c.id === customerRecordId);
});

console.log(`Found ${customerTasks.length} total tasks for this customer`);

// Build set of completed task names (including the one just completed)
const completedNames = new Set();
for (const t of customerTasks) {
    if (t.id === taskRecordId || t.getCellValueAsString('Status') === 'Completed') {
        completedNames.add(t.getCellValueAsString('Task Name'));
    }
}

// ── 2. Activate dependent tasks (multi-dependency support) ──────────────

let activatedCount = 0;
for (const task of customerTasks) {
    if (task.getCellValueAsString('Status') !== 'Draft') continue;

    const dependsOnRaw = task.getCellValueAsString('Depends On');
    if (!dependsOnRaw) continue;

    // Split by comma, trim each, check ALL are completed
    const deps = dependsOnRaw.split(',').map(d => d.trim());
    const allMet = deps.every(dep => completedNames.has(dep));

    if (allMet) {
        await tasksTable.updateRecordAsync(task.id, {
            'Status': { name: 'Active' },
        });
        activatedCount++;
        console.log(`  Activated: "${task.getCellValueAsString('Task Name')}" (deps met: ${dependsOnRaw})`);

        // Log event
        const eventsTable = base.getTable('Events');
        await eventsTable.createRecordAsync({
            'Customer': [{ id: customerRecordId }],
            'Event Type': { name: 'Task Activated' },
            'Actor Type': { name: 'System' },
            'Details': `Task "${task.getCellValueAsString('Task Name')}" activated (dependencies met: ${dependsOnRaw}).`,
            'Related Task': [{ id: task.id }],
        });
    }
}

console.log(`Activated ${activatedCount} dependent tasks`);

// ── 3. Update customer flags for specific task names ────────────────────

const customersTable = base.getTable('Customers');

if (taskName === 'Create Customer Account') {
    await customersTable.updateRecordAsync(customerRecordId, { 'Account Created': true });
    console.log('Set Account Created = true');
}
if (taskName === 'Send Credentials') {
    await customersTable.updateRecordAsync(customerRecordId, { 'Credentials Sent': true });
    console.log('Set Credentials Sent = true');
}

// ── 4. Log Task Completed event ─────────────────────────────────────────

const eventsTable = base.getTable('Events');
await eventsTable.createRecordAsync({
    'Customer': [{ id: customerRecordId }],
    'Event Type': { name: 'Task Completed' },
    'Actor Type': { name: 'System' },
    'Details': `Task "${taskName}" completed.`,
    'Related Task': [{ id: taskRecordId }],
});

// ── 5. Check if all tasks in current stage are completed ────────────────

// Re-fetch to get fresh statuses after activations
const refreshedQuery = await tasksTable.selectRecordsAsync({
    fields: ['Task Name', 'Customer', 'Stage', 'Stage Order', 'Status', 'Depends On'],
});
const refreshedTasks = refreshedQuery.records.filter(r => {
    const linked = r.getCellValue('Customer');
    return linked && linked.some(c => c.id === customerRecordId);
});

const stageTasks = refreshedTasks.filter(r => r.getCellValueAsString('Stage') === taskStage);
const allStageCompleted = stageTasks.every(r => r.getCellValueAsString('Status') === 'Completed');

console.log(`Stage "${taskStage}": ${stageTasks.length} tasks, all completed: ${allStageCompleted}`);

if (!allStageCompleted) {
    console.log('Stage not yet complete — done.');
} else {
    // ── 6. Advance to next stage ────────────────────────────────────────

    const customer = (await customersTable.selectRecordsAsync({
        fields: ['Type', 'Channel'],
    })).records.find(r => r.id === customerRecordId);

    const type = customer.getCellValueAsString('Type');
    const channel = customer.getCellValueAsString('Channel');
    const workflowKey = `${type}-${channel}`;

    const templatesTable = base.getTable('Workflow Templates');
    const templatesQuery = await templatesTable.selectRecordsAsync({
        fields: ['Workflow Key', 'Stage', 'Stage Order'],
    });
    const templates = templatesQuery.records.filter(
        r => r.getCellValueAsString('Workflow Key') === workflowKey
    );

    // Get unique stages in order
    const stageMap = new Map();
    for (const t of templates) {
        const stage = t.getCellValueAsString('Stage');
        const order = Number(t.getCellValue('Stage Order')) || 0;
        if (!stageMap.has(stage)) stageMap.set(stage, order);
    }
    const stages = [...stageMap.entries()].sort((a, b) => a[1] - b[1]);

    const currentIdx = stages.findIndex(([s]) => s === taskStage);
    const nextStage = currentIdx >= 0 && currentIdx < stages.length - 1
        ? stages[currentIdx + 1]
        : null;

    if (!nextStage) {
        console.log('No more stages — onboarding complete!');
        await customersTable.updateRecordAsync(customerRecordId, {
            'Current Stage': 'Done',
        });
    } else {
        const [nextStageName] = nextStage;
        console.log(`Advancing to stage: "${nextStageName}"`);

        await customersTable.updateRecordAsync(customerRecordId, {
            'Current Stage': nextStageName,
            'Stage Entered At': new Date(),
        });

        // Log stage change event
        await eventsTable.createRecordAsync({
            'Customer': [{ id: customerRecordId }],
            'Event Type': { name: 'Stage Changed' },
            'Actor Type': { name: 'System' },
            'Details': `Advanced from "${taskStage}" to "${nextStageName}".`,
        });

        // Activate eligible tasks in new stage
        // Rebuild completed names set with all current completions
        const allCompletedNames = new Set();
        for (const t of refreshedTasks) {
            if (t.getCellValueAsString('Status') === 'Completed') {
                allCompletedNames.add(t.getCellValueAsString('Task Name'));
            }
        }

        const newStageTasks = refreshedTasks.filter(r => r.getCellValueAsString('Stage') === nextStageName);
        for (const task of newStageTasks) {
            if (task.getCellValueAsString('Status') !== 'Draft') continue;

            const dependsOn = task.getCellValueAsString('Depends On');
            let canActivate = false;

            if (!dependsOn) {
                canActivate = true;
            } else {
                const deps = dependsOn.split(',').map(d => d.trim());
                canActivate = deps.every(dep => allCompletedNames.has(dep));
            }

            if (canActivate) {
                await tasksTable.updateRecordAsync(task.id, { 'Status': { name: 'Active' } });
                console.log(`  Activated new-stage task: "${task.getCellValueAsString('Task Name')}"`);
            }
        }

        console.log(`Stage advancement to "${nextStageName}" complete.`);
    }
}

console.log('Done.');
