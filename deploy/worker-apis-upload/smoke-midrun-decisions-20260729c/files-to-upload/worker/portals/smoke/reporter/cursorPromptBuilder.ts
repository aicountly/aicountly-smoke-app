import path from 'node:path';
import type { FeatureGap } from '../reviewer/featureGapEngine.js';
import type { UxIssue } from '../reviewer/uxReviewEngine.js';

export type CursorPromptContext = {
  product_name: string;
  environment: string;
  run_code: string;
  session_name: string;
  menu_path: string;
};

export function buildUxHumanSummary(issue: UxIssue): string {
  const problem = plainSentence(issue.description)
    || `${issue.title} was observed on this screen and may confuse or block users.`;
  const nextStep = plainNextStep(issue.recommendation)
    || 'Apply a narrowly scoped fix that matches the existing product patterns.';
  return [
    `${issue.title}. ${problem} ${nextStep}`,
    '',
    `- [ ] Review the affected screen${stringList(issue.evidence?.affected_urls ?? issue.evidence?.url).length > 1 ? 's' : ''}.`,
    '- [ ] Apply the recommended change using the existing product patterns.',
    '- [ ] Confirm the fix with a focused UI and accessibility check.',
  ].join('\n');
}

export function buildFeatureGapHumanSummary(gap: FeatureGap): string {
  const intro = gap.mode === 'validate_first'
    ? `${gap.expected_feature} was not confirmed as an in-scope missing feature. Validate product need and existing coverage before planning any build work.`
    : `${gap.expected_feature} appears to be missing from this product area. ${
      plainNextStep(gap.recommendation) || 'Confirm the expected workflow, then implement with existing product patterns.'
    }`;
  return [
    intro,
    '',
    gap.mode === 'validate_first'
      ? '- [ ] Confirm whether the capability already exists or is intentionally out of scope.'
      : '- [ ] Confirm the expected workflow on the observed screen.',
    gap.mode === 'validate_first'
      ? '- [ ] Record the product owner decision; create a ticket only if approved.'
      : '- [ ] Implement with existing permissions, validation, and design patterns.',
    '- [ ] Verify the result against the linked visual evidence.',
  ].join('\n');
}

export function buildUxCursorPrompt(issue: UxIssue, context: CursorPromptContext): string {
  const evidence = issue.evidence ?? {};
  const urls = stringList(evidence.affected_urls ?? evidence.url);
  const screenTitles = stringList(evidence.screen_titles);
  const screenshots = stringList(evidence.screenshot_paths).map((value) => path.basename(value));
  const inventory = inventoryLines(evidence.inventory_samples);
  const runtime = [
    ...sampleLines('Console', evidence.console_events ?? evidence.events),
    ...sampleLines('Network', evidence.network_events ?? evidence.sample),
  ];

  return [
    `# ${issue.title}`,
    section('Context', contextLines(context)),
    section('Screen(s)', [
      ...urls.map((url) => `- URL: ${url}`),
      ...screenTitles.map((title) => `- Screen/module: ${title}`),
      ...screenshots.map((shot) => `- Screenshot: ${shot}`),
      ...(urls.length || screenshots.length ? [] : ['- Use the session report to locate the affected screen.']),
    ]),
    section('Problem', [`- ${issue.title}`, `- ${issue.description}`]),
    section('Evidence', [
      `- Category: ${issue.category}`,
      `- Severity: ${issue.severity}`,
      ...inventory,
      ...runtime,
    ]),
    section('Task', [
      `In the ${context.product_name} product repository, ${sentence(issue.recommendation)}`,
      'Keep the implementation on the affected product surface; do not modify the smoke-testing application.',
    ]),
    section('Done when', doneWhenForUx(issue)),
    section('Constraints', constraints()),
  ].join('\n\n');
}

export function buildFeatureGapCursorPrompt(gap: FeatureGap, context: CursorPromptContext): string {
  const evidence = gap.evidence ?? { sample_labels: [], screens_checked: [] };
  const validateFirst = gap.mode === 'validate_first';
  const task = validateFirst
    ? [
        `Confirm in the ${context.product_name} product repository and with the product owner whether "${gap.expected_feature}" already exists, is intentionally out of scope, or belongs on the backlog.`,
        'If it is genuinely missing and approved, open a scoped implementation ticket with fresh product evidence. This is not a build order.',
      ]
    : [
        `In the ${context.product_name} product repository, implement the missing "${gap.expected_feature}" capability on the session surface.`,
        sentence(gap.recommendation),
      ];

  return [
    `# ${gap.expected_feature}`,
    section('Context', [
      ...contextLines(context),
      `- Confidence: ${gap.confidence}`,
      `- Mode: ${gap.mode}`,
    ]),
    section('Screen(s)', [
      ...evidence.screens_checked.map((url) => `- Checked: ${url}`),
      ...(evidence.screens_checked.length ? [] : ['- No related screen URL was captured; validate before changing product code.']),
    ]),
    section('Problem', [
      `- Expected capability: ${gap.expected_feature}`,
      `- Detection: ${gap.partial ? 'partially observed' : 'not observed'}`,
    ]),
    section('Evidence', [
      ...evidence.sample_labels.map((label) => `- Nearby observed UI: ${label}`),
      ...(gap.competitor_ref ? [`- Research hint only: ${gap.competitor_ref}`] : []),
      ...gap.sources.slice(0, 3).map((source) => `- Research source: ${source.title ?? source.url ?? 'competitor reference'}${source.url ? ` (${source.url})` : ''}`),
      ...(evidence.sample_labels.length || gap.competitor_ref ? [] : ['- No strong product evidence was captured.']),
    ]),
    section('Task', task),
    section('Done when', validateFirst
      ? [
          '- Existing product behavior and route coverage are confirmed.',
          '- Product scope/ownership is documented.',
          '- An implementation ticket is opened only when the gap is verified and approved.',
        ]
      : [
          `- The ${gap.expected_feature} workflow is available from the observed session module.`,
          '- The workflow follows existing permissions, validation, and design-system conventions.',
          '- Relevant product tests cover the primary path and failure states.',
        ]),
    section('Constraints', validateFirst
      ? ['- Do not implement from competitor marketing copy alone.', '- Treat competitor references as research hints, not requirements.', ...constraints()]
      : constraints()),
  ].join('\n\n');
}

export function buildCursorPromptPack(
  context: CursorPromptContext,
  uxIssues: UxIssue[],
  featureGaps: FeatureGap[],
): string {
  const prompts = [
    ...uxIssues.map((issue) => issue.developer_prompt || buildUxCursorPrompt(issue, context)),
    ...featureGaps.map((gap) => gap.developer_prompt || buildFeatureGapCursorPrompt(gap, context)),
  ];
  return [
    `# Cursor prompts: ${context.run_code} / ${context.session_name}`,
    '',
    `Generated for the ${context.product_name} product repository.`,
    '',
    ...prompts.flatMap((prompt, index) => [index ? '\n---\n' : '', prompt]),
    '',
  ].join('\n');
}

function contextLines(context: CursorPromptContext): string[] {
  return [
    `- Product: ${context.product_name}`,
    `- Environment: ${context.environment}`,
    `- Run: ${context.run_code}`,
    `- Session: ${context.session_name}`,
    `- Menu path: ${context.menu_path || '(not specified)'}`,
  ];
}

function doneWhenForUx(issue: UxIssue): string[] {
  return [
    `- "${issue.title}" is resolved on every affected URL.`,
    '- The change matches the product’s existing design system and interaction patterns.',
    '- Product tests cover the changed behavior and accessibility where applicable.',
  ];
}

function constraints(): string[] {
  return [
    '- Stay on this product surface and do not expand scope to unrelated modules.',
    '- Reuse the existing product architecture and design-system components.',
    '- Do not edit or add behavior to the smoke-testing application.',
  ];
}

function inventoryLines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).map((entry) => {
    if (!entry || typeof entry !== 'object') return `- Inventory: ${String(entry)}`;
    const item = entry as Record<string, unknown>;
    return `- Inventory: ${String(item.kind ?? 'item')} "${String(item.label ?? '')}"${item.selector ? ` at \`${String(item.selector)}\`` : ''}`;
  });
}

function sampleLines(prefix: string, value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 5).map((item) => `- ${prefix}: ${typeof item === 'string' ? item : JSON.stringify(item)}`);
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return [...new Set(value.map(String).filter(Boolean))];
  return value ? [String(value)] : [];
}

function sentence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return 'Implement the narrowly scoped product change described by this finding.';
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Prefer plain prose; drop selector/component jargon from the lead sentence. */
function plainSentence(value: string | undefined): string {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return '';
  if (/[#.\[\]>`]|selector|component|css|xpath/i.test(trimmed) && trimmed.length < 120) {
    return '';
  }
  return sentence(trimmed);
}

function plainNextStep(value: string | undefined): string {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return '';
  // Keep short actionable prose; avoid dumping raw selectors into the lead line.
  if (/`[^`]+`|#[\w-]+|\[[^\]]+=/.test(trimmed)) {
    return 'Update the affected control using the product’s existing UI patterns.';
  }
  return sentence(trimmed);
}

function section(title: string, lines: string[]): string {
  return `## ${title}\n${lines.join('\n')}`;
}
