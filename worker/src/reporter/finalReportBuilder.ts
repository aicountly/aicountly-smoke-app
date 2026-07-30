import { finalizeRun } from '../backend.js';
import type { FeatureGap } from '../reviewer/featureGapEngine.js';
import type { UxIssue } from '../reviewer/uxReviewEngine.js';

/** Mirrors the PHP final report's Quick wins for Cursor inclusion contract. */
export function selectCursorQuickWins(uxIssues: UxIssue[], featureGaps: FeatureGap[]): string[] {
  const uxPrompts = uxIssues
    .filter((issue) => ['critical', 'high', 'medium'].includes(issue.severity))
    .map((issue) => issue.developer_prompt)
    .filter(Boolean);
  const gapPrompts = dedupeFeatureGapsAcrossSessions(featureGaps)
    .filter((gap) => gap.mode === 'implement' && !gap.observed)
    .map((gap) => gap.developer_prompt)
    .filter(Boolean);
  return [...uxPrompts, ...gapPrompts];
}

function normalizeFeatureKey(feature: string): string {
  return feature.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function evidenceScore(gap: FeatureGap): number {
  return (gap.evidence?.sample_labels?.length ?? 0) + (gap.evidence?.nearby_inventory?.length ?? 0);
}

/**
 * Collapses near-identical feature-gap rows across the sessions of one run,
 * keyed by normalized `expected_feature`, keeping whichever instance carries
 * the most evidence. Every session in a run evaluates the same competitor
 * catalog, so without this a five-session run repeats every "not observed"
 * feature once per session in the final Cursor prompt pack.
 */
export function dedupeFeatureGapsAcrossSessions(featureGaps: FeatureGap[]): FeatureGap[] {
  const byFeature = new Map<string, FeatureGap>();
  for (const gap of featureGaps) {
    const key = normalizeFeatureKey(gap.expected_feature);
    const current = byFeature.get(key);
    if (!current || evidenceScore(gap) > evidenceScore(current)) {
      byFeature.set(key, gap);
    }
  }
  return [...byFeature.values()];
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
