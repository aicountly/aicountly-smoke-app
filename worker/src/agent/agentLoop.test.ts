import assert from 'node:assert/strict';
import test from 'node:test';
import { actionTriple, evaluateLoopDetection, formIdentityKey, parseAgentAction } from './agentLoop.js';
import type { MarkDescriptor } from './marks.js';
import { signatureKey, type PageSignature } from './perceive.js';

test('parses Set-of-Marks actions without selectors', () => {
  assert.deepEqual(parseAgentAction({ type: 'click', mark: 7 }), { type: 'click', mark: 7 });
  assert.deepEqual(
    parseAgentAction({ type: 'type', mark: 2, text: 'Smoke Co', submit: true }),
    { type: 'type', mark: 2, text: 'Smoke Co', submit: true },
  );
  assert.throws(() => parseAgentAction({ type: 'click', mark: 0 }), /Invalid Set-of-Marks/);
  assert.throws(() => parseAgentAction({ type: 'click', selector: '#save' }), /Invalid Set-of-Marks/);
});

test('page signature key changes on dialogs and DOM changes', () => {
  const base = { url: 'https://app.test/', title: 'Home', markCount: 2, domHash: 'a', dialogCount: 0 };
  assert.notEqual(signatureKey(base), signatureKey({ ...base, dialogCount: 1 }));
  assert.notEqual(signatureKey(base), signatureKey({ ...base, domHash: 'b' }));
  assert.equal(signatureKey(base), signatureKey({ ...base }));
});

test('actionTriple keys on DOM signature, not only the URL', () => {
  const a: PageSignature = { url: 'https://hrms.test/employees', title: 'List', markCount: 4, domHash: 'aaa', dialogCount: 0 };
  const b: PageSignature = { url: 'https://hrms.test/employees', title: 'Form', markCount: 8, domHash: 'bbb', dialogCount: 0 };
  const action = { type: 'click' as const, mark: 12 };
  assert.notEqual(actionTriple(action, a), actionTriple(action, b));
});

test('repeated action that changes the screen is not a loop warning', () => {
  let recentTriples: string[] = [];
  let unchangedCount = 0;
  let prior: PageSignature = { url: 'https://app.test/', title: 'A', markCount: 1, domHash: '1', dialogCount: 0 };
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
  const page: PageSignature = {
    url: 'https://hrms.test/employees/new',
    title: 'Add Employee',
    markCount: 5,
    domHash: 'before',
    dialogCount: 0,
  };
  const marks = (values: string[]): MarkDescriptor[] => ([
    { mark: 1, tag: 'input', role: '', name: 'First name', type: 'text', value: values[0] ?? '', checked: null, disabled: false, bbox: { x: 0, y: 0, width: 10, height: 10 } },
    { mark: 2, tag: 'input', role: '', name: 'Last name', type: 'text', value: values[1] ?? '', checked: null, disabled: false, bbox: { x: 0, y: 0, width: 10, height: 10 } },
    { mark: 3, tag: 'select', role: '', name: 'Department', type: '', value: values[2] ?? '', checked: null, disabled: false, bbox: { x: 0, y: 0, width: 10, height: 10 } },
    { mark: 4, tag: 'button', role: 'button', name: 'Save', type: 'submit', value: '', checked: null, disabled: false, bbox: { x: 0, y: 0, width: 10, height: 10 } },
  ]);
  const empty = formIdentityKey(page, marks(['', '', '']));
  const filled = formIdentityKey(
    { ...page, domHash: 'after-typing' },
    marks(['SMOKE-Ada', 'SMOKE-Lovelace', 'Engineering']),
  );
  assert.equal(empty, filled);
});

test('five identical stalled actions warn; fewer do not', () => {
  const sig: PageSignature = { url: 'https://app.test/', title: 'Stuck', markCount: 2, domHash: 'same', dialogCount: 0 };
  const action = { type: 'click' as const, mark: 9 };
  let recentTriples: string[] = [];
  let unchangedCount = 0;
  let prior = sig;
  let warnedAt = 0;

  for (let i = 1; i <= 5; i += 1) {
    const next = evaluateLoopDetection({
      action,
      before: sig,
      after: sig,
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
