/**
 * Restricted-text matcher. The observer worker uses this on every clickable
 * element BEFORE invoking .click() to prevent destructive actions in observer
 * mode.
 *
 * Tokens split into:
 *   - constructive: save/submit/create/upload — allowed only on full-access
 *     tiers with allow_safe_demo + destructive_allowed
 *   - irreversible: delete/approve/pay/void/... — permanently denied on every
 *     tier, regardless of any opt-in flag
 */

import { allowsFullAccess, isObserverOnlyEnvironment } from './environments.js';

const CONSTRUCTIVE_TOKENS = [
  'save', 'submit', 'add', 'create', 'upload', 'import',
  'apply', 'confirm', 'assign', 'activate', 'enable',
];

const IRREVERSIBLE_TOKENS = [
  'delete', 'remove', 'approve', 'reject', 'post',
  'pay', 'payment', 'refund', 'void', 'transfer',
  'discard', 'archive', 'reset', 'overwrite', 'replace',
  'deactivate', 'disable', 'send', 'sign out', 'sign-off',
  'e-sign', 'esign', 'reconcile', 'sync', 'finalize', 'finalise',
  'file return', 'efile', 'close period', 'post journal',
  'credit note', 'debit note', 'journal',
  'mark paid', 'mark complete', 'mark received',
  'generate invoice', 'create invoice', 'create voucher',
  'finalize return', 'process', 'execute', 'deploy', 'release',
  'publish', 'lock', 'unlock', 'authorize', 'authorise',
  'merge', 'split', 'cancel',
];

const CONSTRUCTIVE_REGEX = new RegExp(
  '\\b(' + CONSTRUCTIVE_TOKENS.map(escapeRe).join('|') + ')\\b',
  'i',
);

const IRREVERSIBLE_REGEX = new RegExp(
  '\\b(' + IRREVERSIBLE_TOKENS.map(escapeRe).join('|') + ')\\b',
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

export function isIrreversibleLabel(label: string | null | undefined): { matched: boolean; token?: string } {
  if (!label) return { matched: false };
  const m = IRREVERSIBLE_REGEX.exec(label);
  if (m) return { matched: true, token: m[1].toLowerCase() };
  return { matched: false };
}

export function isConstructiveLabel(label: string | null | undefined): { matched: boolean; token?: string } {
  if (!label) return { matched: false };
  const m = CONSTRUCTIVE_REGEX.exec(label);
  if (m) return { matched: true, token: m[1].toLowerCase() };
  return { matched: false };
}

/** True when the label matches either constructive or irreversible vocabulary. */
export function isRestrictedLabel(label: string | null | undefined): { matched: boolean; token?: string } {
  const irreversible = isIrreversibleLabel(label);
  if (irreversible.matched) return irreversible;
  return isConstructiveLabel(label);
}

function actionPermitted(action: string, allowedActions: string[] | undefined): boolean {
  if (!allowedActions) return true;
  if (allowedActions.includes(action)) return true;
  // create_record is a session-level umbrella for synthetic write flows.
  if ((action === 'fill_form' || action === 'submit_form') && allowedActions.includes('create_record')) {
    return true;
  }
  // Typing into ordinary fields is no more privileged than clicking a menu;
  // constructive labels are still gated separately below.
  if (action === 'fill_form' && allowedActions.includes('click_menu')) {
    return true;
  }
  return false;
}

export function evaluateClick(label: string | null, ctx: GuardContext, action = 'click_menu'): GuardDecision {
  if (!actionPermitted(action, ctx.allowedActions)) {
    return { allowed: false, reason: `allowed_actions does not include ${action}` };
  }

  const irreversible = isIrreversibleLabel(label ?? '');
  if (irreversible.matched) {
    return {
      allowed: false,
      reason: 'irreversible control is permanently denied on every tier',
      matchedToken: irreversible.token,
    };
  }

  const constructive = isConstructiveLabel(label ?? '');
  if (!constructive.matched) {
    return { allowed: true };
  }

  if (isObserverOnlyEnvironment(ctx.environment)) {
    return {
      allowed: false,
      reason: 'production environment forbids constructive write labels',
      matchedToken: constructive.token,
    };
  }
  if (!allowsFullAccess(ctx.environment)) {
    return {
      allowed: false,
      reason: 'constructive writes require sandbox, gh_staging or production_full_access',
      matchedToken: constructive.token,
    };
  }
  if (!ctx.destructiveAllowed) {
    return {
      allowed: false,
      reason: 'session has destructive_allowed=false',
      matchedToken: constructive.token,
    };
  }
  if (!ctx.allowSafeDemo) {
    return {
      allowed: false,
      reason: 'profile.allow_safe_demo is false',
      matchedToken: constructive.token,
    };
  }
  return { allowed: true };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const CONSTRUCTIVE_VOCABULARY = CONSTRUCTIVE_TOKENS.slice();
export const IRREVERSIBLE_VOCABULARY = IRREVERSIBLE_TOKENS.slice();
/** @deprecated Prefer CONSTRUCTIVE_VOCABULARY + IRREVERSIBLE_VOCABULARY. */
export const RESTRICTED_VOCABULARY = [...CONSTRUCTIVE_TOKENS, ...IRREVERSIBLE_TOKENS];
