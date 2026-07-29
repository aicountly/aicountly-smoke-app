import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve('samples/competitors');
const catalogs = {};

// Only features a competitor actually claims. Injecting generic file-handling
// features here would fabricate gaps, and would disagree with the API path,
// which stopped doing exactly this.
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
  const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const product = String(data.product_name || '').toLowerCase();
  catalogs[product] = (data.competitors || []).map((c) => ({
    product_name: product,
    competitor_name: c.name,
    features: [...new Set(c.features || [])],
    source_url: c.source_url || '',
  }));
}

const outPath = path.resolve('worker/src/reviewer/fallbackCompetitorCatalogs.ts');
const body = `import type { CompetitorBenchmark } from './featureGapEngine.js';
import { canonicalProduct } from './productAliases.js';

/** Bundled competitor catalogs (from samples/competitors). Used when API has none. */
const CATALOGS: Record<string, CompetitorBenchmark[]> = ${JSON.stringify(catalogs, null, 2)};

export function fallbackCompetitorCatalogs(productName: string): CompetitorBenchmark[] {
  const key = (productName || '').trim().toLowerCase();
  return CATALOGS[canonicalProduct(key)] || CATALOGS[key] || [];
}
`;
fs.writeFileSync(outPath, body);
console.log('Wrote', outPath, 'products=', Object.keys(catalogs).join(','));
