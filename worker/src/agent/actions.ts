import type { Page } from 'playwright';
import type { Job } from '../backend.js';
import { evaluateHostGuard } from '../utils/hostGuard.js';
import { evaluateClick, parseAllowedActions, type GuardDecision } from '../utils/safeActionGuard.js';
import { markInteractive, unmark, type MarkDescriptor } from './marks.js';
import { captureViewportJpeg, signature, type PageSignature } from './perceive.js';

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
  signature_before: PageSignature;
  signature_after: PageSignature;
  signature_changed: boolean;
};

export async function executeAction(input: {
  page: Page;
  job: Job;
  action: AgentAction;
  marks: MarkDescriptor[];
  screenshotsDir: string;
  ordinal: number;
}): Promise<ActionOutcome> {
  const { page, job, action, marks } = input;
  const before = await signature(page);
  const descriptor = 'mark' in action ? marks.find((item) => item.mark === action.mark) : undefined;
  let guard: GuardDecision = { allowed: true };
  let status: ActionOutcome['status'] = 'executed';
  let observation = '';

  if (action.type === 'done' || action.type === 'blocked' || action.type === 'ask_operator') {
    status = 'terminal';
    observation = action.type === 'ask_operator' ? action.question : action.reason;
  } else {
    guard = guardAction(action, descriptor, job);
    if (!guard.allowed) {
      status = 'refused';
      observation = `That control is destructive or disallowed on this tier: ${guard.reason ?? 'blocked by safety guard'}. Choose another action.`;
    } else {
      try {
        await perform(page, action);
        observation = `Executed ${describeAction(action)}.`;
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
  return { status, observation, guard, screenshot: shot.path, before, after };
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
  if (action.type === 'click' || action.type === 'type' || action.type === 'select'
    || (action.type === 'press' && action.key.toLowerCase() === 'enter')) {
    if ('mark' in action && !descriptor) return { allowed: false, reason: `mark ${action.mark} is not present` };
    return evaluateClick(descriptor?.name ?? action.type, {
      destructiveAllowed: Boolean(job.session.destructive_allowed),
      environment: job.profile.environment,
      allowSafeDemo: Boolean(job.profile.allow_safe_demo),
      allowedActions: parseAllowedActions(job.session.allowed_actions_json),
    });
  }
  return { allowed: true };
}

async function perform(page: Page, action: AgentAction): Promise<void> {
  switch (action.type) {
    case 'click':
      await page.locator(`[data-smoke-mark="${action.mark}"]`).click({ timeout: 10_000 });
      break;
    case 'type': {
      const target = page.locator(`[data-smoke-mark="${action.mark}"]`);
      await target.fill(action.text, { timeout: 10_000 });
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
      break;
    case 'wait':
      await page.waitForTimeout(Math.max(0, Math.min(10_000, action.ms)));
      break;
    case 'done':
    case 'blocked':
    case 'ask_operator':
      break;
  }
  await page.waitForLoadState('domcontentloaded', { timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(250);
}

function describeAction(action: AgentAction): string {
  if ('mark' in action) return `${action.type} on mark ${action.mark}`;
  if (action.type === 'navigate') return `navigate to ${action.url}`;
  return action.type;
}
