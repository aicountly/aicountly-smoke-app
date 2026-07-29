import assert from 'node:assert/strict';
import test from 'node:test';
import { dedupeUxIssues, type UxIssue } from './uxReviewEngine.js';

function issue(url: string, screenshot: string, resultId: number): UxIssue {
  return {
    result_id: resultId,
    category: 'navigation',
    severity: 'low',
    title: 'Breadcrumb missing',
    description: 'No breadcrumb.',
    recommendation: 'Add breadcrumb.',
    human_summary: 'Make this screen easier to navigate.',
    developer_prompt: '',
    evidence: {
      affected_urls: [url],
      screenshot_paths: [screenshot],
      inventory_samples: [{ kind: 'menu', label: url, selector: '#nav' }],
    },
  };
}

test('dedupes UX findings by category/title and merges screen evidence', () => {
  const findings = dedupeUxIssues([
    issue('/attendance', '/shots/attendance.png', 10),
    issue('/attendance/regularization', '/shots/regularization.png', 11),
  ]);

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.result_id, 10);
  assert.deepEqual(findings[0]?.evidence.affected_urls, ['/attendance', '/attendance/regularization']);
  assert.deepEqual(findings[0]?.evidence.screenshot_paths, ['/shots/attendance.png', '/shots/regularization.png']);
  assert.equal(findings[0]?.human_summary, 'Make this screen easier to navigate.');
});
