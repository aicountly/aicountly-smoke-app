import fs from 'node:fs/promises';
import type { Page } from 'playwright';
import type { Job } from '../backend.js';
import { BrainUnavailableError, invokeBrain } from '../brain/ensemble.js';
import { config } from '../config.js';
import { requestFormValues } from '../data/syntheticData.js';
import { askOrRecallDecision, type DecisionOption } from '../nav/askDecision.js';
import type { UxIssue } from '../reviewer/uxReviewEngine.js';
import { isConstructiveLabel } from '../utils/safeActionGuard.js';
import { executeAction, type AgentAction, type AgentStepRecord } from './actions.js';
import {
  buildDateFindings,
  buildNativeLocaleFinding,
  dateFieldKey,
  DATE_PROBE_CAP,
  type DateProbe,
} from './dateFieldProbe.js';
import { countOffscreen, markInteractive, type MarkDescriptor } from './marks.js';
import {
  captureViewportJpeg,
  scrollExtent,
  signature,
  signatureKey,
  type PageSignature,
} from './perceive.js';

export type AgentLoopResult = {
  status: 'done' | 'blocked' | 'budget' | 'operator';
  reason: string;
  steps: AgentStepRecord[];
  screenCount: number;
  /** Records this session likely created and did not have to re-attempt. See `CreatedRecord`. */
  createdRecords: CreatedRecord[];
};

type ModelDecision = {
  observation: string;
  reasoning: string;
  action: AgentAction;
  goal_progress: string;
  blockers: string[];
};

/** A likely-successful create, tracked so the model is not sent to create the same entity twice. */
export type CreatedRecord = {
  url: string;
  formKey: string;
  values: Record<string, string>;
  verifiedInList: boolean;
};

/** Lowercased alphanumeric tokens, 3+ chars, for cheap "does this screen relate to that scope" checks. */
function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3),
  );
}

/** The goal string states "Scope: <menu_path>"; fall back to the whole goal if that marker is absent. */
function scopeTokensFromGoal(goal: string): Set<string> {
  const match = /Scope:\s*([^\n]+)/i.exec(goal);
  return tokenize(match ? match[1] : goal);
}

function pathSegmentCount(url: string): number {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).length;
  } catch {
    return 0;
  }
}

const SYSTEM_PROMPT = `You are a visual smoke-testing agent operating a signed-in web app.
Use only numbered Set-of-Marks controls supplied in the prompt. Never invent selectors or marks.

Creation mode (required for a successful run):
- In every module that supports creating records, attempt ONE end-to-end synthetic create:
  open the create/add form, fill every required field (prefer suggested_values when present),
  save/submit, then verify the new record appears in the list before moving on.
- Once session_facts.records_already_created lists a verified create for a module, stop creating
  in that module and move to observation/reports — do not attempt a second create of the same
  entity type in the same session.
- Only create records inside this session's stated Scope (see the goal's menu_path). If you
  navigate outside the session's declared module to create something, stop and use "blocked"
  instead.
- Free-TEXT values you type MUST begin with "SMOKE-" (emails may use a smoke. local-part).
  Never prefix a value a validator reads as a number: phone/mobile/WhatsApp, amounts,
  quantities, PIN codes, dates and times are typed bare. Dates may be typed as dd/mm/yyyy.
- Never fill credential, OTP, captcha, password, GSTIN, PAN, Aadhaar, bank account, IFSC or CIN fields.
- Prefer not to click irreversible controls (delete, remove, approve, reject, pay, refund, void,
  transfer, send, efile, close period, finalize). If you must use delete or approve, do so ONLY on
  a record this session created itself (identifiable by the SMOKE- marker). Never sign out.
- Treat safety-guard refusals as expected and route around them — do not retry the same refused control.
- Bare Cancel / Close / Dismiss / Back may be used freely to clear modals and return from forms.

Reading the elements list:
- It covers the whole page, not just the visible part. Entries flagged "offscreen":true sit outside
  the viewport (viewport_offset is pixels above, if negative, or below, if positive) and carry no
  badge in the screenshot. Clicking one still works: it is scrolled into view first.
- A control you saw earlier and cannot find now is almost always below the fold, not missing.
  Scroll to it or click its offscreen mark before concluding the app has no such control.
- After submitting a form, read the validation messages on screen and fix the named fields rather
  than resubmitting unchanged.

Explore the requested session scope, create synthetic records where possible, inspect meaningful
screens (including reports fed by that data), and stop when the goal is covered.
Return JSON only:
{"observation":"","reasoning":"","action":{"type":"click","mark":1},"goal_progress":"","blockers":[]}
Allowed action types: click, type, select, press, scroll, navigate, wait, done, blocked, ask_operator.`;

const SYNTHETIC_DATA_CALL_CAP = 8;

export async function runAgentLoop(input: {
  page: Page;
  job: Job;
  goal: string;
  budget: number;
  screenshotsDir: string;
  onStep?: (step: AgentStepRecord) => Promise<void>;
  onLoopWarning?: (message: string) => Promise<void>;
  onFinding?: (issue: UxIssue) => void;
}): Promise<AgentLoopResult> {
  const steps: AgentStepRecord[] = [];
  const recentTriples: string[] = [];
  let priorSignature = await signature(input.page);
  let unchangedCount = 0;
  let stuckWarnings = 0;
  let feedback = '';
  const suggestedCache = new Map<string, Record<string, string>>();
  let syntheticDataCalls = 0;
  const dateProbes: DateProbe[] = [];
  const probedDateFields = new Set<string>();
  const dateProbe = {
    shouldProbe: (key: string) => dateProbes.length < DATE_PROBE_CAP && !probedDateFields.has(key),
    record: (probe: DateProbe) => {
      probedDateFields.add(dateFieldKey(probe.url, probe.label));
      dateProbes.push(probe);
      for (const issue of buildDateFindings(probe)) input.onFinding?.(issue);
    },
  };
  // The locale note describes the session as a whole, so it is raised once, on
  // the way out, whichever way the loop ends. createdRecords is injected here
  // rather than at every call site, since every exit path funnels through this
  // one function and the ledger is only ever appended to, never replaced.
  const finish = (result: Omit<AgentLoopResult, 'createdRecords'>): AgentLoopResult => {
    const nativeNote = buildNativeLocaleFinding(dateProbes);
    if (nativeNote) input.onFinding?.(nativeNote);
    return { ...result, createdRecords };
  };
  let blockedRefusals = 0;
  let consecutiveScrolls = 0;
  let deepestScrollSeen = 0;
  // Retention only thins stored screenshots; it must not cap how many actions the
  // agent may take before the session's own budget is spent.
  const budget = Math.max(1, input.budget);

  // Created-record ledger: a submit-style click that changed the URL or the DOM
  // is our best available signal of "this probably created something", since we
  // have no product-specific oracle for "the record now exists". Reused to (a)
  // tell the model not to attempt a second create of the same entity and (b)
  // invalidate the synthetic-value cache so a repeat visit to the same form gets
  // fresh values instead of replaying one that will now collide on a unique key.
  const createdRecords: CreatedRecord[] = [];

  // Scope-not-found exit (see the check below, after the loop-detection block,
  // for the exact heuristic and its rationale).
  const scopeTokens = scopeTokensFromGoal(input.goal);
  const topLevelLabelsClicked = new Set<string>();
  // No parseable scope means we cannot judge "found the scope", so the heuristic
  // is disabled by treating it as already satisfied — conservative by design.
  let scopeSeen = scopeTokens.size === 0;

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
      callBudget: {
        used: syntheticDataCalls,
        maximum: SYNTHETIC_DATA_CALL_CAP,
        consume: () => { syntheticDataCalls += 1; },
      },
    });
    const history = steps.slice(-6).map((step) => ({
      action: step.action,
      outcome: step.outcome,
      observation: step.outcome_observation,
      url: step.signature_after.url,
      target: step.target_label,
    }));
    const scroll = await scrollExtent(input.page);
    deepestScrollSeen = Math.max(deepestScrollSeen, scroll.y);
    const submitted = submittedControls(steps);
    const sessionFacts: Record<string, unknown> = {};
    if (submitted.length) sessionFacts.submit_controls_already_clicked = submitted;
    if (createdRecords.length) {
      sessionFacts.records_already_created = createdRecords.map((record) => ({
        url: record.url,
        values: record.values,
        verified: record.verifiedInList,
      }));
    }
    const prompt = JSON.stringify({
      goal: input.goal,
      current: { url: current.url, title: current.title },
      elements: marks,
      viewport: {
        scroll_y: scroll.y,
        max_scroll_y: scroll.maxY,
        height: scroll.height,
        offscreen_controls: countOffscreen(marks),
      },
      // The recent-actions window is short, so successes the agent must not forget
      // are restated for the whole session.
      session_facts: Object.keys(sessionFacts).length ? sessionFacts : undefined,
      suggested_values: Object.keys(suggestedValues).length ? suggestedValues : undefined,
      recent_actions: history,
      prior_feedback: feedback || undefined,
      budget: { step: ordinal, maximum: budget },
      stuck_warning: stuckWarnings > 0
        ? 'The page/action pattern is repeating without screen change. Choose a materially different action or return blocked.'
        : undefined,
      scroll_warning: consecutiveScrolls >= 3
        ? 'You have scrolled three times in a row without acting. Act on a control now, or say precisely which control is missing.'
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
      dateProbe: input.onFinding ? dateProbe : undefined,
    });
    const changed = signatureKey(outcome.before) !== signatureKey(outcome.after);
    // "I cannot find the button" is refutable from what this session already did.
    // Push back once, then respect the answer so the loop always terminates.
    const refutation = decision.action.type === 'blocked'
      ? evaluateBlockedDecision({
        steps,
        submitted,
        scroll: { y: scroll.y, maxY: scroll.maxY, deepestSeen: deepestScrollSeen },
        refusalsUsed: blockedRefusals,
        reason: decision.action.reason,
      })
      : null;
    const step: AgentStepRecord = {
      ordinal,
      captured_at: new Date().toISOString(),
      screenshot: outcome.screenshot ?? '',
      observation: decision.observation,
      reasoning: decision.reasoning,
      goal_progress: decision.goal_progress,
      blockers: decision.blockers,
      action: decision.action,
      outcome: refutation ? 'refused' : outcome.status,
      outcome_observation: refutation ?? outcome.observation,
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
    feedback = step.outcome_observation;
    consecutiveScrolls = decision.action.type === 'scroll' ? consecutiveScrolls + 1 : 0;

    // Created-record ledger: a submit-style click (isConstructiveLabel or the
    // COMMITS_FORM vocabulary, same test submittedControls uses) that executed
    // and was followed by a URL or DOM change is the closest thing we have to a
    // "this probably created something" oracle. Recorded so the prompt can tell
    // the model not to create the same entity twice, and so the synthetic-value
    // cache for that form is invalidated (a second visit must get fresh values
    // rather than replay ones that will now collide on a unique key).
    if (decision.action.type === 'click' && outcome.status === 'executed'
      && looksLikeSubmitLabel(outcome.target_label)
      && (outcome.before.url !== outcome.after.url || outcome.before.domHash !== outcome.after.domHash)) {
      const formKey = formIdentityKey(current, marks);
      createdRecords.push({
        url: outcome.before.url,
        formKey,
        values: recentFieldValues(steps.slice(0, -1), outcome.before.url),
        verifiedInList: true,
      });
      suggestedCache.delete(formKey);
    }

    // Scope-not-found exit. Heuristic: parse "Scope: <menu_path>" out of the goal
    // into lowercased tokens (3+ chars). A screen "matches scope" once its URL or
    // title shares a token with menu_path. Until that happens, count the number
    // of distinct labels the model has clicked that landed on a top-level page
    // (URL path segment count <=1 — i.e. bouncing between sidebar destinations
    // rather than drilling into one). After step 15, once six or more distinct
    // top-level destinations have been tried with no scope match, the model is
    // visibly failing to find the module (the "Performance" case, where no such
    // module exists) — stop the session well short of the full step budget
    // instead of letting it exhaust the budget bouncing around navigation.
    if (!scopeSeen) {
      const screenTokens = tokenize(`${outcome.after.url} ${outcome.after.title}`);
      if ([...scopeTokens].some((token) => screenTokens.has(token))) {
        scopeSeen = true;
      } else {
        if (decision.action.type === 'click' && outcome.status === 'executed'
          && pathSegmentCount(outcome.after.url) <= 1 && step.target_label) {
          topLevelLabelsClicked.add(step.target_label.trim().toLowerCase());
        }
        if (ordinal > 15 && topLevelLabelsClicked.size > 6) {
          return finish({
            status: 'blocked',
            reason: 'Session scope was not found in the application navigation after exhaustive search.',
            steps,
            screenCount: steps.length,
          });
        }
      }
    }

    const loop = evaluateLoopDetection({
      action: decision.action,
      before: outcome.before,
      after: outcome.after,
      recentTriples,
      unchangedCount,
      priorSignature,
      consecutiveScrolls,
    });
    recentTriples.splice(0, recentTriples.length, ...loop.recentTriples);
    unchangedCount = loop.unchangedCount;
    priorSignature = loop.priorSignature;
    if (loop.warned) {
      stuckWarnings += 1;
      feedback += ' Loop detection fired; take a different route.';
      await input.onLoopWarning?.(
        `Loop detection warning ${stuckWarnings}/3: ${
          consecutiveScrolls >= 4 ? 'four or more scrolls in a row without acting' : 'stalled action pattern or unchanged page'
        }.`,
      );
      if (stuckWarnings >= 3) {
        return finish({
          status: 'blocked',
          reason: 'Repeated actions or unchanged page after three warnings.',
          steps,
          screenCount: steps.length,
        });
      }
    }

    if (decision.action.type === 'done') {
      return finish({ status: 'done', reason: decision.action.reason, steps, screenCount: steps.length });
    }
    if (decision.action.type === 'blocked') {
      if (!refutation) {
        return finish({ status: 'blocked', reason: decision.action.reason, steps, screenCount: steps.length });
      }
      blockedRefusals += 1;
      await input.onLoopWarning?.(`Refused a premature blocked: ${refutation}`);
    }
    if (decision.action.type === 'ask_operator') {
      const operator = await escalateToOperator(input, decision.action, outcome.screenshot);
      if (operator === 'abort_session') {
        return finish({ status: 'operator', reason: decision.action.question, steps, screenCount: steps.length });
      }
      feedback = 'Operator requested that the agent continue and try a different route.';
    }
  }
  return finish({ status: 'budget', reason: `Action budget of ${budget} exhausted.`, steps, screenCount: steps.length });
}

/** How many scrolls in a row, with no other action between them, counts as stuck. */
const SCROLL_RUN_LIMIT = 4;

/** Exported for unit tests — pure loop-detection state update. */
export function evaluateLoopDetection(input: {
  action: AgentAction;
  before: PageSignature;
  after: PageSignature;
  recentTriples: string[];
  unchangedCount: number;
  priorSignature: PageSignature;
  /** Consecutive `scroll` actions immediately preceding and including this one. */
  consecutiveScrolls?: number;
}): {
  recentTriples: string[];
  unchangedCount: number;
  priorSignature: PageSignature;
  warned: boolean;
} {
  const changed = signatureKey(input.before) !== signatureKey(input.after);
  const recentTriples = [...input.recentTriples];
  // type/select are exempt from the unchanged counter: formHash now changes when
  // a field's value changes, so a fill is already not "unchanged" in the normal
  // case — this is a defensive backstop for a field whose value round-trips to
  // the same string (e.g. a re-typed value identical to what was already there).
  const exemptFromUnchangedCounter = input.action.type === 'type' || input.action.type === 'select';
  let unchangedCount = exemptFromUnchangedCounter
    ? input.unchangedCount
    : (signatureKey(input.priorSignature) === signatureKey(input.after) ? input.unchangedCount + 1 : 0);

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
  // A scroll run used to only ever emit the advisory scroll_warning string in the
  // prompt, with no consequence if the model ignored it. It now counts toward
  // stuckWarnings exactly like a repeated action or an unchanging page.
  const scrollRunStuck = (input.consecutiveScrolls ?? 0) >= SCROLL_RUN_LIMIT;
  const warned = tripleRepeats || unchangedCount >= 6 || scrollRunStuck;
  if (warned) unchangedCount = 0;

  return {
    recentTriples,
    unchangedCount,
    priorSignature: input.after,
    warned,
  };
}

export type SubmittedControl = { mark: number; label: string; step: number };

/**
 * Labels that commit a form. Wider than the safety guard's constructive
 * vocabulary, which leaves out create and add on purpose so that an observer
 * session may still open a create form. Bare "add" stays out here too, because
 * "Add Employee" opens the form rather than saving it.
 */
const COMMITS_FORM = /\b(create|update|register|generate|insert|post)\b/i;

/** Shared by `submittedControls` and the created-record ledger. */
function looksLikeSubmitLabel(label: string): boolean {
  return isConstructiveLabel(label).matched || COMMITS_FORM.test(label);
}

/**
 * Best-effort reconstruction of "what did the model just fill in on this form":
 * the most recent type/select actions whose *before* screen was the same URL as
 * the submit click, most-recent-first collapsed to one entry per field label.
 */
function recentFieldValues(steps: AgentStepRecord[], url: string, limit = 20): Record<string, string> {
  const values: Record<string, string> = {};
  for (const step of steps.slice(-limit)) {
    if (step.action.type !== 'type' && step.action.type !== 'select') continue;
    if (step.signature_before.url !== url) continue;
    const label = step.target_label || `mark ${step.action.mark}`;
    const value = step.action.type === 'type' ? (step.typed_value ?? step.action.text) : step.action.option;
    values[label] = value;
  }
  return values;
}

/** Save/create controls this session has already clicked successfully. */
export function submittedControls(steps: AgentStepRecord[]): SubmittedControl[] {
  const seen = new Map<string, SubmittedControl>();
  for (const step of steps) {
    if (step.action.type !== 'click' || step.outcome !== 'executed') continue;
    const label = step.target_label;
    if (!looksLikeSubmitLabel(label)) continue;
    const key = step.target_label.trim().toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, { mark: step.action.mark, label: step.target_label, step: step.ordinal });
    }
  }
  return [...seen.values()];
}

/**
 * A `blocked` whose stated reason already says "the control was found and used,
 * but the result looks wrong" (e.g. "the record is not in the list") is not the
 * "I cannot find the control" claim the refutation below exists to catch — it is
 * a plausible product bug (a list that does not refetch after save) and must be
 * allowed through even though a submit control was clicked successfully.
 */
const REASON_ALREADY_ADMITS_CONTROL_WAS_USED =
  /not (?:in|on|appear|show|list|found in)|missing from (?:the )?list|does not appear/i;

/**
 * A `blocked` reason that already names a server-side refusal (permissions,
 * authorization, a 4xx/5xx) is not the "I cannot find the control" claim
 * `evaluateBlockedDecision` exists to refute either — the control was found
 * and used, and the target itself rejected it. Sending the agent back to
 * "scroll and try again" against a permissions error only burns the rest of
 * the step budget re-walking a form that was never going to be let through.
 */
const REASON_REPORTS_A_SERVER_REFUSAL =
  /insufficient permission|permission denied|access denied|not authori[sz]ed|unauthori[sz]ed|forbidden|\b(?:401|403|500|502|503|504)\b|server error/i;

function blockDescribesTheOutcome(reason: string): boolean {
  return REASON_ALREADY_ADMITS_CONTROL_WAS_USED.test(reason) || REASON_REPORTS_A_SERVER_REFUSAL.test(reason);
}

/**
 * A reason to send the agent back rather than end the session, or null to accept
 * the block. Judged on what the session did, never on how the model phrased it:
 * a model that has already clicked "Create employee master" three times cannot
 * also be right that no such control exists.
 */
export function evaluateBlockedDecision(input: {
  steps: AgentStepRecord[];
  submitted: SubmittedControl[];
  scroll: { y: number; maxY: number; deepestSeen: number };
  refusalsUsed: number;
  reason: string;
}): string | null {
  if (input.refusalsUsed >= 1) return null;
  if (input.submitted.length && !blockDescribesTheOutcome(input.reason)) {
    const list = input.submitted
      .map((control) => `"${control.label}" (mark ${control.mark}, step ${control.step})`)
      .join(', ');
    return `This session already clicked ${list} successfully, so that control exists on this screen. `
      + 'Controls outside the viewport are still listed with offscreen:true and are still clickable. '
      + 'Scroll to the submit control, read any validation message next to the fields it names, '
      + 'correct those fields and submit again.';
  }
  const unseen = input.scroll.maxY - input.scroll.deepestSeen;
  if (unseen > 200) {
    return `About ${unseen}px of this page has never been on screen, and the elements list already `
      + 'includes what is down there. Scroll down and act on the controls you find before giving up.';
  }
  return null;
}

function isEmptyFillableMark(mark: MarkDescriptor): boolean {
  const tag = mark.tag.toLowerCase();
  if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return false;
  if (mark.disabled) return false;
  const type = mark.type.toLowerCase();
  if (['hidden', 'password', 'file', 'submit', 'button', 'checkbox', 'radio', 'image'].includes(type)) {
    return false;
  }
  return !String(mark.value || '').trim();
}

/** Exported for unit tests — stable form identity for synthetic_data caching. */
export function formIdentityKey(current: PageSignature, marks: MarkDescriptor[]): string {
  const names = marks
    .filter((mark) => {
      const tag = mark.tag.toLowerCase();
      if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return false;
      if (mark.disabled) return false;
      const type = mark.type.toLowerCase();
      return !['hidden', 'password', 'file', 'submit', 'button', 'checkbox', 'radio', 'image'].includes(type);
    })
    .map((mark) => mark.name || `${mark.tag}:${mark.type}`)
    .sort();
  // Form identity — URL + title + field names. Deliberately omits domHash so
  // progressive filling of the same form reuses one synthetic_data response.
  return `${current.url}|${current.title}|${names.join('|')}`;
}

async function loadSuggestedValues(input: {
  page: Page;
  job: Job;
  marks: MarkDescriptor[];
  current: PageSignature;
  cache: Map<string, Record<string, string>>;
  callBudget: { used: number; maximum: number; consume: () => void };
}): Promise<Record<string, string>> {
  const emptyFields = input.marks.filter(isEmptyFillableMark);
  if (emptyFields.length < 3) return {};
  const cacheKey = formIdentityKey(input.current, input.marks);
  const cached = input.cache.get(cacheKey);
  if (cached) return cached;
  if (input.callBudget.used >= input.callBudget.maximum) return {};
  try {
    input.callBudget.consume();
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
