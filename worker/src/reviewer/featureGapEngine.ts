import type { InventoryEntry } from '../scanner/uiInventory.js';
import type { Severity } from './uxReviewEngine.js';

export type FeatureGap = {
  product_name: string;
  expected_feature: string;
  observed: boolean;
  partial: boolean;
  competitor_ref: string;
  severity: Severity;
  recommendation: string;
  developer_prompt: string;
  notes: string;
  sources: Array<{ title?: string; url?: string }>;
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
export function detectGaps(productName: string, inventory: InventoryEntry[], benchmarks: CompetitorBenchmark[]): FeatureGap[] {
  const labels = inventory
    .map((i) => (i.label ?? '').toLowerCase())
    .filter(Boolean);

  const found = new Set<string>();
  for (const l of labels) found.add(l);

  // collapse expected features per product across all enabled competitors
  const expected = new Map<string, string[]>(); // featureKey -> competitor refs
  for (const b of benchmarks) {
    if (b.product_name !== productName) continue;
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
    const matches = tokens.filter((tok) => labels.some((l) => l.includes(tok)));
    const observed = matches.length === tokens.length;
    const partial  = !observed && matches.length / Math.max(1, tokens.length) >= 0.5;
    if (observed) continue; // only emit when missing or partial
    gaps.push({
      product_name: productName,
      expected_feature: feat,
      observed: false,
      partial,
      competitor_ref: refs.slice(0, 3).join(', '),
      severity: partial ? 'low' : 'medium',
      recommendation: partial
        ? `Partial detection -- verify if ${feat} is fully supported.`
        : `Add ${feat} support, on par with ${refs.slice(0, 2).join(' / ')}.`,
      developer_prompt: `Implement ${feat} for ${productName}, mirroring the workflow available in ${refs.slice(0, 1)[0] ?? 'competitor'}.`,
      notes: partial ? 'Some keywords matched in UI; manual verification recommended.' : '',
      sources: [],
    });
  }
  return gaps;
}

function normalizeFeature(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
