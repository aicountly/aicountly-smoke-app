import assert from 'node:assert/strict';
import test from 'node:test';
import { applyMarker, SMOKE_MARKER } from './syntheticMarker.js';

test('prefixes free-text values with the SMOKE marker', () => {
  assert.equal(applyMarker('Ada Lovelace'), `${SMOKE_MARKER}Ada Lovelace`);
  assert.equal(applyMarker(`${SMOKE_MARKER}Already`), `${SMOKE_MARKER}Already`);
});

test('marks emails with a smoke local-part and leaves numbers/dates alone', () => {
  assert.equal(applyMarker('ada@example.com', { type: 'email' }), 'smoke.ada@example.com');
  assert.equal(applyMarker('42', { type: 'number' }), '42');
  assert.equal(applyMarker('2025-04-01', { type: 'date' }), '2025-04-01');
  assert.equal(applyMarker('10:00', { type: 'time' }), '10:00');
  assert.equal(applyMarker('INR'), 'INR');
});
