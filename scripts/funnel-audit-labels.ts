/**
 * Funnel milestone labels — re-export only.
 *
 * The definitions moved to src/lib/reports/branch-report-labels.ts so that
 * built code (the branch-report cron route) can import them; tsconfig excludes
 * scripts/ from the build, so nothing under src/ can reach this path.
 *
 * This file stays so existing script imports keep working, and so there is
 * still exactly one definition of a milestone label. EDIT THE REAL FILE —
 * changing this shim does nothing.
 *
 * Note that src/lib/automations/monthly-cohort-digest.ts keeps its own labels
 * on purpose and is NOT a consumer of these; see the comment there before
 * assuming the two should be merged.
 */
export * from '../src/lib/reports/branch-report-labels';
