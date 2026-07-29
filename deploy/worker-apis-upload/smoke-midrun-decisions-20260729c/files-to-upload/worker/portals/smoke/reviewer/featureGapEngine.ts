import type { InventoryEntry } from '../scanner/uiInventory.js';
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

  // collapse expected features per product across all enabled competitors
  const expected = new Map<string, string[]>(); // featureKey -> competitor refs
  const productKey = productName.trim().toLowerCase();
  for (const b of benchmarks) {
    if ((b.product_name || '').trim().toLowerCase() !== productKey) continue;
    for (const f of b.features) {
      const key = normalizeFeature(f);
      const refs = expected.get(key) ?? [];
      refs.push(b.competitor_name);
      expected.set(key, refs);
    }
  }

  const gaps: FeatureGap[] = [];
  for (const [feat, refs] of expected.entries()) {
    const tokens = feat.split(/\s+/).filter(Boolean);
    const matches = tokens.filter((tok) => contexts.some((context) => tokenMatches(tok, context)));
    const observed = matches.length === tokens.length;
    const partial  = !observed && matches.length / Math.max(1, tokens.length) >= 0.5;
    const featureTokens = meaningfulTokens(feat);
    const inScope = featureTokens.some((token) => sessionTokens.some((sessionToken) =>
      token === sessionToken || (token.length > 3 && sessionToken.length > 3 && (token.includes(sessionToken) || sessionToken.includes(token))),
    ));
    const mode: FeatureGap['mode'] = observed ? 'validate_first' : inScope ? 'implement' : 'validate_first';
    const confidence: FeatureGap['confidence'] = observed
      ? 'high'
      : inScope
        ? (partial || matches.length > 0 ? 'high' : 'medium')
        : (partial ? 'medium' : 'low');
    const nearby = contexts
      .filter(({ item }) => inScope ? isRelatedUrl(item.url, scope.menuPath ?? scope.sessionName ?? '') : true)
      .slice(0, 12)
      .map(({ item }) => ({ kind: item.kind, label: item.label, selector: item.selector, url: item.url }));
    const sampleLabels = [...new Set(nearby.map((item) => item.label).filter(Boolean))].slice(0, 12);
    gaps.push({
      product_name: productName,
      expected_feature: feat,
      observed,
      partial,
      competitor_ref: refs.slice(0, 3).join(', '),
      severity: observed ? 'suggestion' : mode === 'validate_first' ? 'suggestion' : partial ? 'low' : 'medium',
      confidence,
      mode,
      recommendation: observed
        ? `${feat} was detected in the observed UI.`
        : mode === 'validate_first'
        ? `Confirm whether ${feat} belongs in this product/module before opening an implementation ticket.`
        : partial
        ? `Partial detection -- verify if ${feat} is fully supported.`
        : `Add ${feat} support, on par with ${refs.slice(0, 2).join(' / ')}.`,
      human_summary: '',
      developer_prompt: '',
      notes: observed
        ? 'All expected feature keywords matched in the observed UI.'
        : mode === 'validate_first'
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
