import assert from 'node:assert/strict';
import test from 'node:test';
import { coerceForField, isTemporalType } from './valueCoercion.js';

const NOW = new Date('2026-07-30T09:15:00');
const date = (value: string) => coerceForField(value, { type: 'date' }, NOW);

test('a date input receives the wire format whatever the model typed', () => {
  assert.equal(date('2024-07-20'), '2024-07-20');
  assert.equal(date('20/07/2024'), '2024-07-20');
  assert.equal(date('20-07-2024'), '2024-07-20');
  assert.equal(date('31/12/2024'), '2024-12-31');
});

test('an ambiguous pair is read day-first, an unambiguous one on its own merits', () => {
  // Both readable: dd/mm wins, because the products are India-first.
  assert.equal(date('07/12/2024'), '2024-12-07');
  // Only one reading survives: 20 cannot be a month.
  assert.equal(date('07/20/2024'), '2024-07-20');
});

test('a value the model invented never stalls the step', () => {
  assert.equal(date('today'), '2026-07-30');
  assert.equal(date(''), '2026-07-30');
  assert.equal(date('SMOKE-20/07/2024'), '2024-07-20');
  assert.equal(date('99/99/9999'), '2026-07-30');
});

test('prose dates are accepted', () => {
  assert.equal(date('20 July 2024'), '2024-07-20');
});

test('the other temporal inputs get their own formats', () => {
  assert.equal(coerceForField('20/07/2024', { type: 'month' }, NOW), '2024-07');
  assert.equal(coerceForField('9:30 am', { type: 'time' }, NOW), '09:30');
  assert.equal(coerceForField('5:45 pm', { type: 'time' }, NOW), '17:45');
  assert.equal(coerceForField('20/07/2024 18:30', { type: 'datetime-local' }, NOW), '2024-07-20T18:30');
  assert.equal(coerceForField('20/07/2024', { type: 'datetime-local' }, NOW), '2024-07-20T00:00');
  assert.equal(coerceForField('2024-07-20', { type: 'week' }, NOW), '2024-W29');
});

test('a number input is reduced to a numeral, marker and all', () => {
  assert.equal(coerceForField('SMOKE-42', { type: 'number' }, NOW), '42');
  assert.equal(coerceForField('1,200.50', { type: 'number' }, NOW), '1200.50');
  assert.equal(coerceForField('not a number', { type: 'number' }, NOW), '1');
});

test('text and select values pass through untouched', () => {
  assert.equal(coerceForField('SMOKE-Ada', { type: 'text' }, NOW), 'SMOKE-Ada');
  assert.equal(coerceForField('20/07/2024', { type: 'text', name: 'Date of joining' }, NOW), '20/07/2024');
  assert.equal(coerceForField('Engineering', { tag: 'select' }, NOW), 'Engineering');
  assert.equal(isTemporalType('text'), false);
  assert.equal(isTemporalType('DATE'), true);
});
