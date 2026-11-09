/**
 * Funnel milestone labels — re-export only.
 *
 * The definitions moved to src/lib/reports/branch-report-labels.ts so that
 * built code (the branch-report cron route) can import them; tsconfig excludes
 * scripts/ from the build, so nothing under src/ can reach this path.
 *
 * This file stays so existing script imports keep working, and so there is
 * still exactly one definition of a milestone label.
 */
export * from '../src/lib/reports/branch-report-labels';
