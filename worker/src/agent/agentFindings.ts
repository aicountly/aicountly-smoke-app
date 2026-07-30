import type { AgentStepRecord } from './actions.js';
import type { UxIssue } from '../reviewer/uxReviewEngine.js';
import { isConstructiveLabel } from '../utils/safeActionGuard.js';

/**
 * Turns evidence the vision agent already gathered (but only ever logged)
 * into UxIssue-shaped findings, so refused/failed/blocked steps and repeated
 * dead clicks reach the same reports and Cursor prompt pipeline as heuristic
 * page-level findings instead of being thrown away.
 */

const SUBMIT_LABEL_REGEX = /\b(create|update|register|generate|insert|post)\b/i;

function isSubmitLikeClick(step: AgentStepRecord): boolean {
  return step.action.type === 'click'
    && step.outcome === 'executed'
    && (isConstructiveLabel(step.target_label).matched || SUBMIT_LABEL_REGEX.test(step.target_label));
}

function evidenceFor(steps: AgentStepRecord[]): { affected_urls: string[]; screen_titles: string[] } {
  const urls = new Set<string>();
  const titles = new Set<string>();
  for (const step of steps) {
    const url = step.signature_after?.url || step.signature_before?.url;
    const title = step.signature_after?.title || step.signature_before?.title;
    if (url) urls.add(url);
    if (title) titles.add(title);
  }
  return { affected_urls: [...urls], screen_titles: [...titles] };
}

/** Same click on the same screen executed 2+ times, never once changing the page. */
function detectBrokenControls(steps: AgentStepRecord[]): UxIssue[] {
  const groups = new Map<string, AgentStepRecord[]>();
  for (const step of steps) {
    if (step.action.type !== 'click' || step.outcome !== 'executed') continue;
    if (!step.target_label.trim()) continue;
    const key = `${step.target_label.trim().toLowerCase()}\u0000${step.signature_before.url}`;
    const list = groups.get(key) ?? [];
    list.push(step);
    groups.set(key, list);
  }
  const findings: UxIssue[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    if (group.some((step) => step.signature_changed)) continue;
    const label = group[0]!.target_label;
    findings.push({
      category: 'interaction',
      severity: 'medium',
      title: 'Control does not respond to click',
      description: `"${label}" was clicked ${group.length} time(s) on ${group[0]!.signature_before.url} and never changed the screen.`,
      recommendation: `Investigate why "${label}" produces no visible effect; wire up its handler or fix the disabled/broken state.`,
      human_summary: '',
      developer_prompt: '',
      evidence: evidenceFor(group),
    });
  }
  return findings;
}

const INVALID_FORMAT_REGEX = /invalid[^.]{0,40}format|invalid format/i;

function hasFormatHint(text: string): boolean {
  return /\d/.test(text) || /\be\.g\.?\b|\bexample\b|\bsuch as\b/i.test(text);
}

/**
 * Conservative on purpose: only fires when the observation literally says
 * "invalid" and "format" together with nothing that looks like a concrete
 * accepted-format example nearby (a digit, or an "e.g./example" hint).
 */
function detectUnhelpfulValidation(steps: AgentStepRecord[]): UxIssue[] {
  const findings: UxIssue[] = [];
  for (const step of steps) {
    if (step.action.type !== 'type' && step.action.type !== 'click') continue;
    const text = step.outcome_observation || '';
    if (!/invalid/i.test(text) || !/format/i.test(text)) continue;
    if (!INVALID_FORMAT_REGEX.test(text)) continue;
    if (hasFormatHint(text)) continue;
    findings.push({
      category: 'validation',
      severity: 'low',
      title: 'Validation message does not state the accepted format',
      description: `The validation message "${text.trim().slice(0, 200)}" on ${step.signature_after.url} does not say what format is expected.`,
      recommendation: 'Name the accepted format explicitly in the validation message (e.g. show a sample value or pattern).',
      human_summary: '',
      developer_prompt: '',
      evidence: evidenceFor([step]),
    });
  }
  return findings;
}

const RECORD_ABSENT_REGEX = /not (?:in|on) the list|does not appear|not visible in the list/i;
const LOOKBACK_STEPS = 5;

/** A `blocked` step reporting a just-saved record is missing from its list. */
function detectRecordAbsentFromList(steps: AgentStepRecord[]): UxIssue[] {
  const findings: UxIssue[] = [];
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]!;
    if (step.action.type !== 'blocked') continue;
    const reason = step.action.reason || step.outcome_observation || '';
    if (!RECORD_ABSENT_REGEX.test(reason)) continue;
    const priorSubmit = steps
      .slice(Math.max(0, i - LOOKBACK_STEPS), i)
      .reverse()
      .find((candidate) => isSubmitLikeClick(candidate));
    if (!priorSubmit) continue;
    findings.push({
      category: 'data_integrity',
      severity: 'medium',
      title: 'Record may not appear in list after save',
      description: `After "${priorSubmit.target_label}" was submitted successfully, the agent reported that the saved record ${reason.trim()}.`,
      recommendation: 'Confirm the list view refetches or optimistically inserts the new record immediately after a successful save.',
      human_summary: '',
      developer_prompt: '',
      evidence: evidenceFor([priorSubmit, step]),
    });
  }
  return findings;
}

function isBlankLabel(label: string): boolean {
  const trimmed = label.trim();
  if (!trimmed) return true;
  return trimmed.length === 1 && !/[a-z0-9]/i.test(trimmed);
}

/** click/select executed against a control whose accessible name is empty or a bare symbol. */
function detectUnlabelledControls(steps: AgentStepRecord[]): UxIssue[] {
  const offenders = steps.filter((step) =>
    (step.action.type === 'click' || step.action.type === 'select') && isBlankLabel(step.target_label));
  if (!offenders.length) return [];
  return [{
    category: 'accessibility',
    severity: 'low',
    title: 'Interactive control has no accessible name',
    description: `${offenders.length} interactive control(s) exposed no usable label (blank, or a single non-alphanumeric symbol such as "—").`,
    recommendation: 'Give every interactive control an accessible name via visible text, aria-label, or a wrapping <label>.',
    human_summary: '',
    developer_prompt: '',
    evidence: evidenceFor(offenders),
  }];
}

const SCOPE_MISSING_REGEX = /scope was not found/i;

/** The loop's last step is the `blocked` exit that names the missing scope. */
function detectScopeMissing(steps: AgentStepRecord[]): UxIssue[] {
  const last = steps[steps.length - 1];
  if (!last || last.action.type !== 'blocked') return [];
  const reason = last.action.reason || last.outcome_observation || '';
  if (!SCOPE_MISSING_REGEX.test(reason)) return [];
  return [{
    category: 'coverage',
    severity: 'high',
    title: 'Session scope missing from navigation',
    description: `The session ended because: ${reason.trim()}`,
    recommendation: 'Confirm the module is actually present in this profile/environment; fix the session plan or the product navigation.',
    human_summary: '',
    developer_prompt: '',
    evidence: evidenceFor([last]),
  }];
}

const DUPLICATE_REGEX = /already exists|duplicate/i;
const RESUBMIT_WINDOW = 5;

/** Positive finding: a duplicate-key rejection was observed, then the agent changed the value and resubmitted successfully. */
function detectDuplicateKeyPassed(steps: AgentStepRecord[]): UxIssue[] {
  const findings: UxIssue[] = [];
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]!;
    const text = `${step.observation || ''} ${step.outcome_observation || ''}`;
    if (!DUPLICATE_REGEX.test(text)) continue;
    const window = steps.slice(i + 1, i + 1 + RESUBMIT_WINDOW);
    const successfulResubmit = window.find((candidate) => isSubmitLikeClick(candidate) && candidate.signature_changed);
    if (!successfulResubmit) continue;
    findings.push({
      category: 'validation',
      severity: 'suggestion',
      title: 'Duplicate-value validation confirmed working',
      description: 'The product correctly rejected a duplicate value; the session verified the check by changing the value and resubmitting successfully.',
      recommendation: 'No action needed; this duplicate-key validation is working as intended.',
      human_summary: '',
      developer_prompt: '',
      evidence: evidenceFor([step, successfulResubmit]),
    });
    i += window.indexOf(successfulResubmit); // skip past the confirmed pair
  }
  return findings;
}

/** Scans a finished step list and turns discarded evidence into reportable findings. */
export function detectAgentFindings(steps: AgentStepRecord[]): UxIssue[] {
  return [
    ...detectBrokenControls(steps),
    ...detectUnhelpfulValidation(steps),
    ...detectRecordAbsentFromList(steps),
    ...detectUnlabelledControls(steps),
    ...detectScopeMissing(steps),
    ...detectDuplicateKeyPassed(steps),
  ];
}
