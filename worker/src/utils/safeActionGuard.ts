/**
 * Restricted-text matcher. The observer worker uses this on every clickable
 * element BEFORE invoking .click() to prevent destructive actions in observer
 * mode. The list mirrors the spec: Save, Submit, Delete, Remove, Post,
 * Approve, Reject, Finalize, Generate Invoice, File Return, Send, Upload,
 * Import, Sync, Reconcile, Reset and similar terms.
 *
 * Match is case-insensitive and matches whole words OR words inside a longer
 * label (e.g. "Save Invoice", "Final Submit", "Generate GSTR-1").
 */

const RESTRICTED_TOKENS = [
  // explicit list from spec
  'save', 'submit', 'delete', 'remove', 'post', 'approve', 'reject',
  'finalize', 'finalise', 'generate invoice', 'file return', 'send',
  'upload', 'import', 'sync', 'reconcile', 'reset',
  // additional safety terms
  'pay', 'payment', 'transfer', 'discard', 'archive', 'publish',
  'confirm', 'apply', 'assign', 'merge', 'split', 'lock', 'unlock',
  'authorize', 'authorise', 'sign', 'process', 'run', 'execute',
  'deploy', 'release', 'activate', 'deactivate', 'enable', 'disable',
  'overwrite', 'replace', 'mark paid', 'mark complete', 'mark received',
  'cancel', 'void', 'refund', 'credit note', 'debit note', 'journal',
  'create invoice', 'create voucher', 'post journal', 'close period',
  'finalize return', 'efile',
];

const RESTRICTED_REGEX = new RegExp(
  '(' + RESTRICTED_TOKENS.map(escapeRe).join('|') + ')',
  'i',
);

export type GuardContext = {
  destructiveAllowed: boolean;
  environment: string;
  allowSafeDemo: boolean;
  allowedActions?: string[];
};

export type GuardDecision = {
  allowed: boolean;
  reason?: string;
  matchedToken?: string;
};

export function isRestrictedLabel(label: string | null | undefined): { matched: boolean; token?: string } {
  if (!label) return { matched: false };
  const m = RESTRICTED_REGEX.exec(label);
  if (m) return { matched: true, token: m[1].toLowerCase() };
  return { matched: false };
}

export function evaluateClick(label: string | null, ctx: GuardContext): GuardDecision {
  // Production targets are always observer-only -- never click destructive labels.
  const isProd = ctx.environment === 'production_readonly' || ctx.environment === 'production_restricted';
  const r = isRestrictedLabel(label ?? '');
  if (!r.matched) {
    return { allowed: true };
  }
  if (isProd) {
    return { allowed: false, reason: 'production environment forbids destructive labels', matchedToken: r.token };
  }
  if (!ctx.destructiveAllowed) {
    return { allowed: false, reason: 'session has destructive_allowed=false', matchedToken: r.token };
  }
  if (!ctx.allowSafeDemo) {
    return { allowed: false, reason: 'profile.allow_safe_demo is false', matchedToken: r.token };
  }
  return { allowed: true };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const RESTRICTED_VOCABULARY = RESTRICTED_TOKENS.slice();
