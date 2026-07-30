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

const uxIssue = (affectedUrls: string[]) => ({
  category: 'navigation',
  severity: 'low' as const,
  title: 'Breadcrumb missing',
  description: 'No breadcrumb was detected.',
  recommendation: 'Add the existing breadcrumb component.',
  human_summary: '',
  developer_prompt: '',
  evidence: {
    affected_urls: affectedUrls,
    screenshot_paths: ['/tmp/attendance.png'],
    inventory_samples: [{ kind: 'menu', label: 'Attendance', selector: '#nav-attendance' }],
  },
});

test('UX prompt contains every required section and never guesses an unmapped repo', () => {
  const prompt = buildUxCursorPrompt(uxIssue(['https://product.test/attendance']), context);

  for (const section of ['Context', 'Screen(s)', 'Problem', 'Evidence', 'Owner repository', 'Task', 'Done when', 'Constraints']) {
    assert.match(prompt, new RegExp(`## ${section.replace(/[()]/g, '\\$&')}`));
  }
  assert.doesNotMatch(prompt, /HRMS product repository/);
  assert.doesNotMatch(prompt, /- Repository:/);
  assert.match(prompt, /Ownership could not be determined for the following URL\(s\)/);
  assert.match(prompt, /confirm which repository owns the surface before writing code/i);
  assert.match(prompt, /#nav-attendance/);
  assert.match(prompt, /do not modify the smoke-testing application/i);
});

test('UX prompt on a mapped host names the owning repository', () => {
  const prompt = buildUxCursorPrompt(uxIssue(['https://hrms.aicountly.com/dashboard']), context);

  assert.match(prompt, /## Owner repository\n- Repository: hrms-react-app\n {2}- https:\/\/hrms\.aicountly\.com\/dashboard/);
  assert.match(prompt, /In the hrms-react-app repository, Add the existing breadcrumb component\./);
  assert.doesNotMatch(prompt, /one pull request per repository/);
});

test('UX prompt spanning two hosts names both repos and demands one PR per repository', () => {
  const prompt = buildUxCursorPrompt(
    uxIssue(['https://my.aicountly.com/', 'https://hrms.aicountly.com/dashboard']),
    context,
  );

  assert.match(prompt, /- Repository: hrms-react-app/);
  assert.match(prompt, /- Repository: my-aicountly-com/);
  assert.match(prompt, /Address the repositories listed in the Owner repository section/);
  assert.match(prompt, /open one pull request per repository/);
  assert.match(prompt, /each repository has its own framework and design system/);
});

test('UX prompt attributes the /api/manage proxy path to its upstream repo', () => {
  const prompt = buildUxCursorPrompt(uxIssue(['https://hrms.aicountly.com/api/manage/user/logo']), context);

  assert.match(prompt, /- Repository: manage-aicountly/);
  assert.match(prompt, /In the manage-aicountly repository,/);
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
