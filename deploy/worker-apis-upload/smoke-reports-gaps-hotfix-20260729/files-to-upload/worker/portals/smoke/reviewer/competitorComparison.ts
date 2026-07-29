import { invokeBrain } from '../brain/ensemble.js';
import type { FeatureGap } from './featureGapEngine.js';

/**
 * Optional brain pass over the heuristic feature gaps. Asks the council to:
 *   - prune false positives
 *   - rank by expected impact
 *   - add concrete competitor references with source URLs (Perplexity)
 *
 * If the brain is unconfigured, the input gaps are returned unchanged.
 */
export async function enrichGaps(productName: string, environment: string, gaps: FeatureGap[]): Promise<FeatureGap[]> {
  if (gaps.length === 0) return gaps;

  const sys = `You are an AICOUNTLY product gap analyst. Given a list of candidate
missing features for product "${productName}", refine: drop probable false
positives, sharpen recommendations, and rank by expected user impact. Output
JSON in the same schema you receive.`;

  const usr = JSON.stringify({ product: productName, environment, gaps }, null, 2);

  try {
    const r = await invokeBrain('feature_gap', sys, usr, {
      product: productName,
      environment,
      expect_json: true,
    });
    const final = r.final as { gaps?: FeatureGap[]; feature_gaps?: FeatureGap[] } | FeatureGap[] | null;
    // Never replace heuristics with an empty AI payload (common when brain is deterministic / unconfigured).
    if (Array.isArray(final) && final.length > 0) return final;
    if (final && Array.isArray(final.gaps) && final.gaps.length > 0) return final.gaps;
    if (final && Array.isArray(final.feature_gaps) && final.feature_gaps.length > 0) return final.feature_gaps;
    return gaps;
  } catch (e) {
    console.warn('[smoke-worker] competitor enrichment skipped:', (e as Error).message);
    return gaps;
  }
}
