/**
 * Does a screen belong to the session's declared scope?
 *
 * Coverage is decided by comparing tokens from the session's scope ("Engagement >
 * Setup") against tokens from the URL it landed on. Two things made that too strict,
 * and together they reported a session as having tested nothing when it had spent its
 * whole run on the screen it was queued for:
 *
 *  1. Tokens had to match exactly, so a scope of *Engagement* Setup never matched
 *     `/engagements/new`. Product routes are plural where menu labels are singular.
 *  2. The whole URL was tokenised, host included. Every screen in a product shares its
 *     host, so the host contributes no scope signal — and once suffixes are forgiven it
 *     actively misleads ("audit" would match "auditor.aicountly.com" on every page).
 *
 * So: match on the path, and forgive the suffix.
 */

/** Kept as-is from runSession.ts, which this replaces. */
const SCOPE_STOPWORDS = new Set(['and', 'the', 'for', 'with', 'from', 'into', 'module', 'menu']);

/** Shorter tokens ("new", "add") are too generic to match on a prefix alone. */
const MIN_STEM_LENGTH = 4;

export function meaningfulScopeTokens(value: string): string[] {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2 && !SCOPE_STOPWORDS.has(token));
}

/**
 * Path, query and hash — everything that varies between screens. SPA routers put the
 * route in the hash as often as in the path, so both count.
 */
export function scopeRelevantUrlPart(url: string): string {
  const raw = String(url ?? '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    return `${parsed.pathname} ${parsed.search} ${parsed.hash}`;
  } catch {
    // Not an absolute URL — strip an authority if one is there, otherwise use it whole.
    return raw.replace(/^[a-z]+:\/\/[^/]+/i, '');
  }
}

/**
 * Two tokens match when they are equal, or when one is a prefix of the other and the
 * shorter is long enough to mean something — "engagement"/"engagements",
 * "report"/"reports". Not a stemmer: it forgives the suffix and nothing else, which is
 * the whole of the observed mismatch and keeps the rule easy to reason about.
 */
export function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < MIN_STEM_LENGTH) return false;
  return long.startsWith(short);
}

export function scopeTokensMatchUrl(scopeTokens: string[], url: string): boolean {
  const urlTokens = meaningfulScopeTokens(scopeRelevantUrlPart(url));
  return scopeTokens.some((scopeToken) => urlTokens.some((urlToken) => tokensMatch(scopeToken, urlToken)));
}
