/**
 * "Jump To" product selection for the my.aicountly.com login form.
 *
 * Kept free of Playwright so the ordering rules can be unit-tested: a wrong
 * pick here silently lands an HRMS session on books.aicountly.com and every
 * screenshot in the run becomes Books evidence.
 */

export type JumpOption = { value: string; label: string };

export type JumpPlan = {
  product: string;
  /** Ordered Jump To candidates; the first one present in the dropdown wins. */
  preferred: string[];
  /** Books/ERP regex fallback is only allowed for accounting-family products. */
  booksFamily: boolean;
  warnings: string[];
};

export type JumpPick = {
  option: JumpOption;
  /** Preference string that matched, or null when nothing matched. */
  matchedPreference: string | null;
  source: 'preferred' | 'first_option';
};

/**
 * product_name → ordered Jump To candidates. Slugs mirror Config\Products::CATALOG
 * plus the legacy gh-books, gh-hrms and erp slugs that older profiles still carry.
 */
const PRODUCT_JUMP_TARGETS: Array<[RegExp, string[]]> = [
  [/^(hrms|gh[-_]?hrms)$/i, ['HRMS']],
  // Our People ESS is provisioned from HRMS; some tenants only expose "HRMS".
  [/^(ourpeople|our[-_ ]people|ess)$/i, ['Our People', 'OurPeople', 'HRMS']],
  [/^(books|smart[-_ ]?books|gh[-_]?books|accounting)$/i, ['Smart Books', 'Books']],
  [/^(auditor|audit)$/i, ['Auditor']],
  [/^(fr|financial[-_ ]?reporting)$/i, ['Financial Reporting', 'FR']],
  [/^secretarial$/i, ['Secretarial']],
  [/^vault$/i, ['Vault']],
  [/^contacts?$/i, ['Contacts']],
  [/^my[-_ ]?account$/i, ['My Account']],
  [/^calendar$/i, ['Calendar']],
  [/^(docs?|documents?)$/i, ['Docs', 'Documents']],
  [/^chat$/i, ['Chat']],
  [/^buddy$/i, ['Buddy']],
  [/^erp([-_ ]?(beta|1|3)(\.0)?)?$/i, ['ERP', 'ERP (Beta)', 'ERP 3.0', 'ERP 1.0']],
];

const BOOKS_FAMILY_PRODUCT = /^(books|smart[-_ ]?books|gh[-_]?books|accounting|erp([-_ ]?(beta|1|3)(\.0)?)?)$/i;
const BOOKS_FAMILY_FALLBACKS = ['Smart Books', 'Books', 'ERP', 'ERP (Beta)', 'ERP 3.0', 'ERP 1.0'];
const PLACEHOLDER_OPTION = /^(select|choose|jump|--|\s*$)/i;

export function productJumpTargets(product: string): string[] {
  const key = (product || '').trim();
  if (!key) return [];
  for (const [pattern, targets] of PRODUCT_JUMP_TARGETS) {
    if (pattern.test(key)) return targets.slice();
  }
  return [];
}

export function isBooksFamilyProduct(product: string): boolean {
  return BOOKS_FAMILY_PRODUCT.test((product || '').trim());
}

function envKeyFor(product: string): string {
  return `SMOKE_JUMP_TO_${product.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

/**
 * Builds the ordered preference list for a product.
 *
 * `SMOKE_JUMP_TO_<PRODUCT>` (e.g. SMOKE_JUMP_TO_HRMS) is an absolute override.
 * A global `SMOKE_JUMP_TO` is deliberately demoted below the product mapping:
 * a shared worker with `SMOKE_JUMP_TO=Smart Books` used to force every product
 * onto Books.
 */
export function buildJumpPlan(product: string, env: NodeJS.ProcessEnv = process.env): JumpPlan {
  const name = (product || '').trim();
  const warnings: string[] = [];
  const preferred: string[] = [];

  const scoped = name ? (env[envKeyFor(name)] || '').trim() : '';
  if (scoped) preferred.push(scoped);

  const mapped = productJumpTargets(name);
  preferred.push(...mapped);
  if (name) preferred.push(name);

  const global = (env.SMOKE_JUMP_TO || '').trim();
  if (global) {
    if (mapped.length > 0 && !mapped.some((target) => matchesJump(target, target, global))) {
      warnings.push(
        `SMOKE_JUMP_TO="${global}" does not match product "${name}" (expected ${mapped.join(' / ')}); `
        + 'using the product mapping first. Unset the global SMOKE_JUMP_TO on multi-product workers '
        + `or set ${envKeyFor(name)} instead.`,
      );
    }
    preferred.push(global);
  }

  const booksFamily = isBooksFamilyProduct(name) || (!name && !scoped && !global);
  if (booksFamily) preferred.push(...BOOKS_FAMILY_FALLBACKS);

  return { product: name, preferred: dedupe(preferred), booksFamily, warnings };
}

export function filterUsableJumpOptions(options: JumpOption[]): JumpOption[] {
  return options.filter((o) => {
    const value = (o.value || '').trim();
    const label = (o.label || '').trim();
    if (!value && !label) return false;
    if (PLACEHOLDER_OPTION.test(label)) return false;
    if (/^(select|choose|jump|--)$/i.test(value)) return false;
    return true;
  });
}

/**
 * Preference-first pick: walk the preference list in order and take the first
 * dropdown option that matches it. Option-first ordering is what let "Smart
 * Books" win for HRMS just because it appears earlier in the dropdown.
 */
export function pickJumpTarget(options: JumpOption[], plan: JumpPlan): JumpPick | null {
  const usable = filterUsableJumpOptions(options);
  if (usable.length === 0) return null;

  for (const preference of plan.preferred) {
    const option = usable.find((o) => matchesJump(o.label, o.value, preference));
    if (option) return { option, matchedPreference: preference, source: 'preferred' };
  }

  // Last resort only: for a mapped product this means the tenant does not expose
  // the product at all, and the post-login host guard will fail the session.
  return { option: usable[0], matchedPreference: null, source: 'first_option' };
}

export function matchesJump(label: string, value: string, preferred: string): boolean {
  const needle = normalize(preferred);
  if (!needle) return false;
  const hay = normalize(`${label} ${value}`);
  // Short needles ("FR") only match whole tokens, never substrings.
  if (needle.length <= 2) return hay.split(/[^a-z0-9]+/).includes(needle);
  if (hay.includes(needle)) return true;
  // "Smart Books" ↔ "smartbooks"
  return compact(hay).includes(compact(needle));
}

function normalize(value: string): string {
  return (value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function compact(value: string): string {
  return value.replace(/[^a-z0-9]/g, '');
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = normalize(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}
