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

import { allowsFullAccess, isObserverOnlyEnvironment } from './environments.js';

const RESTRICTED_TOKENS = [
  // explicit list from spec
  'save', 'submit', 'delete', 'remove', 'post', 'approve', 'reject',
  'finalize', 'finalise', 'generate invoice', 'file return', 'send',
  'upload', 'import', 'sync', 'reconcile', 'reset',
  // additional safety terms
  'pay', 'payment', 'transfer', 'discard', 'archive', 'publish',
  'confirm', 'apply', 'assign', 'merge', 'split', 'lock', 'unlock',
  'authorize', 'authorise', 'sign out', 'sign-off', 'e-sign', 'esign', 'process', 'execute',
  'deploy', 'release', 'activate', 'deactivate', 'enable', 'disable',
  'overwrite', 'replace', 'mark paid', 'mark complete', 'mark received',
  'cancel', 'void', 'refund', 'credit note', 'debit note', 'journal',
  'create invoice', 'create voucher', 'post journal', 'close period',
  'finalize return', 'efile',
];

// Word-boundary aware so short tokens like "pay" do not match "display".
const RESTRICTED_REGEX = new RegExp(
  '\\b(' + RESTRICTED_TOKENS.map(escapeRe).join('|') + ')\\b',
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

export type FileAction = 'detect_file_ui' | 'download_file' | 'export_file' | 'upload_file' | 'import_file' | 'compare_file';

const FILE_MUTATIONS = new Set<FileAction>(['upload_file', 'import_file']);
const FILE_OUTPUTS = new Set<FileAction>(['download_file', 'export_file']);

/** Reported when an observer-only production tier refuses file I/O outright. */
export const OBSERVER_ONLY_FILE_BLOCK_REASON = 'production environment forbids file actions';

export function parseAllowedActions(value: string | string[] | null | undefined): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function evaluateFileAction(action: FileAction, ctx: GuardContext): GuardDecision {
  if (action === 'detect_file_ui') return { allowed: true };
  const allowedActions = new Set(ctx.allowedActions ?? []);

  if (!allowedActions.has(action)) {
    return { allowed: false, reason: `allowed_actions does not include ${action}` };
  }
  if (isObserverOnlyEnvironment(ctx.environment)) {
    return { allowed: false, reason: OBSERVER_ONLY_FILE_BLOCK_REASON };
  }
  if (FILE_OUTPUTS.has(action)) {
    return { allowed: true };
  }
  if (FILE_MUTATIONS.has(action)) {
    if (!allowsFullAccess(ctx.environment)) {
      return { allowed: false, reason: 'file mutations require sandbox, gh_staging or production_full_access' };
    }
    if (!ctx.allowSafeDemo) {
      return { allowed: false, reason: 'profile.allow_safe_demo is false' };
    }
    if (!ctx.destructiveAllowed) {
      return { allowed: false, reason: 'session has destructive_allowed=false' };
    }
    return { allowed: true };
  }
  return { allowed: true };
}

export function evaluateFileActionContract(actions: FileAction[], ctx: GuardContext): GuardDecision {
  for (const action of actions) {
    const decision = evaluateFileAction(action, ctx);
    if (!decision.allowed) return decision;
  }
  return { allowed: true };
}

export function isRestrictedLabel(label: string | null | undefined): { matched: boolean; token?: string } {
  if (!label) return { matched: false };
  const m = RESTRICTED_REGEX.exec(label);
  if (m) return { matched: true, token: m[1].toLowerCase() };
  return { matched: false };
}

export function evaluateClick(label: string | null, ctx: GuardContext, action = 'click_menu'): GuardDecision {
  if (ctx.allowedActions && !ctx.allowedActions.includes(action)) {
    return { allowed: false, reason: `allowed_actions does not include ${action}` };
  }
  // Read-only and restricted production targets are observer-only -- never click
  // destructive labels. production_full_access opts out and behaves like sandbox.
  const r = isRestrictedLabel(label ?? '');
  if (!r.matched) {
    return { allowed: true };
  }
  if (isObserverOnlyEnvironment(ctx.environment)) {
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
