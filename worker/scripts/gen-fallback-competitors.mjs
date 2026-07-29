import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve('samples/competitors');
const catalogs = {};
const fileIoFeatures = ['file upload', 'file download', 'csv import', 'excel export', 'pdf export'];
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
  const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const product = String(data.product_name || '').toLowerCase();
  catalogs[product] = (data.competitors || []).map((c) => ({
    product_name: product,
    competitor_name: c.name,
    features: [...new Set([...(c.features || []), ...fileIoFeatures])],
    source_url: c.source_url || '',
  }));
}

const aliases = {
  'smart books': 'books',
  books: 'books',
  erp: 'books',
  accounting: 'books',
};

const outPath = path.resolve('worker/src/reviewer/fallbackCompetitorCatalogs.ts');
const body = `import type { CompetitorBenchmark } from './featureGapEngine.js';

/** Bundled competitor catalogs (from samples/competitors). Used when API has none. */
const CATALOGS: Record<string, CompetitorBenchmark[]> = ${JSON.stringify(catalogs, null, 2)};

const ALIASES: Record<string, string> = ${JSON.stringify(aliases, null, 2)};

export function fallbackCompetitorCatalogs(productName: string): CompetitorBenchmark[] {
  const key = (productName || '').trim().toLowerCase();
  const mapped = ALIASES[key] || key;
  return CATALOGS[mapped] || CATALOGS[key] || [];
}
`;
fs.writeFileSync(outPath, body);
console.log('Wrote', outPath, 'products=', Object.keys(catalogs).join(','));
