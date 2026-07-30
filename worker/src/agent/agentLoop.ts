import fs from 'node:fs/promises';
import type { Page } from 'playwright';
import type { Job } from '../backend.js';
import { BrainUnavailableError, invokeBrain } from '../brain/ensemble.js';
import { config } from '../config.js';
import { requestFormValues } from '../data/syntheticData.js';
import { askOrRecallDecision, type DecisionOption } from '../nav/askDecision.js';
import { executeAction, type AgentAction, type AgentStepRecord } from './actions.js';
import { markInteractive, type MarkDescriptor } from './marks.js';
import { captureViewportJpeg, signature, signatureKey, type PageSignature } from './perceive.js';

export type AgentLoopResult = {
  status: 'done' | 'blocked' | 'budget' | 'operator';
  reason: string;
  steps: AgentStepRecord[];
  screenCount: number;
};

type ModelDecision = {
  observation: string;
  reasoning: string;
  action: AgentAction;
  goal_progress: string;
  blockers: string[];
};

const SYSTEM_PROMPT = `You are a visual smoke-testing agent operating a signed-in web app.
Use only numbered Set-of-Marks controls supplied in the prompt. Never invent selectors or marks.

Creation mode (required for a successful run):
- In every module that supports creating records, attempt ONE end-to-end synthetic create:
  open the create/add form, fill every required field (prefer suggested_values when present),
  save/submit, then verify the new record appears in the list before moving on.
- All free-text values you type MUST begin with "SMOKE-" (emails may use a smoke. local-part).
- Never fill credential, OTP, captcha, password, GSTIN, PAN, Aadhaar, bank account, IFSC or CIN fields.
- Never click irreversible controls (delete, remove, approve, reject, pay, refund, void, transfer,
  send, sign out, efile, close period, finalize). If the only path forward is irreversible,
  choose another route or return blocked.
- Treat safety-guard refusals as expected and route around them — do not retry the same refused control.

Explore the requested session scope, create synthetic records where possible, inspect meaningful
screens (including reports fed by that data), and stop when the goal is covered.
Return JSON only:
{"observation":"","reasoning":"","action":{"type":"click","mark":1},"goal_progress":"","blockers":[]}
Allowed action types: click, type, select, press, scroll, navigate, wait, done, blocked, ask_operator.`;

export async function runAgentLoop(input: {
  page: Page;
  job: Job;
  goal: string;
  budget: number;
  screenshotsDir: string;
  onStep?: (step: AgentStepRecord) => Promise<void>;
  onLoopWarning?: (message: string) => Promise<void>;
}): Promise<AgentLoopResult> {
  const steps: AgentStepRecord[] = [];
  const recentTriples: string[] = [];
  let priorSignature = await signature(input.page);
  let unchangedCount = 0;
  let stuckWarnings = 0;
  let feedback = '';
  const suggestedCache = new Map<string, Record<string, string>>();
  // Retention only thins stored screenshots; it must not cap how many actions the
  // agent may take before the session's own budget is spent.
  const budget = Math.max(1, input.budget);

  for (let ordinal = 1; ordinal <= budget; ordinal += 1) {
    const marks = await markInteractive(input.page);
    const markedShot = await captureViewportJpeg(
      input.page,
      input.screenshotsDir,
      `agent-decision-${String(ordinal).padStart(3, '0')}`,
    );
    const current = await signature(input.page);
    const suggestedValues = await loadSuggestedValues({
      page: input.page,
      job: input.job,
      marks,
      current,
      cache: suggestedCache,
    });
    const history = steps.slice(-6).map((step) => ({
      action: step.action,
      outcome: step.outcome,
      observation: step.outcome_observation,
      url: step.signature_after.url,
      target: step.target_label,
    }));
    const prompt = JSON.stringify({
      goal: input.goal,
      current: { url: current.url, title: current.title },
      elements: marks,
      suggested_values: Object.keys(suggestedValues).length ? suggestedValues : undefined,
      recent_actions: history,
      prior_feedback: feedback || undefined,
      budget: { step: ordinal, maximum: budget },
      stuck_warning: stuckWarnings > 0
        ? 'The page/action pattern is repeating without screen change. Choose a materially different action or return blocked.'
        : undefined,
    });
    let response: Awaited<ReturnType<typeof invokeBrain>>;
    try {
      response = await invokeBrain(
        'vision_agent',
        SYSTEM_PROMPT,
        prompt,
        {
          expect_json: true,
          product: input.job.run.product_name,
          environment: input.job.profile.environment,
          session_id: input.job.session.id,
        },
        [{ mime_type: 'image/jpeg', data: markedShot.base64 }],
      );
    } finally {
      await fs.unlink(markedShot.path).catch(() => {});
    }
    const decision = parseDecision(response.final);
    const outcome = await executeAction({
      page: input.page,
      job: input.job,
      action: decision.action,
      marks,
      screenshotsDir: input.screenshotsDir,
      ordinal,
    });
    const changed = signatureKey(outcome.before) !== signatureKey(outcome.after);
    const step: AgentStepRecord = {
      ordinal,
      captured_at: new Date().toISOString(),
      screenshot: outcome.screenshot ?? '',
      observation: decision.observation,
      reasoning: decision.reasoning,
      goal_progress: decision.goal_progress,
      blockers: decision.blockers,
      action: decision.action,
      outcome: outcome.status,
      outcome_observation: outcome.observation,
      guard: outcome.guard,
      target_label: outcome.target_label,
      typed_value: outcome.typed_value,
      signature_before: outcome.before,
      signature_after: outcome.after,
      signature_changed: changed,
    };
    steps.push(step);
    await thinStepScreenshots(steps, config.stepScreenshotRetention);
    await input.onStep?.(step);
    feedback = outcome.observation;

    const loop = evaluateLoopDetection({
      action: decision.action,
      before: outcome.before,
      after: outcome.after,
      recentTriples,
      unchangedCount,
      priorSignature,
    });
    recentTriples.splice(0, recentTriples.length, ...loop.recentTriples);
    unchangedCount = loop.unchangedCount;
    priorSignature = loop.priorSignature;
    if (loop.warned) {
      stuckWarnings += 1;
      feedback += ' Loop detection fired; take a different route.';
      await input.onLoopWarning?.(
        `Loop detection warning ${stuckWarnings}/3: stalled action pattern or unchanged page.`,
      );
      if (stuckWarnings >= 3) {
        return {
          status: 'blocked',
          reason: 'Repeated actions or unchanged page after three warnings.',
          steps,
          screenCount: steps.length,
        };
      }
    }

    if (decision.action.type === 'done') {
      return { status: 'done', reason: decision.action.reason, steps, screenCount: steps.length };
    }
    if (decision.action.type === 'blocked') {
      return { status: 'blocked', reason: decision.action.reason, steps, screenCount: steps.length };
    }
    if (decision.action.type === 'ask_operator') {
      const operator = await escalateToOperator(input, decision.action, outcome.screenshot);
      if (operator === 'abort_session') {
        return { status: 'operator', reason: decision.action.question, steps, screenCount: steps.length };
      }
      feedback = 'Operator requested that the agent continue and try a different route.';
    }
  }
  return { status: 'budget', reason: `Action budget of ${budget} exhausted.`, steps, screenCount: steps.length };
}

/** Exported for unit tests — pure loop-detection state update. */
export function evaluateLoopDetection(input: {
  action: AgentAction;
  before: PageSignature;
  after: PageSignature;
  recentTriples: string[];
  unchangedCount: number;
  priorSignature: PageSignature;
}): {
  recentTriples: string[];
  unchangedCount: number;
  priorSignature: PageSignature;
  warned: boolean;
} {
  const changed = signatureKey(input.before) !== signatureKey(input.after);
  const recentTriples = [...input.recentTriples];
  let unchangedCount = signatureKey(input.priorSignature) === signatureKey(input.after)
    ? input.unchangedCount + 1
    : 0;

  if (changed) {
    // Progress: clear stalled-action history.
    recentTriples.length = 0;
  } else {
    const triple = actionTriple(input.action, input.before);
    recentTriples.push(triple);
    if (recentTriples.length > 12) recentTriples.shift();
  }

  const tripleRepeats = !changed
    && recentTriples.filter((value) => value === actionTriple(input.action, input.before)).length >= 5;
  const warned = tripleRepeats || unchangedCount >= 6;
  if (warned) unchangedCount = 0;

  return {
    recentTriples,
    unchangedCount,
    priorSignature: input.after,
    warned,
  };
}

async function loadSuggestedValues(input: {
  page: Page;
  job: Job;
  marks: MarkDescriptor[];
  current: PageSignature;
  cache: Map<string, Record<string, string>>;
}): Promise<Record<string, string>> {
  const emptyInputs = input.marks.filter((mark) => {
    const tag = mark.tag.toLowerCase();
    if (tag !== 'input' && tag !== 'textarea') return false;
    if (mark.disabled) return false;
    const type = mark.type.toLowerCase();
    if (['hidden', 'password', 'file', 'submit', 'button', 'checkbox', 'radio'].includes(type)) return false;
    return !String(mark.value || '').trim();
  });
  if (emptyInputs.length < 3) return {};
  const cacheKey = `${signatureKey(input.current)}|${emptyInputs.map((m) => m.name).join('|')}`;
  const cached = input.cache.get(cacheKey);
  if (cached) return cached;
  try {
    const result = await requestFormValues({
      marks: input.marks,
      product: input.job.run.product_name,
      environment: input.job.profile.environment,
      sessionName: input.job.session.name,
      url: input.current.url,
    });
    input.cache.set(cacheKey, result.fields);
    return result.fields;
  } catch (error) {
    if (error instanceof BrainUnavailableError) throw error;
    return {};
  }
}

function parseDecision(value: unknown): ModelDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Vision model returned a non-object decision.');
  }
  const row = value as Record<string, unknown>;
  const action = parseAgentAction(row.action);
  return {
    observation: String(row.observation ?? ''),
    reasoning: String(row.reasoning ?? ''),
    action,
    goal_progress: String(row.goal_progress ?? ''),
    blockers: Array.isArray(row.blockers) ? row.blockers.map(String) : [],
  };
}

export function parseAgentAction(value: unknown): AgentAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Vision decision has no action object.');
  const action = value as Record<string, unknown>;
  const type = String(action.type ?? '');
  if (type === 'click') return { type, mark: positiveMark(action.mark) };
  if (type === 'type') return { type, mark: positiveMark(action.mark), text: String(action.text ?? ''), submit: Boolean(action.submit) };
  if (type === 'select') return { type, mark: positiveMark(action.mark), option: String(action.option ?? '') };
  if (type === 'press') return { type, key: String(action.key ?? '') || 'Escape' };
  if (type === 'scroll') return {
    type,
    direction: action.direction === 'up' ? 'up' : 'down',
    amount: Math.max(100, Math.min(2000, Number(action.amount) || 700)),
  };
  if (type === 'navigate') return { type, url: String(action.url ?? '') };
  if (type === 'wait') return { type, ms: Math.max(0, Number(action.ms) || 500) };
  if (type === 'done' || type === 'blocked') return { type, reason: String(action.reason ?? '') };
  if (type === 'ask_operator') return {
    type,
    question: String(action.question ?? 'How should the smoke run proceed?'),
    options: Array.isArray(action.options) ? action.options.map(String) : [],
  };
  throw new Error(`Vision decision contains unsupported action type "${type}".`);
}

function positiveMark(value: unknown): number {
  const mark = Number(value);
  if (!Number.isInteger(mark) || mark <= 0) throw new Error(`Invalid Set-of-Marks target "${String(value)}".`);
  return mark;
}

export function actionTriple(action: AgentAction, sig: PageSignature): string {
  return `${action.type}|${'mark' in action ? action.mark : ''}|${signatureKey(sig)}`;
}

async function escalateToOperator(
  input: Parameters<typeof runAgentLoop>[0],
  action: Extract<AgentAction, { type: 'ask_operator' }>,
  screenshotPath?: string,
): Promise<string> {
  const options: DecisionOption[] = [
    { id: 'continue', label: action.options[0] || 'Continue and try another route', action: 'rescan_menus' },
    { id: 'abort_session', label: 'Abort this session', action: 'abort_session' },
  ];
  const choice = await askOrRecallDecision({
    job: input.job,
    page: input.page,
    situationKey: `vision_agent:${action.question}`.slice(0, 191),
    question: action.question,
    options,
    screenshotPath,
    context: { source: 'vision_agent', offered_options: action.options },
  });
  return choice.option.id;
}

/** Keep the newest N step screenshots on disk; older ones stay in the timeline without files. */
async function thinStepScreenshots(steps: AgentStepRecord[], keep: number): Promise<void> {
  const withShots = steps.filter((step) => step.screenshot);
  const excess = withShots.length - keep;
  if (excess <= 0) return;
  for (const step of withShots.slice(0, excess)) {
    const path = step.screenshot;
    step.screenshot = '';
    await fs.unlink(path).catch(() => {});
  }
}
