/**
 * The safety decision for one action, split out of `actions.ts` so the batch
 * filler can reach it without importing the executor it is called from. Batch
 * entries are guarded one at a time through this exact function: a form filled
 * ten fields at a time must refuse a credential or statutory field on precisely
 * the same terms as a form filled one field at a time.
 */

import type { Job } from '../backend.js';
import { classifyUnsafeField, isUnsafeToFill } from '../forms/fieldSynthesis.js';
import { evaluateHostGuard } from '../utils/hostGuard.js';
import {
  evaluateClick,
  isConstructiveLabel,
  parseAllowedActions,
  type GuardDecision,
} from '../utils/safeActionGuard.js';
import type { AgentAction } from './actions.js';
import type { MarkDescriptor } from './marks.js';

export function guardLabelFor(descriptor: MarkDescriptor | undefined): string {
  return descriptor?.guard_label ?? descriptor?.name ?? '';
}

export function semanticActionName(action: AgentAction, descriptor: MarkDescriptor | undefined): string {
  if (action.type === 'type' || action.type === 'select' || action.type === 'fill_form') return 'fill_form';
  if (action.type === 'click' && isConstructiveLabel(guardLabelFor(descriptor)).matched) {
    return 'submit_form';
  }
  return 'click_menu';
}

export function guardAction(
  action: AgentAction,
  descriptor: MarkDescriptor | undefined,
  job: Job,
): GuardDecision {
  // A disabled control fails Playwright's actionability check anyway; refusing it
  // here up front spends a guard decision instead of a wasted step.
  if ((action.type === 'click' || action.type === 'type' || action.type === 'select') && descriptor?.disabled) {
    return { allowed: false, reason: 'control is disabled and cannot be activated' };
  }
  if (action.type === 'navigate') {
    const host = evaluateHostGuard({
      currentUrl: action.url,
      baseUrl: job.profile.base_url,
      allowedDomains: job.profile.allowed_domains,
    });
    return host.ok ? { allowed: true } : { allowed: false, reason: host.message ?? 'host not allowed' };
  }
  if (action.type === 'type' || action.type === 'select') {
    if (!descriptor) return { allowed: false, reason: `mark ${action.mark} is not present` };
    if (action.type === 'select' && descriptor.tag !== 'select') {
      return {
        allowed: false,
        reason: `mark ${action.mark} is a ${descriptor.tag}, not a dropdown — use click instead`,
      };
    }
    const allowedActions = parseAllowedActions(job.session.allowed_actions_json);
    if (allowedActions.length && !allowedActions.includes('fill_form')
      && !allowedActions.includes('create_record')
      && !allowedActions.includes('click_menu')) {
      return { allowed: false, reason: 'allowed_actions does not include fill_form' };
    }
    // Typing never commits — gate on credential/statutory patterns, not the click vocabulary.
    const fieldDescriptor = {
      tag: (descriptor.tag === 'select' || descriptor.tag === 'textarea' ? descriptor.tag : 'input') as
        | 'input'
        | 'select'
        | 'textarea',
      type: descriptor.type,
      name: descriptor.name,
      id: '',
      placeholder: '',
      ariaLabel: descriptor.name,
      label: descriptor.name,
      required: false,
    };
    if (isUnsafeToFill(fieldDescriptor)) {
      // Search/filter and credential fields used to share one refusal reason,
      // which made a search box's refusal read as a false accusation of being a
      // credential field and invited the model to keep retrying it.
      const category = classifyUnsafeField(fieldDescriptor);
      return {
        allowed: false,
        reason: category === 'search'
          ? 'field is a search or filter box and typing into it would not create data'
          : 'field is credential, OTP, or a statutory identifier and must not be filled',
        matchedToken: descriptor.name,
      };
    }
    return { allowed: true };
  }
  if (action.type === 'click'
    || (action.type === 'press' && action.key.toLowerCase() === 'enter')) {
    if ('mark' in action && !descriptor) return { allowed: false, reason: `mark ${action.mark} is not present` };
    return evaluateClick(guardLabelFor(descriptor) || action.type, {
      destructiveAllowed: Boolean(job.session.destructive_allowed),
      environment: job.profile.environment,
      allowSafeDemo: Boolean(job.profile.allow_safe_demo),
      allowedActions: parseAllowedActions(job.session.allowed_actions_json),
    }, semanticActionName(action, descriptor));
  }
  return { allowed: true };
}
