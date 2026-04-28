// Airtable Automation Script: Task Completed → Activate Dependents + Advance Stage
//
// Trigger: When a record matches conditions in Tasks table (Status = "Completed")
// Input variables (configured in Airtable automation UI):
//   - taskRecordId:     Record ID of the completed task
//   - taskName:         Task Name of the completed task
//   - customerRecordId: Record ID of the linked customer (from Customer field, Display → ID)
//   - taskStage:        Stage of the completed task
//   - taskProduct:      Product of the completed task (Core, Voice, or Avatar)

const config = input.config();
const { taskRecordId, taskName, customerRecordId: rawCustomerId, taskStage, taskProduct } = config;

// Handle customerRecordId as array (Airtable linked record input returns array)
const customerRecordId = Array.isArray(rawCustomerId) ? rawCustomerId[0] : rawCustomerId;

// Default to Core if Product is empty (backwards compat with pre-Product tasks)
const product = taskProduct || 'Core';

if (!taskRecordId || !customerRecordId) {
    throw new Error('Missing taskRecordId or customerRecordId.');
}

console.log(`Task completed: "${taskName}" [${product}] in stage "${taskStage}"`);
console.log(`Customer: ${customerRecordId}`);

// ── 1. Get all tasks for this customer, scoped by Product ───────────────

const tasksTable = base.getTable('Tasks');
const tasksQuery = await tasksTable.selectRecordsAsync();

// Match using JSON.stringify to avoid type comparison issues with linked records
const custId = String(customerRecordId).trim();
const customerTasks = tasksQuery.records.filter(r => {
    const linked = r.getCellValue('Customer');
    return linked && JSON.stringify(linked).includes(custId);
});

console.log(`Found ${customerTasks.length} total tasks for this customer`);

if (customerTasks.length === 0) {
    throw new Error(`No tasks found for customer ${custId}. Check automation input config.`);
}

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

// Helper: log event safely — don't let logging failures abort the main workflow
const eventsTable = base.getTable('Events');
async function logEvent(fields) {
    try {
        await eventsTable.createRecordAsync(fields);
    } catch (e) {
        console.log(`Event log failed: ${e.message}`);
    }
}

let activatedCount = 0;
for (const task of sameProductTasks) {
    if (task.getCellValueAsString('Status') !== 'Draft') continue;

    const dependsOnRaw = task.getCellValueAsString('Depends On');
    if (!dependsOnRaw) continue;

    // Split by comma, trim each, filter empty, check ALL are completed (within same Product)
    const deps = dependsOnRaw.split(',').map(d => d.trim()).filter(d => d.length > 0);
    if (deps.length === 0) continue;

    const allMet = deps.every(dep => completedNames.has(dep));

    if (allMet) {
        // Re-fetch to prevent race condition
        const freshQuery = await tasksTable.selectRecordsAsync();
        const freshTask = freshQuery.records.find(r => r.id === task.id);
        if (!freshTask || freshTask.getCellValueAsString('Status') !== 'Draft') {
            console.log(`  Skipped "${task.getCellValueAsString('Task Name')}" — already activated`);
            continue;
        }

        await tasksTable.updateRecordAsync(task.id, {
            'Status': { name: 'Active' },
        });
        activatedCount++;
        console.log(`  Activated: "${task.getCellValueAsString('Task Name')}" (deps met: ${dependsOnRaw})`);

        await logEvent({
            'Customer': [{ id: customerRecordId }],
            'Event Type': { name: 'Task Activated' },
            'Actor Type': { name: 'System' },
            'Details': `Task "${task.getCellValueAsString('Task Name')}" [${product}] activated.`,
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

await logEvent({
    'Customer': [{ id: customerRecordId }],
    'Event Type': { name: 'Task Completed' },
    'Actor Type': { name: 'System' },
    'Details': `Task "${taskName}" [${product}] completed.`,
    'Related Task': [{ id: taskRecordId }],
});

// ── 5. Check if all tasks in current stage are completed (same Product) ─

// Re-fetch to get fresh statuses after activations
const refreshedQuery = await tasksTable.selectRecordsAsync();
const refreshedTasks = refreshedQuery.records.filter(r => {
    const linked = r.getCellValue('Customer');
    return linked && JSON.stringify(linked).includes(custId);
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
        const customerQuery = await customersTable.selectRecordsAsync();
        const customer = customerQuery.records.find(r => r.id === customerRecordId);

        if (!customer) {
            throw new Error(`Customer ${customerRecordId} not found.`);
        }

        const custType = customer.getCellValueAsString('Type');
        const custChannel = customer.getCellValueAsString('Channel');
        workflowKey = `${custType}-${custChannel}`;
        stageField = 'Current Stage';
    }

    console.log(`Looking up stages for workflow key "${workflowKey}", updating "${stageField}"`);

    const templatesTable = base.getTable('Workflow Templates');
    const templatesQuery = await templatesTable.selectRecordsAsync();
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
        await logEvent({
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
                const deps = dependsOn.split(',').map(d => d.trim()).filter(d => d.length > 0);
                canActivate = deps.length === 0 || deps.every(dep => allCompletedNames.has(dep));
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
