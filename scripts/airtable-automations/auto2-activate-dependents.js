// Airtable Automation Script: Task Completed → Activate Dependents + Advance Stage
//
// Trigger: When a record matches conditions in Tasks table (Status = "Completed")
// Input variables (configured in Airtable automation UI):
//   - taskRecordId:     Record ID of the completed task
//   - taskName:         Task Name of the completed task
//   - customerRecordId: Record ID of the linked customer (from Customer field)
//   - taskStage:        Stage of the completed task
//   - taskProduct:      Product of the completed task (Core, Voice, or Avatar)

const config = input.config();
const { taskRecordId, taskName, customerRecordId, taskStage, taskProduct } = config;

// Default to Core if Product is empty (backwards compat with pre-Product tasks)
const product = taskProduct || 'Core';

console.log(`Task completed: "${taskName}" [${product}] in stage "${taskStage}"`);

// ── 1. Get all tasks for this customer, scoped by Product ───────────────

const tasksTable = base.getTable('Tasks');
const tasksQuery = await tasksTable.selectRecordsAsync({
    fields: ['Task Name', 'Customer', 'Stage', 'Stage Order', 'Status', 'Depends On', 'Task Order', 'Has Team Review', 'Product'],
});

const customerTasks = tasksQuery.records.filter(r => {
    const linked = r.getCellValue('Customer');
    return linked && linked.some(c => c.id === customerRecordId);
});

console.log(`Found ${customerTasks.length} total tasks for this customer`);

// Filter to only tasks with the same Product for dependency checking
const sameProductTasks = customerTasks.filter(r => {
    const prod = r.getCellValueAsString('Product');
    return prod === product || (!prod && product === 'Core');
});

console.log(`Found ${sameProductTasks.length} ${product} tasks for dependency checking`);

// Build set of completed task names within the same Product
const completedNames = new Set();
for (const t of sameProductTasks) {
    if (t.id === taskRecordId || t.getCellValueAsString('Status') === 'Completed') {
        completedNames.add(t.getCellValueAsString('Task Name'));
    }
}

// ── 2. Activate dependent tasks (scoped by Product) ─────────────────────

let activatedCount = 0;
for (const task of sameProductTasks) {
    if (task.getCellValueAsString('Status') !== 'Draft') continue;

    const dependsOnRaw = task.getCellValueAsString('Depends On');
    if (!dependsOnRaw) continue;

    // Split by comma, trim each, check ALL are completed (within same Product)
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
            'Details': `Task "${task.getCellValueAsString('Task Name')}" [${product}] activated (dependencies met: ${dependsOnRaw}).`,
            'Related Task': [{ id: task.id }],
        });
    }
}

console.log(`Activated ${activatedCount} dependent ${product} tasks`);

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
    'Details': `Task "${taskName}" [${product}] completed.`,
    'Related Task': [{ id: taskRecordId }],
});

// ── 5. Check if all tasks in current stage are completed (same Product) ─

// Re-fetch to get fresh statuses after activations
const refreshedQuery = await tasksTable.selectRecordsAsync({
    fields: ['Task Name', 'Customer', 'Stage', 'Stage Order', 'Status', 'Depends On', 'Product'],
});
const refreshedTasks = refreshedQuery.records.filter(r => {
    const linked = r.getCellValue('Customer');
    return linked && linked.some(c => c.id === customerRecordId);
});

// Filter refreshed tasks to same Product
const refreshedProductTasks = refreshedTasks.filter(r => {
    const prod = r.getCellValueAsString('Product');
    return prod === product || (!prod && product === 'Core');
});

const stageTasks = refreshedProductTasks.filter(r => r.getCellValueAsString('Stage') === taskStage);
const allStageCompleted = stageTasks.every(r => r.getCellValueAsString('Status') === 'Completed');

console.log(`Stage "${taskStage}" [${product}]: ${stageTasks.length} tasks, all completed: ${allStageCompleted}`);

if (!allStageCompleted) {
    console.log('Stage not yet complete — done.');
} else {
    // ── 6. Advance to next stage (branched by Product) ──────────────────

    // Determine workflow key and stage field based on Product
    let workflowKey;
    let stageField;

    if (product === 'Voice') {
        workflowKey = 'Addon-Voice';
        stageField = 'Voice Stage';
    } else if (product === 'Avatar') {
        workflowKey = 'Addon-Avatar';
        stageField = 'Avatar Stage';
    } else {
        // Core — use {Type}-{Channel} pattern
        const customer = (await customersTable.selectRecordsAsync({
            fields: ['Type', 'Channel'],
        })).records.find(r => r.id === customerRecordId);

        const custType = customer.getCellValueAsString('Type');
        const custChannel = customer.getCellValueAsString('Channel');
        workflowKey = `${custType}-${custChannel}`;
        stageField = 'Current Stage';
    }

    console.log(`Looking up stages for workflow key "${workflowKey}", updating "${stageField}"`);

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
        console.log(`No more ${product} stages — ${product === 'Core' ? 'onboarding' : product + ' add-on'} complete!`);
        await customersTable.updateRecordAsync(customerRecordId, {
            [stageField]: 'Done',
        });
    } else {
        const [nextStageName] = nextStage;
        console.log(`Advancing ${product} to stage: "${nextStageName}"`);

        const stageUpdate = {
            [stageField]: nextStageName,
        };
        // Only set Stage Entered At for Core (it tracks the main onboarding timeline)
        if (product === 'Core') {
            stageUpdate['Stage Entered At'] = new Date().toISOString();
        }

        await customersTable.updateRecordAsync(customerRecordId, stageUpdate);

        // Log stage change event
        await eventsTable.createRecordAsync({
            'Customer': [{ id: customerRecordId }],
            'Event Type': { name: 'Stage Changed' },
            'Actor Type': { name: 'System' },
            'Details': `[${product}] Advanced from "${taskStage}" to "${nextStageName}".`,
        });

        // Activate eligible tasks in new stage (same Product only)
        const allCompletedNames = new Set();
        for (const t of refreshedProductTasks) {
            if (t.getCellValueAsString('Status') === 'Completed') {
                allCompletedNames.add(t.getCellValueAsString('Task Name'));
            }
        }

        const newStageTasks = refreshedProductTasks.filter(r => r.getCellValueAsString('Stage') === nextStageName);
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
                console.log(`  Activated new-stage task: "${task.getCellValueAsString('Task Name')}" [${product}]`);
            }
        }

        console.log(`${product} stage advancement to "${nextStageName}" complete.`);
    }
}

console.log('Done.');
