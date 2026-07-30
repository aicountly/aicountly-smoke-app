import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCursorPromptPack,
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

test('UX prompt strips analytics-beacon noise out of network evidence', () => {
  const issue = {
    category: 'errors',
    severity: 'high' as const,
    title: 'Network/API failures detected',
    description: '2 network failures observed.',
    recommendation: 'Investigate failing endpoints.',
    human_summary: '',
    developer_prompt: '',
    evidence: {
      affected_urls: ['https://product.test/attendance'],
      network_events: [
        'https://www.google-analytics.com/g/collect?v=2',
        'https://product.test/api/attendance/save failed with 500',
      ],
    },
  };
  const prompt = buildUxCursorPrompt(issue, context);
  assert.doesNotMatch(prompt, /google-analytics\.com/);
  assert.match(prompt, /attendance\/save failed with 500/);
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

test('feature-gap prompt suppresses the PR-per-repo sentence for validate_first but keeps it for implement', () => {
  const evidence = { sample_labels: ['Attendance'], screens_checked: ['https://my.aicountly.com/', 'https://hrms.aicountly.com/dashboard'] };
  const base = {
    product_name: 'HRMS',
    observed: false,
    partial: false,
    competitor_ref: 'Competitor X',
    severity: 'suggestion' as const,
    confidence: 'low' as const,
    recommendation: 'Confirm scope.',
    human_summary: '',
    developer_prompt: '',
    notes: '',
    sources: [],
    evidence,
  };

  const validateFirstPrompt = buildFeatureGapCursorPrompt({ ...base, expected_feature: 'Form 16', mode: 'validate_first' }, context);
  assert.doesNotMatch(validateFirstPrompt, /open one pull request per repository/);
  assert.match(validateFirstPrompt, /This is not a build order/);

  const implementPrompt = buildFeatureGapCursorPrompt({ ...base, expected_feature: 'Overtime rules', mode: 'implement' }, context);
  assert.match(implementPrompt, /open one pull request per repository/);
});

test('gap prompt reads detection state from gap.observed first, not just partial', () => {
  const evidence = { sample_labels: [], screens_checked: [] };
  const observedGap = {
    product_name: 'HRMS',
    expected_feature: 'Attendance',
    observed: true,
    partial: false,
    competitor_ref: '',
    severity: 'suggestion' as const,
    confidence: 'high' as const,
    mode: 'validate_first' as const,
    recommendation: 'Detected.',
    human_summary: '',
    developer_prompt: '',
    notes: '',
    sources: [],
    evidence,
  };
  const prompt = buildFeatureGapCursorPrompt(observedGap, context);
  assert.match(prompt, /- Detection: observed/);
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

test('a placeholder duplicate-label recommendation asks for an accessible name, not new visible copy', () => {
  const placeholder = uxIssue(['https://hrms.aicountly.com/employees']);
  placeholder.title = 'Duplicate button label "— select —"';
  placeholder.recommendation = 'Give each field-level control its own accessible name (aria-label / aria-labelledby pointing at the adjacent field label); keep the shared visible placeholder text.';

  const prompt = buildUxCursorPrompt(placeholder, context);
  assert.match(prompt, /accessible name/i);
  assert.doesNotMatch(prompt, /rename the duplicate/i);
});

test('master pack: carries the prefix, suffix, and a Detection & disproof block per finding', () => {
  const pack = buildCursorPromptPack(context, [uxIssue(['https://hrms.aicountly.com/dashboard'])], []);
  assert.match(pack, /^<!-- smoke:master-prompt v1 -->/);
  assert.match(pack, /Master Cursor prompt/);
  assert.match(pack, /## Report back/);
  assert.match(pack, /## Detection & disproof/);
});

test('master pack: an errors finding with an /api/manage network failure names both the frontend and the upstream repo', () => {
  const issue = {
    category: 'errors',
    severity: 'high' as const,
    title: 'Network/API failures detected',
    description: '1 network failure observed.',
    recommendation: 'Investigate failing endpoints.',
    human_summary: '',
    developer_prompt: '',
    evidence: {
      affected_urls: ['https://hrms.aicountly.com/dashboard'],
      network_events: [{ url: 'https://hrms.aicountly.com/api/manage/user/logo', method: 'GET', status: 404, ok: false }],
    },
  };
  const pack = buildCursorPromptPack(context, [issue], []);
  assert.match(pack, /- Repository: hrms-react-app/);
  assert.match(pack, /- Repository: manage-aicountly/);
  assert.match(pack, /Split the fix/i);
});
