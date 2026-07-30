import type { Page } from 'playwright';
import type { Job } from '../backend.js';
import type { GuardDecision } from '../utils/safeActionGuard.js';
import { guardAction } from './actionGuard.js';
import { runBatchFill, type FillEntry, type FillResult } from './batchFill.js';
import { probeDateFieldBeforeFill, type DateProbeSink } from './dateFieldProbe.js';
import { resolveTypedValue } from './fieldValue.js';
import { markInteractive, unmark, type MarkDescriptor } from './marks.js';
import { captureViewportJpeg, signature, waitForSettle, type PageSignature } from './perceive.js';

export type { DateProbeSink } from './dateFieldProbe.js';
export type { FillEntry, FillResult } from './batchFill.js';

export type AgentAction =
  | { type: 'click'; mark: number }
  | { type: 'type'; mark: number; text: string; submit?: boolean }
  | { type: 'select'; mark: number; option: string }
  /** Write every field of a form from one decision. See `batchFill.ts`. */
  | { type: 'fill_form'; fields: FillEntry[] }
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
  /** Per-field detail of a `fill_form` step; absent for every other action. */
  fill_results?: FillResult[];
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
  fill_results?: FillResult[];
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
  dateProbe?: DateProbeSink;
}): Promise<ActionOutcome> {
  const { page, job, action, marks } = input;
  const before = await signature(page);
  const descriptor = 'mark' in action ? marks.find((item) => item.mark === action.mark) : undefined;
  let targetLabel = descriptor?.name ?? '';
  let guard: GuardDecision = { allowed: true };
  let status: ActionOutcome['status'] = 'executed';
  let observation = '';
  let typedValue: string | undefined;
  let fillResults: FillResult[] | undefined;

  if (action.type === 'done' || action.type === 'blocked' || action.type === 'ask_operator') {
    status = 'terminal';
    observation = action.type === 'ask_operator' ? action.question : action.reason;
  } else if (action.type === 'fill_form') {
    // Guarded field by field inside the batch rather than once up front, so a
    // credential field among ten safe ones costs that one field and not the
    // whole form.
    const batch = await runBatchFill({
      page,
      job,
      fields: action.fields,
      marks,
      screenshotsDir: input.screenshotsDir,
      ordinal: input.ordinal,
      dateProbe: input.dateProbe,
    });
    status = batch.status;
    observation = batch.observation;
    guard = batch.guard;
    fillResults = batch.results;
    const written = batch.results.filter((result) => result.status === 'filled' || result.status === 'chosen');
    targetLabel = `${written.length} of ${batch.results.length} fields`;
  } else {
    guard = guardAction(action, descriptor, job);
    if (!guard.allowed) {
      status = 'refused';
      observation = `That control is destructive or disallowed on this tier: ${guard.reason ?? 'blocked by safety guard'}. Choose another action.`;
    } else {
      if (action.type === 'type' && descriptor && input.dateProbe) {
        await probeDateFieldBeforeFill({
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
        // Surface a marker-rewritten value explicitly: the model cannot control
        // what the synthetic-data marker does to what it typed, and without this
        // note it kept re-fighting a value it had already "lost" the argument on.
        observation = performed.adjustedFrom
          ? `Typed "${typedValue}" (adjusted from "${performed.adjustedFrom}" by the synthetic-data marker) into "${targetLabel || 'the field'}".`
          : `Executed ${describeAction(action, targetLabel)}${typedValue ? ` with "${typedValue}"` : ''}.`;
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
    fill_results: fillResults,
  };
}

async function perform(
  page: Page,
  action: AgentAction,
  descriptor?: MarkDescriptor,
): Promise<{ typedValue?: string; adjustedFrom?: string }> {
  let typedValue: string | undefined;
  let adjustedFrom: string | undefined;
  switch (action.type) {
    case 'click':
      await page.locator(`[data-smoke-mark="${action.mark}"]`).click({ timeout: 10_000 });
      break;
    case 'type': {
      const target = page.locator(`[data-smoke-mark="${action.mark}"]`);
      const resolved = resolveTypedValue(action.text, descriptor);
      typedValue = resolved.typedValue;
      adjustedFrom = resolved.adjustedFrom;
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
    case 'fill_form':
    case 'done':
    case 'blocked':
    case 'ask_operator':
      break;
  }
  if (action.type !== 'wait' && action.type !== 'done' && action.type !== 'blocked'
    && action.type !== 'ask_operator' && action.type !== 'fill_form') {
    await waitForSettle(page);
  }
  return { typedValue, adjustedFrom };
}

function describeAction(action: AgentAction, label: string): string {
  if ('mark' in action) {
    return label
      ? `${action.type} "${label}" (mark ${action.mark})`
      : `${action.type} on mark ${action.mark}`;
  }
  if (action.type === 'navigate') return `navigate to ${action.url}`;
  if (action.type === 'fill_form') return `fill_form across ${action.fields.length} fields`;
  return action.type;
}
