/**
 * Several suite entry points share one competitor catalog: an ERP or Accounting
 * run is benchmarked against the Books competitors.
 *
 * Stored and bundled benchmark rows carry the canonical key while a run carries
 * whatever alias the operator picked, so any comparison between the two must
 * normalize BOTH sides. Comparing raw names makes an aliased run match nothing
 * and report zero feature gaps, which is indistinguishable from a clean product.
 */
const PRODUCT_ALIASES: Record<string, string> = {
  'smart books': 'books',
  erp: 'books',
  accounting: 'books',
};

export function canonicalProduct(productName: string): string {
  const key = (productName || '').trim().toLowerCase();
  return PRODUCT_ALIASES[key] ?? key;
}
