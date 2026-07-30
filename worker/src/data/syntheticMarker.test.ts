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

test('takes the marker back off a value a validator reads as a number', () => {
  // The model is told to mark what it types, so this is what actually arrives.
  assert.equal(applyMarker('SMOKE-9876543210', { name: 'REGISTERED MOBILE' }), '9876543210');
  assert.equal(applyMarker('SMOKE-9876543210', { type: 'tel', name: 'Phone' }), '9876543210');
  assert.equal(applyMarker('SMOKE-+91 98765 43210', { name: 'REGISTERED WHATSAPP' }), '+91 98765 43210');
  assert.equal(applyMarker('SMOKE-560001', { name: 'PIN code' }), '560001');
  assert.equal(applyMarker('SMOKE-1', { type: 'number' }), '1');
  assert.equal(applyMarker('SMOKE-20/07/2024', { type: 'date' }), '20/07/2024');
});

test('a name is still marked, even where a phone-ish word appears in the label', () => {
  assert.equal(applyMarker('Ada', { name: 'Contact person' }), `${SMOKE_MARKER}Ada`);
  assert.equal(applyMarker('SMOKE-Ada', { name: 'Contact person' }), `${SMOKE_MARKER}Ada`);
  assert.equal(applyMarker('Ada', { name: 'Phone owner name' }), `${SMOKE_MARKER}Ada`);
});
