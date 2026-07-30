/**
 * Restricted-text matcher. The observer worker uses this on every clickable
 * element BEFORE invoking .click() to prevent destructive actions in observer
 * mode.
 *
 * On full-access tiers with allow_safe_demo + destructive_allowed, every
 * restricted label is permitted (including delete/approve/pay). Observer tiers
 * refuse the whole vocabulary. Narrow carve-outs:
 *   - session-ending controls (sign out / logout) denied on every tier
 *   - exact-match dismissal controls (cancel, close, …) allowed on every tier
 *   - bare "add"/"create" are not restricted (opening a form writes nothing)
 */

import { allowsFullAccess, isObserverOnlyEnvironment } from './environments.js';

/** Labels used only for the submit_form action-name heuristic. */
const CONSTRUCTIVE_TOKENS = [
  'save', 'submit', 'upload', 'import',
  'apply', 'confirm', 'assign', 'activate', 'enable',
];

/**
 * Single restricted vocabulary gated by tier. Bare add/create are intentionally
 * omitted so observer sessions can still open create forms. Session-ending
 * tokens are handled separately and stay denied on every tier.
 */
const RESTRICTED_TOKENS = [
  // constructive writes
  'save', 'submit', 'upload', 'import',
  'apply', 'confirm', 'assign', 'activate', 'enable',
  // irreversible / money / filing
  'delete', 'remove', 'approve', 'reject', 'post',
  'pay', 'payment', 'refund', 'void', 'transfer',
  'discard', 'archive', 'reset', 'overwrite', 'replace',
  'deactivate', 'disable', 'send',
  'e-sign', 'esign', 'reconcile', 'sync', 'finalize', 'finalise',
  'file return', 'efile', 'close period', 'post journal',
  'credit note', 'debit note', 'journal',
  'mark paid', 'mark complete', 'mark received',
  'generate invoice', 'create invoice', 'create voucher',
  'finalize return', 'process', 'execute', 'deploy', 'release',
  'publish', 'lock', 'unlock', 'authorize', 'authorise',
  'merge', 'split', 'cancel',
];

/** Exact-match only — "Cancel Invoice" still goes through the restricted gate. */
const DISMISSAL_LABELS = new Set([
  'cancel', 'close', 'dismiss', 'back', 'no', 'not now',
]);

const SESSION_ENDING_REGEX = /\b(sign[\s-]?out|log[\s-]?out)\b/i;

const CONSTRUCTIVE_REGEX = new RegExp(
  '\\b(' + CONSTRUCTIVE_TOKENS.map(escapeRe).join('|') + ')\\b',
  'i',
);

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

export function isSessionEndingLabel(label: string | null | undefined): boolean {
  if (!label) return false;
  return SESSION_ENDING_REGEX.test(label.trim());
}

export function isDismissalLabel(label: string | null | undefined): boolean {
  if (!label) return false;
  return DISMISSAL_LABELS.has(label.trim().toLowerCase());
}

/** Used by the agent to pick the submit_form action name for save/submit clicks. */
export function isConstructiveLabel(label: string | null | undefined): { matched: boolean; token?: string } {
  if (!label) return { matched: false };
  const m = CONSTRUCTIVE_REGEX.exec(label);
  if (m) return { matched: true, token: m[1].toLowerCase() };
  return { matched: false };
}

export function isRestrictedLabel(label: string | null | undefined): { matched: boolean; token?: string } {
  if (!label) return { matched: false };
  if (isDismissalLabel(label)) return { matched: false };
  const m = RESTRICTED_REGEX.exec(label);
  if (m) return { matched: true, token: m[1].toLowerCase() };
  return { matched: false };
}

function actionPermitted(action: string, allowedActions: string[] | undefined): boolean {
  if (!allowedActions) return true;
  if (allowedActions.includes(action)) return true;
  // create_record is a session-level umbrella for synthetic write flows.
  if ((action === 'fill_form' || action === 'submit_form') && allowedActions.includes('create_record')) {
    return true;
  }
  // Typing into ordinary fields is no more privileged than clicking a menu;
  // restricted labels are still gated separately below for clicks.
  if (action === 'fill_form' && allowedActions.includes('click_menu')) {
    return true;
  }
  return false;
}

export function evaluateClick(label: string | null, ctx: GuardContext, action = 'click_menu'): GuardDecision {
  if (!actionPermitted(action, ctx.allowedActions)) {
    return { allowed: false, reason: `allowed_actions does not include ${action}` };
  }

  // Session-ending controls abort the run — refuse on every tier.
  if (isSessionEndingLabel(label)) {
    return {
      allowed: false,
      reason: 'session-ending control is denied on every tier',
      matchedToken: 'sign out',
    };
  }

  // Exact-match dismissal controls must always be available to clear modals.
  if (isDismissalLabel(label)) {
    return { allowed: true };
  }

  const restricted = isRestrictedLabel(label ?? '');
  if (!restricted.matched) {
    return { allowed: true };
  }

  if (isObserverOnlyEnvironment(ctx.environment)) {
    return {
      allowed: false,
      reason: 'production environment forbids destructive labels',
      matchedToken: restricted.token,
    };
  }
  if (!allowsFullAccess(ctx.environment)) {
    return {
      allowed: false,
      reason: 'restricted labels require sandbox, gh_staging or production_full_access',
      matchedToken: restricted.token,
    };
  }
  if (!ctx.destructiveAllowed) {
    return {
      allowed: false,
      reason: 'session has destructive_allowed=false',
      matchedToken: restricted.token,
    };
  }
  if (!ctx.allowSafeDemo) {
    return {
      allowed: false,
      reason: 'profile.allow_safe_demo is false',
      matchedToken: restricted.token,
    };
  }
  return { allowed: true, matchedToken: restricted.token };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const CONSTRUCTIVE_VOCABULARY = CONSTRUCTIVE_TOKENS.slice();
export const RESTRICTED_VOCABULARY = RESTRICTED_TOKENS.slice();
