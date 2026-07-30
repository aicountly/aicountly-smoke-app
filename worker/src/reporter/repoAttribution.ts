import fs from 'node:fs';

export type RepoRule = { host: string; pathPrefix?: string; repo: string };
export type RepoGroup = { repo: string; urls: string[] };
export type RepoOwnership = { groups: RepoGroup[]; unresolved: string[] };

/**
 * Only host/path combinations that have been verified against the actual
 * checkouts belong here. An unlisted host must stay unresolved: a wrong repo
 * name sends a developer into a codebase that does not own the surface.
 */
export const DEFAULT_REPO_RULES: readonly RepoRule[] = [
  { host: 'hrms.aicountly.com', pathPrefix: '/api/manage', repo: 'manage-aicountly' },
  { host: 'hrms.aicountly.com', repo: 'hrms-react-app' },
  { host: 'hrms.gh.aicountly.com', pathPrefix: '/api/manage', repo: 'manage-aicountly' },
  { host: 'hrms.gh.aicountly.com', repo: 'hrms-react-app' },
  { host: 'gh-hrms.aicountly.com', pathPrefix: '/api/manage', repo: 'manage-aicountly' },
  { host: 'gh-hrms.aicountly.com', repo: 'hrms-react-app' },
  { host: 'manage.aicountly.com', repo: 'manage-aicountly' },
  { host: 'manage.gh.aicountly.com', repo: 'manage-aicountly' },
  { host: 'my.aicountly.com', repo: 'my-aicountly-com' },
];

export function parseRepoRules(raw: string | undefined | null): RepoRule[] {
  const text = String(raw ?? '').trim();
  if (!text) return [];
  if (text.startsWith('[')) return parseJsonRules(text);
  return parseCompactRules(text);
}

export function loadRepoRules(env: NodeJS.ProcessEnv = process.env): RepoRule[] {
  // Operator rules are listed first so they win ties against the bundled defaults.
  return [
    ...parseRepoRules(env.SMOKE_REPO_MAP),
    ...parseRepoRules(readRuleFile(env.SMOKE_REPO_MAP_FILE)),
    ...DEFAULT_REPO_RULES,
  ];
}

export function resolveRepoForUrl(url: string, rules: readonly RepoRule[]): string | null {
  const target = parseTarget(url);
  if (!target) return null;

  let best: { repo: string; hostScore: number; prefixLength: number } | null = null;
  for (const rule of rules) {
    const hostScore = hostMatchScore(target.host, rule.host);
    if (hostScore < 0) continue;
    const prefix = normalizePrefix(rule.pathPrefix);
    if (!pathMatches(target.path, prefix)) continue;
    if (best && !(hostScore > best.hostScore
      || (hostScore === best.hostScore && prefix.length > best.prefixLength))) {
      continue;
    }
    best = { repo: rule.repo, hostScore, prefixLength: prefix.length };
  }
  return best ? best.repo : null;
}

export function resolveOwnership(urls: readonly string[], rules: readonly RepoRule[]): RepoOwnership {
  const seen = new Set<string>();
  const byRepo = new Map<string, string[]>();
  const unresolved: string[] = [];

  for (const raw of urls) {
    const url = String(raw ?? '').trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const repo = resolveRepoForUrl(url, rules);
    if (!repo) {
      unresolved.push(url);
      continue;
    }
    const bucket = byRepo.get(repo);
    if (bucket) bucket.push(url);
    else byRepo.set(repo, [url]);
  }

  const groups = [...byRepo.entries()]
    .map(([repo, repoUrls]) => ({ repo, urls: repoUrls }))
    .sort((a, b) => b.urls.length - a.urls.length || a.repo.localeCompare(b.repo));
  return { groups, unresolved };
}

function parseJsonRules(text: string): RepoRule[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const rules: RepoRule[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    const rule = makeRule(String(item.host ?? ''), String(item.repo ?? ''), item.pathPrefix);
    if (rule) rules.push(rule);
  }
  return rules;
}

function parseCompactRules(text: string): RepoRule[] {
  const rules: RepoRule[] = [];
  for (const line of text.split(/[\n,;]+/)) {
    const entry = line.trim();
    if (!entry || entry.startsWith('#')) continue;
    const separator = entry.indexOf('=');
    if (separator < 1) continue;
    const rule = makeRule(entry.slice(0, separator), entry.slice(separator + 1));
    if (rule) rules.push(rule);
  }
  return rules;
}

function makeRule(target: string, repo: string, explicitPrefix?: unknown): RepoRule | null {
  const repoName = repo.trim();
  if (!repoName) return null;
  const cleaned = target.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  if (!cleaned) return null;
  const slash = cleaned.indexOf('/');
  const hostPart = slash === -1 ? cleaned : cleaned.slice(0, slash);
  const pathPart = slash === -1 ? '' : cleaned.slice(slash);
  const host = hostPart.replace(/:\d+$/, '').toLowerCase();
  if (!host) return null;
  const prefix = normalizePrefix(
    typeof explicitPrefix === 'string' && explicitPrefix.trim() ? explicitPrefix : pathPart,
  );
  return prefix ? { host, pathPrefix: prefix, repo: repoName } : { host, repo: repoName };
}

function readRuleFile(filePath: string | undefined): string {
  const target = String(filePath ?? '').trim();
  if (!target || !fs.existsSync(target)) return '';
  try {
    return fs.readFileSync(target, 'utf8');
  } catch {
    return '';
  }
}

function parseTarget(url: string): { host: string; path: string } | null {
  const value = String(url ?? '').trim();
  if (!value || !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return null;
  try {
    const parsed = new URL(value);
    if (!parsed.hostname) return null;
    return { host: parsed.hostname.toLowerCase(), path: parsed.pathname || '/' };
  } catch {
    return null;
  }
}

/** Higher wins; -1 means no match. Exact host always beats a wildcard. */
function hostMatchScore(host: string, pattern: string): number {
  const candidate = pattern.trim().toLowerCase();
  if (!candidate) return -1;
  if (candidate === '*') return 0;
  if (candidate.startsWith('*.')) {
    const suffix = candidate.slice(1);
    return host.endsWith(suffix) ? 1 : -1;
  }
  return host === candidate ? 2 : -1;
}

function normalizePrefix(value: unknown): string {
  const trimmed = String(value ?? '').trim().replace(/\/+$/, '');
  if (!trimmed || trimmed === '/') return '';
  return (trimmed.startsWith('/') ? trimmed : `/${trimmed}`).toLowerCase();
}

/** Segment-aware so `/api/manage` never claims `/api/managed-something`. */
function pathMatches(path: string, prefix: string): boolean {
  if (!prefix) return true;
  const candidate = path.toLowerCase().replace(/\/+$/, '') || '/';
  return candidate === prefix || candidate.startsWith(`${prefix}/`);
}
