// Airtable Automation Script: In Review Interception
//
// Trigger: When a record in Tasks matches conditions:
//   Status = "Completed" AND Has Team Review = checked
//
// This catches when someone sets a Has Team Review task to Completed
// directly (e.g., from Airtable UI). It redirects to In Review so
// a senior can approve first.
//
// Input variables:
//   - taskRecordId: Record ID of the task
//   - taskName: Task Name
//   - customerRecordId: Customer record ID

const config = input.config();
const { taskRecordId, taskName, customerRecordId } = config;

// Check if this task was JUST set to Completed and has team review
// We need to redirect it to In Review
const tasksTable = base.getTable('Tasks');
const task = (await tasksTable.selectRecordsAsync({
    fields: ['Task Name', 'Status', 'Has Team Review'],
})).records.find(r => r.id === taskRecordId);

if (!task) {
    console.log('Task not found — skipping.');
    return;
}

const status = task.getCellValueAsString('Status');
const hasReview = task.getCellValue('Has Team Review');

// Only intercept if currently Completed AND has team review
// (The trigger condition should handle this, but double-check)
if (status === 'Completed' && hasReview) {
    await tasksTable.updateRecordAsync(taskRecordId, {
        'Status': { name: 'In Review' },
    });

    console.log(`Redirected "${taskName}" from Completed → In Review (team review required)`);

    // Log event
    const eventsTable = base.getTable('Events');
    await eventsTable.createRecordAsync({
        'Customer': [{ id: customerRecordId }],
        'Event Type': { name: 'Task Sent to Review' },
        'Actor Type': { name: 'Team Member' },
        'Details': `Task "${taskName}" sent to review (requires senior approval).`,
        'Related Task': [{ id: taskRecordId }],
    });
} else {
    console.log(`Task "${taskName}" status=${status}, hasReview=${hasReview} — no interception needed.`);
}

console.log('Done.');
