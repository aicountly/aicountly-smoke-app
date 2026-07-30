import assert from 'node:assert/strict';
import test from 'node:test';
import { applyMarker, stripMarker } from './syntheticMarker.js';

test('applies the standard hyphenated marker to an ordinary free-text value', () => {
  assert.equal(applyMarker('Ada Lovelace'), 'SMOKE-Ada Lovelace');
});

test('recognises "SMOKE-" and "SMOKE " as already marked and leaves them alone', () => {
  assert.equal(applyMarker('SMOKE-Department'), 'SMOKE-Department');
  assert.equal(applyMarker('SMOKE Department'), 'SMOKE Department');
});

test('recognises a bare "SMOKE" prefix (no separator) as already marked', () => {
  // Before this fix, "SMOKEDEPT" matched neither the "SMOKE-" nor the "SMOKE "
  // branch, so it was re-prefixed into "SMOKE-SMOKEDEPT" and stayed invalid.
  assert.equal(applyMarker('SMOKEDEPT'), 'SMOKEDEPT');
  assert.equal(applyMarker('smokedept'), 'smokedept');
});

test('applying the marker twice is idempotent', () => {
  const once = applyMarker('Engineering');
  const twice = applyMarker(once);
  assert.equal(twice, once);
});

test('code fields get an unhyphenated SMOKE prefix instead of SMOKE-', () => {
  assert.equal(applyMarker('DEPT', { looksLikeCode: true }), 'SMOKEDEPT');
  assert.equal(applyMarker('dept', { looksLikeCode: true }), 'Smokedept');
});

test('code fields strip a leading or embedded hyphen the model already typed', () => {
  assert.equal(applyMarker('SMOKE-DEPT', { looksLikeCode: true }), 'SMOKEDEPT');
  assert.equal(applyMarker('DE-PT', { looksLikeCode: true }), 'SMOKEDEPT');
});

test('code fields already bearing a bare SMOKE prefix are left unchanged', () => {
  assert.equal(applyMarker('SMOKEDEPT', { looksLikeCode: true }), 'SMOKEDEPT');
});

test('numeric, date, time and phone values are left unmarked even when hinted as code fields', () => {
  assert.equal(applyMarker('9876543210', { name: 'mobile', looksLikeCode: true }), '9876543210');
  assert.equal(applyMarker('31/12/2024', { type: 'text', looksLikeCode: true }), '31/12/2024');
});

test('stripMarker removes only a leading marker, not one appearing mid-string', () => {
  assert.equal(stripMarker('SMOKE-Ada Lovelace'), 'Ada Lovelace');
  assert.equal(stripMarker('Ada SMOKE-Lovelace'), 'Ada SMOKE-Lovelace');
});

test('email values get the smoke. local-part marker regardless of code hints', () => {
  assert.equal(applyMarker('ada@example.com', { type: 'email' }), 'smoke.ada@example.com');
  assert.equal(applyMarker('smoke.ada@example.com', { type: 'email' }), 'smoke.ada@example.com');
});
