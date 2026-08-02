import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FeatureGap } from '../reviewer/featureGapEngine.js';
import type { Severity, UxIssue } from '../reviewer/uxReviewEngine.js';
import {
  EXPORT_OR_DOWNLOAD_LABEL_PATTERN,
  ROW_ACTION_LABEL_PATTERN,
  SEARCH_LABEL_PATTERN,
  SELECTOR_LABEL_PATTERN,
} from '../scanner/controlPatterns.js';

/**
 * Wraps the per-finding Cursor prompts already produced by cursorPromptBuilder.ts
 * into one run/session-level "master prompt": a verify-before-implement operating
 * contract (prefix), findings grouped by how much this pass trusts its own
 * detection, a per-finding "how was this detected / how to disprove it" note, and
 * a report-back contract (suffix).
 *
 * Mirrored in backend/app/Services/Reports/CursorHandoff.php, which assembles the
 * same document from raw DB rows instead of typed UxIssue/FeatureGap objects
 * (the PHP rebuild path never re-runs the browser scan). Change the shared prose
 * in samples/prompts/ and the grouping rules in both places together.
 */

export type TrustGroup = 'verify_then_fix' | 'likely_artifact' | 'do_not_build';

export type AnyFinding = UxIssue | FeatureGap;

export type MasterPromptContext = {
  run_code: string;
  product_name: string;
  environment: string;
  repos: string[];
  /** Precomputed by assembleMasterPrompt; callers building the prefix directly may omit it. */
  counts?: string;
  generated_at?: string;
};

type Caveat = {
  id: string;
  category: string;
  title_pattern?: string;
  mode?: string;
  detected_by: string;
  blind_spot: string;
  disprove: string;
};

type CaveatText = Pick<Caveat, 'detected_by' | 'blind_spot' | 'disprove'>;

type CaveatCatalog = { caveats: Caveat[]; fallback: CaveatText };

const SAMPLES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../samples/prompts');

const FALLBACK_PREFIX = [
  '# Master Cursor prompt: {{run_code}}',
  '',
  'Every finding below is a machine-generated hypothesis, not a work order.',
  'Locate the owning code, verify each finding against it, and implement only',
  'what you confirm is a real defect. Never modify the smoke-testing application.',
].join('\n');

const FALLBACK_SUFFIX = [
  '## Report back',
  '',
  "List each finding's verdict (confirmed, already implemented, mis-scoped, or",
  'needs a product decision) with file evidence before opening a pull request.',
].join('\n');

const FALLBACK_CATALOG: CaveatCatalog = {
  caveats: [],
  fallback: {
    detected_by: "A generic heuristic check specific to this finding's category.",
    blind_spot: 'Heuristic DOM/text checks cannot see every valid implementation of a capability.',
    disprove: "Verify directly against the live screen and this repository's code before implementing anything.",
  },
};

const SEVERITY_RANK: Record<string, number> = {
  critical: 4, high: 3, medium: 2, low: 1, suggestion: 0,
};

const GROUP_ORDER: TrustGroup[] = ['verify_then_fix', 'likely_artifact', 'do_not_build'];

const GROUP_TITLE: Record<TrustGroup, string> = {
  verify_then_fix: 'Group A — Verify then fix',
  likely_artifact: 'Group B — Likely detector artifact',
  do_not_build: 'Group C — Do not build (validate first)',
};

const GROUP_COUNT_LABEL: Record<TrustGroup, string> = {
  verify_then_fix: 'to verify then fix',
  likely_artifact: 'likely detector artifacts',
  do_not_build: 'backlog questions, not build orders',
};

let cachedCatalog: CaveatCatalog | null = null;
let cachedPrefix: string | null = null;
let cachedSuffix: string | null = null;

function readSample(file: string): string | null {
  try {
    return fs.readFileSync(path.join(SAMPLES_DIR, file), 'utf8');
  } catch {
    return null;
  }
}

function loadCatalog(): CaveatCatalog {
  if (cachedCatalog) return cachedCatalog;
  const raw = readSample('detector-caveats.json');
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<CaveatCatalog>;
      if (Array.isArray(parsed.caveats) && parsed.fallback) {
        return (cachedCatalog = { caveats: parsed.caveats, fallback: parsed.fallback });
      }
    } catch {
      // fall through to the bundled fallback below
    }
  }
  return (cachedCatalog = FALLBACK_CATALOG);
}

function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => vars[key] ?? '');
}

export function renderPrefix(context: MasterPromptContext): string {
  const template = cachedPrefix ?? (cachedPrefix = readSample('cursor-master-prefix.md') ?? FALLBACK_PREFIX);
  return fillTemplate(template, {
    run_code: context.run_code,
    product_name: context.product_name,
    environment: context.environment,
    repos: context.repos.length ? context.repos.join(', ') : 'not resolved from the observed URLs',
    counts: context.counts ?? '',
    generated_at: context.generated_at ?? new Date().toISOString(),
  }).trim();
}

export function renderSuffix(): string {
  return (cachedSuffix ?? (cachedSuffix = readSample('cursor-master-suffix.md') ?? FALLBACK_SUFFIX)).trim();
}

export function isFeatureGap(finding: AnyFinding): finding is FeatureGap {
  return 'expected_feature' in finding;
}

function findingSeverity(finding: AnyFinding): Severity | string {
  return finding.severity;
}

/** Labels of every inventory item this finding's own evidence carries, regardless of DOM kind. */
function ownInventoryLabels(finding: AnyFinding): string[] {
  const evidence = (finding.evidence ?? {}) as Record<string, unknown>;
  const samples = evidence.inventory_samples ?? evidence.nearby_inventory;
  if (!Array.isArray(samples)) return [];
  return samples
    .map((item) => (item && typeof item === 'object' ? String((item as Record<string, unknown>).label ?? '') : ''))
    .filter(Boolean);
}

export function caveatFor(finding: AnyFinding): CaveatText {
  const catalog = loadCatalog();
  if (isFeatureGap(finding)) {
    const match = catalog.caveats.find((c) => c.category === 'feature_gap' && c.mode === finding.mode);
    return match ?? catalog.fallback;
  }
  const title = finding.title ?? '';
  const candidates = catalog.caveats.filter((c) => c.category === finding.category);
  const specific = candidates.find((c) => c.title_pattern && new RegExp(c.title_pattern, 'i').test(title));
  return specific ?? candidates.find((c) => !c.title_pattern) ?? catalog.fallback;
}

/**
 * Names the tokens the feature-gap detector actually matched versus the ones it
 * never found anywhere in the run, when that gap is a partial/implement match --
 * the shape behind this run's "employee directory" and "employee profile" false
 * positives (matched "employee", never found "directory" / "profile").
 */
function describeMatchedTokens(gap: FeatureGap): string | null {
  const matched = gap.evidence?.matched_context ?? [];
  if (!matched.length) return null;
  const tokens = gap.expected_feature.toLowerCase().split(/\s+/).filter(Boolean);
  const missing = tokens.filter((token) => !matched.includes(token));
  if (!missing.length) return null;
  return `Matched: ${matched.map((t) => `\`${t}\``).join(', ')}. Never found: ${missing.map((t) => `\`${t}\``).join(', ')}.`;
}

/**
 * Four evidence-backed rules, cheapest and most specific first. Everything else
 * that isn't a validate_first scope question is asked to be verified rather than
 * assumed either way.
 */
export function classifyTrust(finding: AnyFinding, allInventoryLabels: string[] = []): TrustGroup {
  const labels = allInventoryLabels.length ? allInventoryLabels : ownInventoryLabels(finding);

  if (isFeatureGap(finding)) {
    if (finding.mode === 'validate_first') return 'do_not_build';
    if (finding.mode === 'implement' && finding.partial && (finding.evidence?.matched_context?.length ?? 0) > 0) {
      return 'likely_artifact';
    }
    return 'verify_then_fix';
  }

  if (finding.category === 'multi_tenant' && labels.some((label) => SELECTOR_LABEL_PATTERN.test(label))) {
    return 'likely_artifact';
  }
  if (
    finding.category === 'navigation'
    && /search|command/i.test(finding.title ?? '')
    && labels.some((label) => SEARCH_LABEL_PATTERN.test(label))
  ) {
    return 'likely_artifact';
  }
  if (finding.category === 'filters') {
    const evidence = (finding.evidence ?? {}) as Record<string, unknown>;
    const samples = evidence.inventory_samples;
    const hasSearchOrFilterKind = Array.isArray(samples)
      && samples.some((item) => {
        if (!item || typeof item !== 'object') return false;
        const kind = String((item as Record<string, unknown>).kind ?? '');
        return kind === 'search' || kind === 'filter';
      });
    if (hasSearchOrFilterKind || labels.some((label) => SEARCH_LABEL_PATTERN.test(label))) {
      return 'likely_artifact';
    }
  }
  // "Download CSV/Excel/PDF" is export evidence; demote leftover export findings.
  if (
    finding.category === 'reports'
    && /export/i.test(finding.title ?? '')
    && labels.some((label) => EXPORT_OR_DOWNLOAD_LABEL_PATTERN.test(label))
  ) {
    return 'likely_artifact';
  }
  // Repeated CRUD row actions (Edit/Deactivate/…) already emit accessible-name
  // recommendations at the scanner/reviewer layer; treat high-count duplicates
  // as detector artifacts so prompt packs do not promote them as build orders.
  if (
    finding.category === 'layout'
    && /duplicate button label/i.test(finding.title ?? '')
  ) {
    const titleLabel = /\bduplicate button label\s+"([^"]+)"/i.exec(finding.title ?? '')?.[1] ?? '';
    const evidence = (finding.evidence ?? {}) as Record<string, unknown>;
    const count = typeof evidence.count === 'number' ? evidence.count : 0;
    const accessibleNameStyle = /accessible name|aria-label/i.test(
      `${finding.recommendation ?? ''} ${finding.developer_prompt ?? ''}`,
    );
    if (
      count > 2
      && accessibleNameStyle
      && ROW_ACTION_LABEL_PATTERN.test(titleLabel)
    ) {
      return 'likely_artifact';
    }
  }
  return 'verify_then_fix';
}

function detectionBlock(finding: AnyFinding): string {
  const caveat = caveatFor(finding);
  const lines = [
    '## Detection & disproof',
    `- Detected by: ${caveat.detected_by}`,
    `- Blind spot: ${caveat.blind_spot}`,
  ];
  if (isFeatureGap(finding)) {
    const evidence = describeMatchedTokens(finding);
    if (evidence) lines.push(`- This run's own evidence: ${evidence}`);
  }
  lines.push(`- To disprove: ${caveat.disprove}`);
  return lines.join('\n');
}

function withDetectionBlock(finding: AnyFinding, prompt: string): string {
  const body = prompt.trim();
  if (!body) return body;
  return `${body}\n\n${detectionBlock(finding)}`;
}

type Entry = { finding: AnyFinding; prompt: string; group: TrustGroup };

export type AssembleMasterPromptInput = {
  context: Omit<MasterPromptContext, 'counts'>;
  uxIssues: UxIssue[];
  featureGaps: FeatureGap[];
  /** Full run/session inventory labels, independent of any one finding's narrow evidence sample. */
  allInventoryLabels?: string[];
};

export function assembleMasterPrompt(input: AssembleMasterPromptInput): string {
  const { context, uxIssues, featureGaps, allInventoryLabels = [] } = input;

  const entries: Entry[] = [
    ...uxIssues.map((issue): Entry => ({
      finding: issue,
      prompt: withDetectionBlock(issue, issue.developer_prompt ?? ''),
      group: classifyTrust(issue, allInventoryLabels),
    })),
    ...featureGaps.map((gap): Entry => ({
      finding: gap,
      prompt: withDetectionBlock(gap, gap.developer_prompt ?? ''),
      group: classifyTrust(gap, allInventoryLabels),
    })),
  ].filter((entry) => entry.prompt.trim() !== '');

  const byGroup = (group: TrustGroup) => entries
    .filter((entry) => entry.group === group)
    .sort((a, b) => rank(b.finding) - rank(a.finding));

  const counts = GROUP_ORDER
    .map((group) => `${byGroup(group).length} ${GROUP_COUNT_LABEL[group]}`)
    .join(', ');

  const prefix = renderPrefix({
    ...context,
    counts: entries.length ? `Findings: ${counts}.` : 'No findings recorded in this pack.',
  });

  const sections = GROUP_ORDER.flatMap((group) => {
    const groupEntries = byGroup(group);
    if (!groupEntries.length) return [];
    return [`# ${GROUP_TITLE[group]}`, ...groupEntries.map((entry) => entry.prompt)];
  });

  return [
    '<!-- smoke:master-prompt v1 -->',
    prefix,
    ...sections,
    renderSuffix(),
  ].join('\n\n---\n\n');
}

function rank(finding: AnyFinding): number {
  return SEVERITY_RANK[String(findingSeverity(finding)).toLowerCase()] ?? 0;
}
