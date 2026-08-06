/**
 * Task-specific CTA button copy for the drop-off reminder emails. Falls
 * back to a generic label for any task name not in the map — the
 * detection itself stays state-based (any Active task, any workflow, see
 * dropoff-reminders.ts), so a new brokerage's task names must never break
 * the button, just render slightly less specific.
 */
const CUSTOMER_CTA_LABELS: Record<string, string> = {
  'Complete Your Onboarding Form': 'Complete your form →',
  'Confirm Your Information': 'Confirm your info →',
  'Capture Payment Method': 'Add payment method →',
  'Review & Approve Your Brand Kit': 'Review your brand kit →',
  'Schedule Your Onboarding Call': 'Book your call →',
  'Watch Setup Video': 'Watch the video →',
  'Sign In & Reset Password': 'Sign in now →',
  'Download Guide & Upload Videos': 'Upload your videos →',
  'Download Script & Upload Recordings': 'Upload your recording →',
};

const TEAM_CTA_LABELS: Record<string, string> = {
  'Create Designs': 'Start the designs →',
  'Review Designs': 'Review the designs →',
  'Upload Proof to Customer': 'Upload the proof →',
  'Move Designs to Production': 'Move to production →',
  'Create Customer Account': 'Create the account →',
  'Send Credentials': 'Send credentials →',
};

export function customerCtaLabel(taskName: string): string {
  return CUSTOMER_CTA_LABELS[taskName] ?? 'Open your portal →';
}

export function teamCtaLabel(taskName: string): string {
  return TEAM_CTA_LABELS[taskName] ?? 'Open in workspace →';
}
