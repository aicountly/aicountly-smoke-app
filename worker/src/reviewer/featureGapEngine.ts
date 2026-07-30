import type { InventoryEntry } from '../scanner/uiInventory.js';
import { canonicalProduct } from './productAliases.js';
import type { Severity } from './uxReviewEngine.js';

export type FeatureGap = {
  product_name: string;
  expected_feature: string;
  observed: boolean;
  partial: boolean;
  competitor_ref: string;
  severity: Severity;
  confidence: 'high' | 'medium' | 'low';
  mode: 'implement' | 'validate_first';
  recommendation: string;
  human_summary: string;
  developer_prompt: string;
  notes: string;
  sources: Array<{ title?: string; url?: string }>;
  evidence: {
    sample_labels: string[];
    screens_checked: string[];
    matched_context?: string[];
    nearby_inventory?: Array<Pick<InventoryEntry, 'kind' | 'label' | 'selector' | 'url'>>;
    screenshot_paths?: string[];
    target_selectors?: string[];
  };
};

export type CompetitorBenchmark = {
  product_name: string;
  competitor_name: string;
  features: string[];
  source_url?: string;
};

/**
 * Compares an inventory of observed labels against the expected feature list
 * derived from configured competitors. The match is fuzzy: tokens / substring.
 */
export function detectGaps(
  productName: string,
  inventory: InventoryEntry[],
  benchmarks: CompetitorBenchmark[],
  scope: { sessionName?: string; menuPath?: string; screensChecked?: string[] } = {},
): FeatureGap[] {
  const contexts = inventory.map((item) => ({
    item,
    label: normalizeFeature(item.label ?? ''),
    url: normalizeFeature(item.url ?? ''),
    href: normalizeFeature(typeof item.payload?.href === 'string' ? item.payload.href : ''),
  }));
  const screensChecked = [...new Set([
    ...(scope.screensChecked ?? []),
    ...inventory.map((item) => item.url).filter(Boolean),
  ])];
  const sessionContext = normalizeFeature(`${scope.sessionName ?? ''} ${scope.menuPath ?? ''}`);
  const sessionTokens = expandSessionScope(meaningfulTokens(sessionContext));
  const expected = buildExpectedFeatureMap(productName, benchmarks);
  const relatedScope = scope.menuPath ?? scope.sessionName ?? '';

  const gaps: FeatureGap[] = [];
  for (const [feat, { refs, displayFeature }] of expected.entries()) {
    const tokens = feat.split(/\s+/).filter(Boolean);
    const matches = tokens.filter((tok) => contexts.some((context) => tokenMatches(tok, context)));
    const observed = matches.length === tokens.length;
    // Fully observed features are confirmed present; they generate no gap row
    // at all rather than a "validate_first" note nobody needs to act on.
    if (observed) continue;
    const featureTokens = meaningfulTokens(feat);
    const inScope = featureTokens.some((token) => sessionTokens.some((sessionToken) =>
      token === sessionToken || (token.length > 3 && sessionToken.length > 3 && (token.includes(sessionToken) || sessionToken.includes(token))),
    ));
    // A feature with zero evidence AND no relation to this session's scope is
    // noise, not a validate_first ticket — drop it rather than citing
    // unrelated inventory (e.g. login-page items) as evidence.
    if (matches.length === 0 && !inScope) continue;
    const partial = matches.length / Math.max(1, tokens.length) >= 0.5;
    const mode: FeatureGap['mode'] = inScope ? 'implement' : 'validate_first';
    const confidence: FeatureGap['confidence'] = inScope
      ? (partial || matches.length > 0 ? 'high' : 'medium')
      : (partial ? 'medium' : 'low');
    const nearby = contexts
      .filter(({ item }) => isRelatedUrl(item.url, relatedScope))
      .slice(0, 12)
      .map(({ item }) => ({ kind: item.kind, label: item.label, selector: item.selector, url: item.url }));
    const sampleLabels = [...new Set(nearby.map((item) => item.label).filter(Boolean))].slice(0, 12);
    gaps.push({
      product_name: productName,
      expected_feature: displayFeature,
      observed,
      partial,
      competitor_ref: refs.slice(0, 3).join(', '),
      severity: mode === 'validate_first' ? 'suggestion' : partial ? 'low' : 'medium',
      confidence,
      mode,
      recommendation: mode === 'validate_first'
        ? `Confirm whether ${displayFeature} belongs in this product/module before opening an implementation ticket.`
        : partial
        ? `Partial detection -- verify if ${displayFeature} is fully supported.`
        : `Add ${displayFeature} support, on par with ${refs.slice(0, 2).join(' / ')}.`,
      human_summary: '',
      developer_prompt: '',
      notes: mode === 'validate_first'
        ? 'Outside the current session module; validate product scope before implementation.'
        : partial ? 'Some keywords matched in UI; manual verification recommended.' : '',
      sources: [],
      evidence: {
        sample_labels: sampleLabels,
        screens_checked: screensChecked,
        matched_context: matches,
        nearby_inventory: nearby,
      },
    });
  }
  return gaps;
}

type ExpectedFeature = { refs: string[]; displayFeature: string };

/** Collapses expected features per product across all enabled competitors, keyed by normalized text. */
function buildExpectedFeatureMap(productName: string, benchmarks: CompetitorBenchmark[]): Map<string, ExpectedFeature> {
  const expected = new Map<string, ExpectedFeature>();
  const productKey = canonicalProduct(productName);
  for (const b of benchmarks) {
    if (canonicalProduct(b.product_name || '') !== productKey) continue;
    for (const f of b.features) {
      const key = normalizeFeature(f);
      if (!key) continue;
      const existing = expected.get(key);
      if (existing) {
        existing.refs.push(b.competitor_name);
      } else {
        // Keep the first-seen raw spelling for display; normalizeFeature is
        // for matching only and would turn "1:1 meetings" into "1 1 meetings".
        expected.set(key, { refs: [b.competitor_name], displayFeature: f.trim() || key });
      }
    }
  }
  return expected;
}

/** Total distinct expected features for a product, regardless of what was observed. */
export function countExpectedFeatures(productName: string, benchmarks: CompetitorBenchmark[]): number {
  return buildExpectedFeatureMap(productName, benchmarks).size;
}

function normalizeFeature(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const shortTokens = new Set(['pf', 'pt', 'ai']);
const stopWords = new Set(['and', 'the', 'for', 'with', 'from', 'into', 'module', 'menu']);

function meaningfulTokens(value: string): string[] {
  return normalizeFeature(value).split(' ').filter((token) => token.length > 1 && !stopWords.has(token));
}

function expandSessionScope(tokens: string[]): string[] {
  const moduleFamilies: Record<string, string[]> = {
    attendance: ['attendance', 'shift', 'overtime', 'regularization', 'punch', 'biometric', 'roster', 'timesheet'],
    payroll: ['payroll', 'salary', 'payslip', 'pf', 'esi', 'tax', 'form', 'gratuity'],
    leave: ['leave', 'holiday', 'absence', 'balance', 'approval'],
    performance: ['performance', 'okr', 'goal', 'review', 'appraisal'],
    recruitment: ['recruitment', 'candidate', 'interview', 'offer', 'onboarding'],
    learning: ['learning', 'lms', 'course', 'training'],
  };
  const expanded = new Set(tokens);
  for (const token of tokens) {
    for (const related of moduleFamilies[token] ?? []) expanded.add(related);
  }
  return [...expanded];
}

function tokenMatches(
  token: string,
  context: { item: InventoryEntry; label: string; url: string; href: string },
): boolean {
  if (shortTokens.has(token) || token.length <= 2) {
    const exact = (value: string) => value.split(' ').includes(token);
    if (token === 'ai' && context.item.kind === 'ai_copilot') return true;
    return exact(context.label) || exact(context.url) || exact(context.href);
  }
  return context.label.includes(token) || context.url.includes(token) || context.href.includes(token);
}

function isRelatedUrl(url: string, scope: string): boolean {
  const urlTokens = meaningfulTokens(url);
  const scopeTokens = meaningfulTokens(scope);
  return scopeTokens.length === 0 || scopeTokens.some((token) => urlTokens.includes(token));
}
