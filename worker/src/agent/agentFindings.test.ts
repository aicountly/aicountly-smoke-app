import assert from 'node:assert/strict';
import test from 'node:test';
import { detectAgentFindings } from './agentFindings.js';
import type { AgentAction, AgentStepRecord } from './actions.js';
import type { PageSignature } from './perceive.js';

function sig(url: string, title = 'Screen'): PageSignature {
  return { url, title, markCount: 5, domHash: 'abc', dialogCount: 0, scrollY: 0 };
}

function step(overrides: {
  ordinal: number;
  action?: AgentAction;
  outcome?: AgentStepRecord['outcome'];
  observation?: string;
  outcome_observation?: string;
  target_label?: string;
  signature_before?: PageSignature;
  signature_after?: PageSignature;
  signature_changed?: boolean;
}): AgentStepRecord {
  return {
    ordinal: overrides.ordinal,
    captured_at: new Date().toISOString(),
    screenshot: '',
    observation: overrides.observation ?? '',
    reasoning: '',
    goal_progress: '',
    blockers: [],
    action: overrides.action ?? { type: 'click', mark: 1 },
    outcome: overrides.outcome ?? 'executed',
    outcome_observation: overrides.outcome_observation ?? '',
    guard: { allowed: true },
    target_label: overrides.target_label ?? 'Save',
    signature_before: overrides.signature_before ?? sig('/app'),
    signature_after: overrides.signature_after ?? sig('/app'),
    signature_changed: overrides.signature_changed ?? false,
  };
}

test('flags a click that never changes the screen after two attempts', () => {
  const url = '/employees';
  const findings = detectAgentFindings([
    step({ ordinal: 1, action: { type: 'click', mark: 5 }, target_label: 'Add Record', signature_before: sig(url), signature_after: sig(url), signature_changed: false }),
    step({ ordinal: 2, action: { type: 'click', mark: 5 }, target_label: 'Add Record', signature_before: sig(url), signature_after: sig(url), signature_changed: false }),
  ]);
  const finding = findings.find((f) => f.title === 'Control does not respond to click');
  assert.ok(finding);
  assert.equal(finding?.category, 'interaction');
  assert.equal(finding?.severity, 'medium');
});

test('does not flag a control that eventually changes the screen', () => {
  const url = '/employees';
  const findings = detectAgentFindings([
    step({ ordinal: 1, target_label: 'Add Record', signature_before: sig(url), signature_after: sig(url), signature_changed: false }),
    step({ ordinal: 2, target_label: 'Add Record', signature_before: sig(url), signature_after: sig('/employees/new'), signature_changed: true }),
  ]);
  assert.equal(findings.find((f) => f.title === 'Control does not respond to click'), undefined);
});

test('flags an invalid-format message with no concrete example', () => {
  const findings = detectAgentFindings([
    step({ ordinal: 1, action: { type: 'type', mark: 3, text: 'x' }, outcome_observation: 'Rejected: invalid code format.' }),
  ]);
  const finding = findings.find((f) => f.title === 'Validation message does not state the accepted format');
  assert.ok(finding);
  assert.equal(finding?.category, 'validation');
  assert.equal(finding?.severity, 'low');
});

test('does not flag an invalid-format message that names an example value', () => {
  const findings = detectAgentFindings([
    step({ ordinal: 1, action: { type: 'type', mark: 3, text: 'x' }, outcome_observation: 'Invalid format, expected e.g. AB1234.' }),
  ]);
  assert.equal(findings.find((f) => f.title === 'Validation message does not state the accepted format'), undefined);
});

test('flags a record-absent blocked step that follows a successful submit', () => {
  const findings = detectAgentFindings([
    step({
      ordinal: 1,
      action: { type: 'click', mark: 9 },
      target_label: 'Save designation',
      outcome: 'executed',
      signature_before: sig('/designations/new'),
      signature_after: sig('/designations'),
      signature_changed: true,
    }),
    step({
      ordinal: 2,
      action: { type: 'blocked', reason: 'The saved designation does not appear in the list.' },
      outcome: 'terminal',
      outcome_observation: 'The saved designation does not appear in the list.',
    }),
  ]);
  const finding = findings.find((f) => f.title === 'Record may not appear in list after save');
  assert.ok(finding);
  assert.equal(finding?.category, 'data_integrity');
  assert.equal(finding?.severity, 'medium');
});

test('does not flag a record-absent blocked step with no preceding submit', () => {
  const findings = detectAgentFindings([
    step({
      ordinal: 1,
      action: { type: 'blocked', reason: 'The record does not appear in the list.' },
      outcome: 'terminal',
      outcome_observation: 'The record does not appear in the list.',
    }),
  ]);
  assert.equal(findings.find((f) => f.title === 'Record may not appear in list after save'), undefined);
});

test('flags interactive controls with no accessible name', () => {
  const findings = detectAgentFindings([
    step({ ordinal: 1, action: { type: 'click', mark: 2 }, target_label: '\u2014' }),
  ]);
  const finding = findings.find((f) => f.title === 'Interactive control has no accessible name');
  assert.ok(finding);
  assert.equal(finding?.category, 'accessibility');
});

test('does not flag a normally labelled control', () => {
  const findings = detectAgentFindings([
    step({ ordinal: 1, action: { type: 'click', mark: 2 }, target_label: 'Save' }),
  ]);
  assert.equal(findings.find((f) => f.title === 'Interactive control has no accessible name'), undefined);
});

test('flags the terminal blocked step naming a missing scope', () => {
  const findings = detectAgentFindings([
    step({ ordinal: 1, target_label: 'Menu' }),
    step({
      ordinal: 2,
      action: { type: 'blocked', reason: 'Session scope was not found in the application navigation.' },
      outcome: 'terminal',
      outcome_observation: 'Session scope was not found in the application navigation.',
    }),
  ]);
  const finding = findings.find((f) => f.title === 'Session scope missing from navigation');
  assert.ok(finding);
  assert.equal(finding?.category, 'coverage');
  assert.equal(finding?.severity, 'high');
});

test('does not flag scope-missing unless it is the session-ending step', () => {
  const findings = detectAgentFindings([
    step({
      ordinal: 1,
      action: { type: 'blocked', reason: 'scope was not found here' },
      outcome: 'refused',
      outcome_observation: 'scope was not found here',
    }),
    step({ ordinal: 2, target_label: 'Continue' }),
  ]);
  assert.equal(findings.find((f) => f.title === 'Session scope missing from navigation'), undefined);
});

test('records a passed duplicate-key validation as a positive suggestion finding', () => {
  const findings = detectAgentFindings([
    step({ ordinal: 1, action: { type: 'type', mark: 4, text: 'SMOKE-CL' }, observation: 'The leave type SMOKE-CL already exists.' }),
    step({ ordinal: 2, action: { type: 'type', mark: 4, text: 'SMOKE-CL2' } }),
    step({
      ordinal: 3,
      action: { type: 'click', mark: 6 },
      target_label: 'Save leave type',
      outcome: 'executed',
      signature_before: sig('/leave/new'),
      signature_after: sig('/leave'),
      signature_changed: true,
    }),
  ]);
  const finding = findings.find((f) => f.title === 'Duplicate-value validation confirmed working');
  assert.ok(finding);
  assert.equal(finding?.category, 'validation');
  assert.equal(finding?.severity, 'suggestion');
});

test('does not raise a duplicate-key finding when the value was never successfully resubmitted', () => {
  const findings = detectAgentFindings([
    step({ ordinal: 1, action: { type: 'type', mark: 4, text: 'SMOKE-CL' }, observation: 'The leave type SMOKE-CL already exists.' }),
  ]);
  assert.equal(findings.find((f) => f.title === 'Duplicate-value validation confirmed working'), undefined);
});
