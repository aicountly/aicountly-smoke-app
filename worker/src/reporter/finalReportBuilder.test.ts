import assert from 'node:assert/strict';
import test from 'node:test';
import { dedupeFeatureGapsAcrossSessions, selectCursorQuickWins } from './finalReportBuilder.js';
import type { FeatureGap } from '../reviewer/featureGapEngine.js';

function gap(overrides: Partial<FeatureGap> & { expected_feature: string }): FeatureGap {
  return {
    product_name: 'HRMS',
    observed: false,
    partial: false,
    competitor_ref: 'Competitor',
    severity: 'medium',
    confidence: 'medium',
    mode: 'implement',
    recommendation: 'Add it.',
    human_summary: '',
    developer_prompt: `# ${overrides.expected_feature}`,
    notes: '',
    sources: [],
    evidence: { sample_labels: [], screens_checked: [] },
    ...overrides,
  };
}

test('dedupes feature gaps across sessions by normalized expected_feature', () => {
  const gaps = [
    gap({ expected_feature: 'Overtime rules', evidence: { sample_labels: [], screens_checked: [] } }),
    gap({ expected_feature: 'overtime rules', evidence: { sample_labels: ['Attendance', 'Shift'], screens_checked: ['/attendance'] } }),
    gap({ expected_feature: 'Form 16' }),
  ];
  const deduped = dedupeFeatureGapsAcrossSessions(gaps);
  assert.equal(deduped.length, 2);
  const overtime = deduped.find((g) => g.expected_feature.toLowerCase() === 'overtime rules');
  // The instance with the richer evidence (more sample_labels) wins.
  assert.deepEqual(overtime?.evidence.sample_labels, ['Attendance', 'Shift']);
});

test('quick wins collapse duplicate implement-mode gaps repeated once per session', () => {
  const gaps = [
    gap({ expected_feature: 'Overtime rules', mode: 'implement', observed: false }),
    gap({ expected_feature: 'Overtime rules', mode: 'implement', observed: false }),
    gap({ expected_feature: 'Overtime rules', mode: 'implement', observed: false }),
  ];
  const quickWins = selectCursorQuickWins([], gaps);
  assert.equal(quickWins.length, 1);
});

test('quick wins still exclude validate_first and observed gaps after dedup', () => {
  const gaps = [
    gap({ expected_feature: 'Form 16', mode: 'validate_first' }),
    gap({ expected_feature: 'Attendance', mode: 'implement', observed: true }),
  ];
  const quickWins = selectCursorQuickWins([], gaps);
  assert.equal(quickWins.length, 0);
});
