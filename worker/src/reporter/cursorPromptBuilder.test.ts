import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFeatureGapCursorPrompt,
  buildFeatureGapHumanSummary,
  buildUxCursorPrompt,
  buildUxHumanSummary,
} from './cursorPromptBuilder.js';

const context = {
  product_name: 'HRMS',
  environment: 'staging',
  run_code: 'RUN-42',
  session_name: 'Attendance',
  menu_path: '/attendance',
};

test('UX prompt contains every required section and targets product repo', () => {
  const prompt = buildUxCursorPrompt({
    category: 'navigation',
    severity: 'low',
    title: 'Breadcrumb missing',
    description: 'No breadcrumb was detected.',
    recommendation: 'Add the existing breadcrumb component.',
    human_summary: '',
    developer_prompt: '',
    evidence: {
      affected_urls: ['https://product.test/attendance'],
      screenshot_paths: ['/tmp/attendance.png'],
      inventory_samples: [{ kind: 'menu', label: 'Attendance', selector: '#nav-attendance' }],
    },
  }, context);

  for (const section of ['Context', 'Screen(s)', 'Problem', 'Evidence', 'Task', 'Done when', 'Constraints']) {
    assert.match(prompt, new RegExp(`## ${section.replace(/[()]/g, '\\$&')}`));
  }
  assert.match(prompt, /HRMS product repository/);
  assert.match(prompt, /#nav-attendance/);
  assert.match(prompt, /do not modify the smoke-testing application/i);
});

test('validate-first gap is explicitly not a build order', () => {
  const prompt = buildFeatureGapCursorPrompt({
    product_name: 'HRMS',
    expected_feature: 'form 16',
    observed: false,
    partial: false,
    competitor_ref: 'Competitor X',
    severity: 'suggestion',
    confidence: 'low',
    mode: 'validate_first',
    recommendation: 'Confirm scope.',
    human_summary: '',
    developer_prompt: '',
    notes: '',
    sources: [],
    evidence: { sample_labels: ['Attendance'], screens_checked: ['/attendance'] },
  }, context);

  assert.match(prompt, /This is not a build order/);
  assert.match(prompt, /Research hint only: Competitor X/);
  assert.match(prompt, /Mode: validate_first/);
});

test('human summaries are plain-language checklists distinct from developer prompts', () => {
  const ux = {
    category: 'navigation',
    severity: 'low' as const,
    title: 'Breadcrumb missing',
    description: 'No breadcrumb was detected.',
    recommendation: 'Add the existing breadcrumb component.',
    human_summary: '',
    developer_prompt: '',
    evidence: { affected_urls: ['/one', '/two'] },
  };
  const gap = {
    product_name: 'HRMS',
    expected_feature: 'form 16',
    observed: false,
    partial: false,
    competitor_ref: '',
    severity: 'suggestion' as const,
    confidence: 'low' as const,
    mode: 'validate_first' as const,
    recommendation: 'Confirm scope.',
    human_summary: '',
    developer_prompt: '',
    notes: '',
    sources: [],
    evidence: { sample_labels: [], screens_checked: ['/payroll'] },
  };

  assert.match(buildUxHumanSummary(ux), /- \[ \] Review the affected screens/);
  assert.match(buildFeatureGapHumanSummary(gap), /Validate product need/i);
  assert.match(buildFeatureGapHumanSummary(gap), /create a ticket only if approved/i);
  assert.doesNotMatch(buildFeatureGapHumanSummary(gap), /^#/m);
});
