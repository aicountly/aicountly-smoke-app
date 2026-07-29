/**
 * Post-login product-host guard.
 *
 * A smoke session is only valid evidence when it runs on the product host the
 * profile points at. If an HRMS profile lands on books.aicountly.com (wrong
 * "Jump To", stale SSO redirect, tenant default), every screenshot, inventory
 * row and feature gap afterwards describes the wrong product — so the session
 * must fail loudly instead of quietly reporting Books coverage.
 */

export type HostGuardInput = {
  currentUrl: string;
  baseUrl: string;
  allowedDomains?: string | string[] | null;
};

export type HostGuardReason =
  | 'match'
  | 'allowlisted'
  | 'no_base_url'
  | 'unreadable_url'
  | 'mismatch';

export type HostGuardResult = {
  ok: boolean;
  expectedHost: string;
  actualHost: string;
  reason: HostGuardReason;
  message?: string;
};

export function normalizeHost(value: string | null | undefined): string {
  const raw = (value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw.replace(/^\/+/, '')}`);
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function parseDomainList(value: string | string[] | null | undefined): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.map(String).map((v) => v.trim()).filter(Boolean);
  const raw = String(value).trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.map(String).map((v) => v.trim()).filter(Boolean);
  } catch {
    // Accept comma-separated profile values too.
  }
  return raw.split(',').map((part) => part.trim()).filter(Boolean);
}

/** `*.aicountly.com` matches any subdomain; anything else must match exactly. */
function hostMatchesEntry(host: string, entry: string): boolean {
  const trimmed = entry.trim().toLowerCase();
  if (!trimmed) return false;
  if (trimmed.startsWith('*.')) {
    const suffix = normalizeHost(trimmed.slice(2));
    return !!suffix && (host === suffix || host.endsWith(`.${suffix}`));
  }
  const normalized = normalizeHost(trimmed);
  return !!normalized && host === normalized;
}

export function wrongHostMessage(expectedHost: string, actualHost: string): string {
  return `Wrong product host after login: expected ${expectedHost}, got ${actualHost || '(unknown)'}`;
}

/**
 * The auth hosts (login_url, my.aicountly.com) are intentionally NOT allowed
 * here: this runs after authentication, so still sitting on them means the
 * session never reached its product and should be force-navigated first.
 */
export function evaluateHostGuard(input: HostGuardInput): HostGuardResult {
  const expectedHost = normalizeHost(input.baseUrl);
  const actualHost = normalizeHost(input.currentUrl);

  if (!expectedHost) {
    return { ok: true, expectedHost: '', actualHost, reason: 'no_base_url' };
  }
  if (!actualHost) {
    return {
      ok: false,
      expectedHost,
      actualHost: '',
      reason: 'unreadable_url',
      message: wrongHostMessage(expectedHost, input.currentUrl || ''),
    };
  }
  if (actualHost === expectedHost) {
    return { ok: true, expectedHost, actualHost, reason: 'match' };
  }
  if (parseDomainList(input.allowedDomains).some((entry) => hostMatchesEntry(actualHost, entry))) {
    return { ok: true, expectedHost, actualHost, reason: 'allowlisted' };
  }
  return {
    ok: false,
    expectedHost,
    actualHost,
    reason: 'mismatch',
    message: wrongHostMessage(expectedHost, actualHost),
  };
}
