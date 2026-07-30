import type { Page } from 'playwright';
import type { Job } from '../backend.js';
import { applyMarker } from '../data/syntheticMarker.js';
import { isUnsafeToFill } from '../forms/fieldSynthesis.js';
import { evaluateHostGuard } from '../utils/hostGuard.js';
import {
  evaluateClick,
  isConstructiveLabel,
  parseAllowedActions,
  type GuardDecision,
} from '../utils/safeActionGuard.js';
import {
  dateFieldKey,
  dateFieldLabel,
  isDateishMark,
  probeDateControl,
  type DateProbe,
} from './dateFieldProbe.js';
import { markInteractive, unmark, type MarkDescriptor } from './marks.js';
import { captureViewportJpeg, signature, waitForSettle, type PageSignature } from './perceive.js';
import { coerceForField } from './valueCoercion.js';

export type AgentAction =
  | { type: 'click'; mark: number }
  | { type: 'type'; mark: number; text: string; submit?: boolean }
  | { type: 'select'; mark: number; option: string }
  | { type: 'press'; key: string }
  | { type: 'scroll'; direction: 'up' | 'down'; amount: number }
  | { type: 'navigate'; url: string }
  | { type: 'wait'; ms: number }
  | { type: 'done'; reason: string }
  | { type: 'blocked'; reason: string }
  | { type: 'ask_operator'; question: string; options: string[] };

export type ActionOutcome = {
  status: 'executed' | 'refused' | 'terminal' | 'failed';
  observation: string;
  guard: GuardDecision;
  screenshot?: string;
  before: PageSignature;
  after: PageSignature;
  target_label: string;
  typed_value?: string;
};

export type AgentStepRecord = {
  ordinal: number;
  captured_at: string;
  screenshot: string;
  observation: string;
  reasoning: string;
  goal_progress: string;
  blockers: string[];
  action: AgentAction;
  outcome: ActionOutcome['status'];
  outcome_observation: string;
  guard: GuardDecision;
  target_label: string;
  typed_value?: string;
  signature_before: PageSignature;
  signature_after: PageSignature;
  signature_changed: boolean;
};

/**
 * Lets the loop decide which date fields are still worth probing and collect the
 * results, while the probe itself runs here, next to the fill it precedes.
 */
export type DateProbeSink = {
  shouldProbe: (key: string) => boolean;
  record: (probe: DateProbe) => void;
};

export async function executeAction(input: {
  page: Page;
  job: Job;
  action: AgentAction;
  marks: MarkDescriptor[];
  screenshotsDir: string;
  ordinal: number;
  dateProbe?: DateProbeSink;
}): Promise<ActionOutcome> {
  const { page, job, action, marks } = input;
  const before = await signature(page);
  const descriptor = 'mark' in action ? marks.find((item) => item.mark === action.mark) : undefined;
  const targetLabel = descriptor?.name ?? '';
  let guard: GuardDecision = { allowed: true };
  let status: ActionOutcome['status'] = 'executed';
  let observation = '';
  let typedValue: string | undefined;

  if (action.type === 'done' || action.type === 'blocked' || action.type === 'ask_operator') {
    status = 'terminal';
    observation = action.type === 'ask_operator' ? action.question : action.reason;
  } else {
    guard = guardAction(action, descriptor, job);
    if (!guard.allowed) {
      status = 'refused';
      observation = `That control is destructive or disallowed on this tier: ${guard.reason ?? 'blocked by safety guard'}. Choose another action.`;
    } else {
      if (action.type === 'type' && descriptor && input.dateProbe) {
        await probeDateField({
          page,
          descriptor,
          sink: input.dateProbe,
          screenshotsDir: input.screenshotsDir,
          ordinal: input.ordinal,
        });
      }
      try {
        const performed = await perform(page, action, descriptor);
        typedValue = performed.typedValue;
        observation = `Executed ${describeAction(action, targetLabel)}${typedValue ? ` with "${typedValue}"` : ''}.`;
      } catch (error) {
        status = 'failed';
        observation = `Action failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }

  await markInteractive(page);
  const after = await signature(page);
  await unmark(page);
  const shot = await captureViewportJpeg(
    page,
    input.screenshotsDir,
    `agent-step-${String(input.ordinal).padStart(3, '0')}-${action.type}`,
  );
  return {
    status,
    observation,
    guard,
    screenshot: shot.path,
    before,
    after,
    target_label: targetLabel,
    typed_value: typedValue,
  };
}

/**
 * Runs before the real fill so the field is still untouched, and swallows every
 * failure: a probe exists to describe the control, never to fail the step.
 */
async function probeDateField(input: {
  page: Page;
  descriptor: MarkDescriptor;
  sink: DateProbeSink;
  screenshotsDir: string;
  ordinal: number;
}): Promise<void> {
  try {
    if (!isDateishMark(input.descriptor)) return;
    const key = dateFieldKey(input.page.url(), dateFieldLabel(input.descriptor));
    if (!input.sink.shouldProbe(key)) return;
    const probe = await probeDateControl({ page: input.page, mark: input.descriptor });
    if (!probe) return;
    // A dedicated file: step screenshots are thinned off disk as the run grows,
    // and a finding must keep its evidence.
    const shot = await captureViewportJpeg(
      input.page,
      input.screenshotsDir,
      `date-probe-${String(input.ordinal).padStart(3, '0')}`,
    ).catch(() => undefined);
    probe.screenshot = shot?.path;
    input.sink.record(probe);
  } catch {
    // Probing is best-effort.
  }
}

function semanticActionName(action: AgentAction, descriptor: MarkDescriptor | undefined): string {
  if (action.type === 'type' || action.type === 'select') return 'fill_form';
  if (action.type === 'click' && isConstructiveLabel(descriptor?.name ?? '').matched) {
    return 'submit_form';
  }
  return 'click_menu';
}

function guardAction(action: AgentAction, descriptor: MarkDescriptor | undefined, job: Job): GuardDecision {
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
    const allowedActions = parseAllowedActions(job.session.allowed_actions_json);
    if (allowedActions.length && !allowedActions.includes('fill_form')
      && !allowedActions.includes('create_record')
      && !allowedActions.includes('click_menu')) {
      return { allowed: false, reason: 'allowed_actions does not include fill_form' };
    }
    // Typing never commits — gate on credential/statutory patterns, not the click vocabulary.
    if (isUnsafeToFill({
      tag: (descriptor.tag === 'select' || descriptor.tag === 'textarea' ? descriptor.tag : 'input'),
      type: descriptor.type,
      name: descriptor.name,
      id: '',
      placeholder: '',
      ariaLabel: descriptor.name,
      label: descriptor.name,
      required: false,
    })) {
      return {
        allowed: false,
        reason: 'field is credential, OTP, or a statutory identifier and must not be filled',
        matchedToken: descriptor.name,
      };
    }
    return { allowed: true };
  }
  if (action.type === 'click'
    || (action.type === 'press' && action.key.toLowerCase() === 'enter')) {
    if ('mark' in action && !descriptor) return { allowed: false, reason: `mark ${action.mark} is not present` };
    return evaluateClick(descriptor?.name ?? action.type, {
      destructiveAllowed: Boolean(job.session.destructive_allowed),
      environment: job.profile.environment,
      allowSafeDemo: Boolean(job.profile.allow_safe_demo),
      allowedActions: parseAllowedActions(job.session.allowed_actions_json),
    }, semanticActionName(action, descriptor));
  }
  return { allowed: true };
}

async function perform(
  page: Page,
  action: AgentAction,
  descriptor?: MarkDescriptor,
): Promise<{ typedValue?: string }> {
  let typedValue: string | undefined;
  switch (action.type) {
    case 'click':
      await page.locator(`[data-smoke-mark="${action.mark}"]`).click({ timeout: 10_000 });
      break;
    case 'type': {
      const target = page.locator(`[data-smoke-mark="${action.mark}"]`);
      const hint = { type: descriptor?.type, name: descriptor?.name, tag: descriptor?.tag };
      typedValue = applyMarker(coerceForField(action.text, hint), hint);
      await target.fill(typedValue, { timeout: 10_000 });
      if (action.submit) await target.press('Enter');
      break;
    }
    case 'select':
      await page.locator(`[data-smoke-mark="${action.mark}"]`).selectOption({ label: action.option })
        .catch(() => page.locator(`[data-smoke-mark="${action.mark}"]`).selectOption(action.option));
      break;
    case 'press':
      await page.keyboard.press(action.key);
      break;
    case 'scroll':
      await page.mouse.wheel(0, (action.direction === 'down' ? 1 : -1) * Math.max(100, Math.min(2000, action.amount)));
      break;
    case 'navigate':
      await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
      await page.waitForLoadState('domcontentloaded', { timeout: 8_000 }).catch(() => {});
      break;
    case 'wait':
      await page.waitForTimeout(Math.max(0, Math.min(10_000, action.ms)));
      break;
    case 'done':
    case 'blocked':
    case 'ask_operator':
      break;
  }
  if (action.type !== 'wait' && action.type !== 'done' && action.type !== 'blocked' && action.type !== 'ask_operator') {
    await waitForSettle(page);
  }
  return { typedValue };
}

function describeAction(action: AgentAction, label: string): string {
  if ('mark' in action) {
    return label
      ? `${action.type} "${label}" (mark ${action.mark})`
      : `${action.type} on mark ${action.mark}`;
  }
  if (action.type === 'navigate') return `navigate to ${action.url}`;
  return action.type;
}
