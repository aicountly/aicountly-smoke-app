import path from 'node:path';
import type { FeatureGap } from '../reviewer/featureGapEngine.js';
import type { UxIssue } from '../reviewer/uxReviewEngine.js';
import {
  DEFAULT_REPO_RULES,
  resolveOwnership,
  type RepoOwnership,
  type RepoRule,
} from './repoAttribution.js';

export type CursorPromptContext = {
  product_name: string;
  environment: string;
  run_code: string;
  session_name: string;
  menu_path: string;
  repo_rules?: RepoRule[];
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
  const fileIo = issue.category === 'file_io';
  const ownership = ownershipFor(context, urls);

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
    section('Owner repository', ownerRepositoryLines(ownership)),
    section('Task', [
      ...taskLines(ownership, context, fileIo
        ? `fix the file upload/download/export fidelity failure. ${sentence(issue.recommendation)}`
        : sentence(issue.recommendation)),
      'Keep the implementation on the affected product surface; do not modify the smoke-testing application.',
    ]),
    section('Done when', fileIo ? [
      '- The same synthetic fixture uploads or imports successfully in a safe demo environment.',
      '- The downloaded/exported artifact preserves expected MIME, structure, and content.',
      '- Product tests cover success, validation, and failed-transfer states.',
    ] : doneWhenForUx(issue)),
    section('Constraints', constraints(ownership.groups.length > 1)),
  ].join('\n\n');
}

export function buildFeatureGapCursorPrompt(gap: FeatureGap, context: CursorPromptContext): string {
  const evidence = gap.evidence ?? { sample_labels: [], screens_checked: [] };
  const validateFirst = gap.mode === 'validate_first';
  const ownership = ownershipFor(context, evidence.screens_checked);
  const task = validateFirst
    ? [
        ...taskLines(ownership, context, `confirm with the product owner whether "${gap.expected_feature}" already exists, is intentionally out of scope, or belongs on the backlog.`),
        'If it is genuinely missing and approved, open a scoped implementation ticket with fresh product evidence. This is not a build order.',
      ]
    : [
        ...taskLines(ownership, context, `implement the missing "${gap.expected_feature}" capability on the session surface.`),
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
    section('Owner repository', ownerRepositoryLines(ownership)),
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
      ? [
          '- Do not implement from competitor marketing copy alone.',
          '- Treat competitor references as research hints, not requirements.',
          ...constraints(ownership.groups.length > 1),
        ]
      : constraints(ownership.groups.length > 1)),
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
  const ownership = ownershipFor(context, [
    ...uxIssues.flatMap((issue) => stringList(issue.evidence?.affected_urls ?? issue.evidence?.url)),
    ...featureGaps.flatMap((gap) => stringList(gap.evidence?.screens_checked)),
  ]);
  const repos = ownership.groups.map((group) => group.repo);
  return [
    `# Cursor prompts: ${context.run_code} / ${context.session_name}`,
    '',
    ...(repos.length
      ? [
          `Owner repositories in this run: ${repos.join(', ')}.`,
          'Each prompt names the repository that owns the change; do not apply changes outside the repository named in the prompt.',
        ]
      : [
          'Owner repository was not resolved from the observed URLs.',
          'Ownership must be confirmed before changing code; do not apply changes outside the repository named in the prompt.',
        ]),
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

function constraints(spansMultipleRepos = false): string[] {
  return [
    '- Stay on this product surface and do not expand scope to unrelated modules.',
    '- Reuse the existing product architecture and design-system components.',
    ...(spansMultipleRepos
      ? ['- Do not port a fix from one product’s stack into another; each repository has its own framework and design system.']
      : []),
    '- Do not edit or add behavior to the smoke-testing application.',
  ];
}

function ownershipFor(context: CursorPromptContext, urls: readonly string[]): RepoOwnership {
  return resolveOwnership(urls, context.repo_rules ?? DEFAULT_REPO_RULES);
}

function ownerRepositoryLines(ownership: RepoOwnership): string[] {
  const lines = ownership.groups.flatMap((group) => [
    `- Repository: ${group.repo}`,
    ...group.urls.map((url) => `  - ${url}`),
  ]);
  if (ownership.unresolved.length) {
    lines.push('- Ownership could not be determined for the following URL(s); confirm the owning repository before changing code:');
    lines.push(...ownership.unresolved.map((url) => `  - ${url}`));
  }
  if (!lines.length) {
    lines.push('- No URL was captured, so ownership could not be determined; confirm the owning repository before changing code.');
  }
  return lines;
}

function taskLines(ownership: RepoOwnership, context: CursorPromptContext, instruction: string): string[] {
  const repos = ownership.groups.map((group) => group.repo);
  if (repos.length === 1) {
    return [`In the ${repos[0]} repository, ${instruction}`];
  }
  if (repos.length > 1) {
    return [
      `Address the repositories listed in the Owner repository section (${repos.join(', ')}): ${instruction}`,
      'Each surface must be fixed in the repository that owns it: open one pull request per repository.',
    ];
  }
  return [
    `In the repository that owns the affected ${context.product_name} surface, ${instruction}`,
    'Ownership was not resolved from the observed URLs; confirm which repository owns the surface before writing code.',
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
  if (/[#.[\]>`]|selector|component|css|xpath/i.test(trimmed) && trimmed.length < 120) {
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
