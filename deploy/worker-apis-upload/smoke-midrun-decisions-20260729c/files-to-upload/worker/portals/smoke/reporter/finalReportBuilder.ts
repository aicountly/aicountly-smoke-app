import { finalizeRun } from '../backend.js';
import type { FeatureGap } from '../reviewer/featureGapEngine.js';
import type { UxIssue } from '../reviewer/uxReviewEngine.js';

/** Mirrors the PHP final report's Quick wins for Cursor inclusion contract. */
export function selectCursorQuickWins(uxIssues: UxIssue[], featureGaps: FeatureGap[]): string[] {
  const uxPrompts = uxIssues
    .filter((issue) => ['critical', 'high', 'medium'].includes(issue.severity))
    .map((issue) => issue.developer_prompt)
    .filter(Boolean);
  const gapPrompts = featureGaps
    .filter((gap) => gap.mode === 'implement' && !gap.observed)
    .map((gap) => gap.developer_prompt)
    .filter(Boolean);
  return [...uxPrompts, ...gapPrompts];
}

/**
 * The PHP backend owns the canonical Final Report Builder (it has DB access
 * and is consistent with the worker-token boundary). The worker simply asks
 * the backend to finalise once it observes the last session of a run was
 * completed.
 */
export async function finalizeIfLast(runId: number): Promise<void> {
  await finalizeRun(runId);
}
