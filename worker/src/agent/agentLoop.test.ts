import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAgentAction } from './agentLoop.js';
import { signatureKey } from './perceive.js';

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
