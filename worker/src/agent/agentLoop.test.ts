import assert from 'node:assert/strict';
import test from 'node:test';
import {
  actionTriple,
  evaluateBlockedDecision,
  evaluateLoopDetection,
  formIdentityKey,
  parseAgentAction,
  submittedControls,
} from './agentLoop.js';
import type { AgentStepRecord } from './actions.js';
import type { MarkDescriptor } from './marks.js';
import { signatureKey, type PageSignature } from './perceive.js';

function sig(overrides: Partial<PageSignature> = {}): PageSignature {
  return {
    url: 'https://app.test/',
    title: 'Home',
    markCount: 2,
    domHash: 'a',
    formHash: 'f',
    dialogCount: 0,
    scrollY: 0,
    ...overrides,
  };
}

function mark(overrides: Partial<MarkDescriptor> = {}): MarkDescriptor {
  return {
    mark: 1,
    tag: 'input',
    role: '',
    name: 'Field',
    type: 'text',
    value: '',
    checked: null,
    disabled: false,
    offscreen: false,
    viewport_offset: 0,
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    ...overrides,
  };
}

function step(overrides: Partial<AgentStepRecord> = {}): AgentStepRecord {
  return {
    ordinal: 1,
    captured_at: '2026-07-30T00:00:00.000Z',
    screenshot: '',
    observation: '',
    reasoning: '',
    goal_progress: '',
    blockers: [],
    action: { type: 'click', mark: 28 },
    outcome: 'executed',
    outcome_observation: '',
    guard: { allowed: true },
    target_label: 'Create employee master',
    signature_before: sig(),
    signature_after: sig(),
    signature_changed: true,
    ...overrides,
  };
}

test('parses Set-of-Marks actions without selectors', () => {
  assert.deepEqual(parseAgentAction({ type: 'click', mark: 7 }), { type: 'click', mark: 7 });
  assert.deepEqual(
    parseAgentAction({ type: 'type', mark: 2, text: 'Smoke Co', submit: true }),
    { type: 'type', mark: 2, text: 'Smoke Co', submit: true },
  );
  assert.throws(() => parseAgentAction({ type: 'click', mark: 0 }), /Invalid Set-of-Marks/);
  assert.throws(() => parseAgentAction({ type: 'click', selector: '#save' }), /Invalid Set-of-Marks/);
});

test('page signature key changes on dialogs and DOM/form changes, but not on scroll alone', () => {
  const base = sig();
  assert.notEqual(signatureKey(base), signatureKey(sig({ dialogCount: 1 })));
  assert.notEqual(signatureKey(base), signatureKey(sig({ domHash: 'b' })));
  // formHash is what makes typing into a field count as progress.
  assert.notEqual(signatureKey(base), signatureKey(sig({ formHash: 'g' })));
  // Scrolling is not progress: a scroll must not look like a changed screen, or
  // loop detection never penalises scroll thrash and a legitimate scroll never
  // gets credit for "unchanged" either way.
  assert.equal(signatureKey(base), signatureKey(sig({ scrollY: 800 })));
  assert.equal(signatureKey(base), signatureKey(sig()));
});

test('actionTriple keys on DOM signature, not only the URL', () => {
  const a = sig({ url: 'https://hrms.test/employees', title: 'List', markCount: 4, domHash: 'aaa' });
  const b = sig({ url: 'https://hrms.test/employees', title: 'Form', markCount: 8, domHash: 'bbb' });
  const action = { type: 'click' as const, mark: 12 };
  assert.notEqual(actionTriple(action, a), actionTriple(action, b));
});

test('repeated action that changes the screen is not a loop warning', () => {
  let recentTriples: string[] = [];
  let unchangedCount = 0;
  let prior = sig({ title: 'A', markCount: 1, domHash: '1' });
  const action = { type: 'click' as const, mark: 3 };

  for (let i = 0; i < 6; i += 1) {
    const before = { ...prior };
    const after: PageSignature = { ...prior, domHash: `h${i}`, title: `T${i}` };
    const next = evaluateLoopDetection({
      action,
      before,
      after,
      recentTriples,
      unchangedCount,
      priorSignature: prior,
    });
    assert.equal(next.warned, false, `iteration ${i} should not warn on progressing screens`);
    recentTriples = next.recentTriples;
    unchangedCount = next.unchangedCount;
    prior = next.priorSignature;
  }
  assert.equal(recentTriples.length, 0);
});

test('form identity key stays stable as empty fields shrink', () => {
  const page = sig({ url: 'https://hrms.test/employees/new', title: 'Add Employee', markCount: 5, domHash: 'before' });
  const marks = (values: string[]): MarkDescriptor[] => ([
    mark({ mark: 1, name: 'First name', value: values[0] ?? '' }),
    mark({ mark: 2, name: 'Last name', value: values[1] ?? '' }),
    mark({ mark: 3, tag: 'select', name: 'Department', type: '', value: values[2] ?? '' }),
    mark({ mark: 4, tag: 'button', role: 'button', name: 'Save', type: 'submit' }),
  ]);
  const empty = formIdentityKey(page, marks(['', '', '']));
  const filled = formIdentityKey(
    { ...page, domHash: 'after-typing' },
    marks(['SMOKE-Ada', 'SMOKE-Lovelace', 'Engineering']),
  );
  assert.equal(empty, filled);
});

test('five identical stalled actions warn; fewer do not', () => {
  const stuck = sig({ title: 'Stuck', domHash: 'same' });
  const action = { type: 'click' as const, mark: 9 };
  let recentTriples: string[] = [];
  let unchangedCount = 0;
  let prior = stuck;
  let warnedAt = 0;

  for (let i = 1; i <= 5; i += 1) {
    const next = evaluateLoopDetection({
      action,
      before: stuck,
      after: stuck,
      recentTriples,
      unchangedCount,
      priorSignature: prior,
    });
    recentTriples = next.recentTriples;
    unchangedCount = next.unchangedCount;
    prior = next.priorSignature;
    if (next.warned) warnedAt = i;
    if (i < 5) assert.equal(next.warned, false, `should not warn at stall ${i}`);
  }
  assert.equal(warnedAt, 5);
});

test('type/select on an unchanging screen does not increment the unchanged counter', () => {
  const stuck = sig({ title: 'Form', domHash: 'same', formHash: 'same' });
  let unchangedCount = 0;
  let prior = stuck;

  for (let i = 1; i <= 8; i += 1) {
    const next = evaluateLoopDetection({
      action: { type: 'type', mark: 4, text: 'SMOKE-value' },
      before: stuck,
      after: stuck,
      recentTriples: [],
      unchangedCount,
      priorSignature: prior,
    });
    assert.equal(next.warned, false, `type should never trip the unchanged counter (iteration ${i})`);
    unchangedCount = next.unchangedCount;
    prior = next.priorSignature;
  }
  assert.equal(unchangedCount, 0);

  // A select action on the same unchanging screen is exempt the same way.
  const afterSelect = evaluateLoopDetection({
    action: { type: 'select', mark: 5, option: 'Engineering' },
    before: stuck,
    after: stuck,
    recentTriples: [],
    unchangedCount: 0,
    priorSignature: prior,
  });
  assert.equal(afterSelect.unchangedCount, 0);
  assert.equal(afterSelect.warned, false);
});

test('an ordinary click on an unchanging screen still counts toward the unchanged counter', () => {
  const stuck = sig({ title: 'Form', domHash: 'same', formHash: 'same' });
  let unchangedCount = 0;
  let prior = stuck;
  let warnedAt = 0;
  for (let i = 1; i <= 6; i += 1) {
    const next = evaluateLoopDetection({
      action: { type: 'click', mark: 4 },
      before: stuck,
      after: stuck,
      recentTriples: [],
      unchangedCount,
      priorSignature: prior,
    });
    unchangedCount = next.unchangedCount;
    prior = next.priorSignature;
    if (next.warned) warnedAt = i;
  }
  assert.equal(warnedAt, 6);
});

test('a run of four or more scrolls warns even though the screen keeps "changing" scroll position', () => {
  const stuck = sig({ title: 'Long page', domHash: 'same', formHash: 'same' });
  let recentTriples: string[] = [];
  let unchangedCount = 0;
  let prior = stuck;
  let warnedAt = 0;

  for (let i = 1; i <= 4; i += 1) {
    const next = evaluateLoopDetection({
      action: { type: 'scroll', direction: 'down', amount: 700 },
      before: stuck,
      after: stuck,
      recentTriples,
      unchangedCount,
      priorSignature: prior,
      consecutiveScrolls: i,
    });
    recentTriples = next.recentTriples;
    unchangedCount = next.unchangedCount;
    prior = next.priorSignature;
    if (next.warned) warnedAt = i;
    if (i < 4) assert.equal(next.warned, false, `should not warn on scroll ${i}`);
  }
  assert.equal(warnedAt, 4);
});

test('only successful clicks on save-style controls count as submitted', () => {
  const found = submittedControls([
    step({ ordinal: 19 }),
    step({ ordinal: 20, target_label: 'Cancel' }),
    step({ ordinal: 21, outcome: 'refused' }),
    step({ ordinal: 24 }),
    step({ ordinal: 25, action: { type: 'type', mark: 21, text: '9876543210' }, target_label: 'Create employee master' }),
  ]);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0], { mark: 28, label: 'Create employee master', step: 19 });
});

test('blocked is refused once when the session already submitted that control', () => {
  const steps = [step({ ordinal: 19 })];
  const submitted = submittedControls(steps);
  const scroll = { y: 0, maxY: 0, deepestSeen: 0 };

  const first = evaluateBlockedDecision({ steps, submitted, scroll, refusalsUsed: 0, reason: 'I cannot find any create control.' });
  assert.match(String(first), /Create employee master/);
  assert.match(String(first), /offscreen/);
  // Second time the agent insists, the run has to let it go or it never ends.
  assert.equal(
    evaluateBlockedDecision({ steps, submitted, scroll, refusalsUsed: 1, reason: 'I cannot find any create control.' }),
    null,
  );
});

test('blocked is accepted even after a submit when the model already admits the control was used', () => {
  const steps = [step({ ordinal: 19 })];
  const submitted = submittedControls(steps);
  const scroll = { y: 900, maxY: 900, deepestSeen: 900 };

  // "The record I just saved does not appear in the list" is a plausible product
  // bug (list not refetching after save), not a false "no such control" claim —
  // it must not be refuted just because a submit control was clicked this session.
  for (const reason of [
    'The new leave type does not appear in the list after saving.',
    'Saved record is missing from the list.',
    'The employee is not shown in the list view.',
  ]) {
    assert.equal(
      evaluateBlockedDecision({ steps, submitted, scroll, refusalsUsed: 0, reason }),
      null,
      reason,
    );
  }
});

test('blocked is refused when part of the page was never scrolled into view', () => {
  const refutation = evaluateBlockedDecision({
    steps: [],
    submitted: [],
    scroll: { y: 0, maxY: 1400, deepestSeen: 0 },
    refusalsUsed: 0,
    reason: 'I cannot find a create control anywhere on this screen.',
  });
  assert.match(String(refutation), /1400px/);
});

test('blocked is accepted when nothing was submitted and the page was fully seen', () => {
  assert.equal(
    evaluateBlockedDecision({
      steps: [],
      submitted: [],
      scroll: { y: 900, maxY: 900, deepestSeen: 900 },
      refusalsUsed: 0,
      reason: 'No create control exists on this screen.',
    }),
    null,
  );
});
