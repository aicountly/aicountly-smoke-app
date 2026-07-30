import assert from 'node:assert/strict';
import test from 'node:test';
import { matchOption, MAX_BATCH_FIELDS, planBatchFill, summariseBatch, type FillResult } from './batchFill.js';
import type { MarkDescriptor } from './marks.js';

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

test('a batch is attempted in reading order, not the order the model listed it', () => {
  const marks = [
    mark({ mark: 3, name: 'Last', bbox: { x: 0, y: 300, width: 10, height: 10 } }),
    mark({ mark: 1, name: 'First', bbox: { x: 0, y: 10, width: 10, height: 10 } }),
    mark({ mark: 2, name: 'Middle', bbox: { x: 0, y: 120, width: 10, height: 10 } }),
  ];
  const plan = planBatchFill(
    [{ mark: 3, value: 'c' }, { mark: 1, value: 'a' }, { mark: 2, value: 'b' }],
    marks,
  );
  assert.deepEqual(plan.entries.map((item) => item.descriptor.name), ['First', 'Middle', 'Last']);
  assert.equal(plan.rejected.length, 0);
});

test('fields above the fold are ordered before those below it', () => {
  const marks = [
    mark({ mark: 1, name: 'Visible', bbox: { x: 0, y: 40, width: 10, height: 10 } }),
    mark({ mark: 2, name: 'Scrolled past', offscreen: true, bbox: { x: 0, y: -200, width: 10, height: 10 } }),
  ];
  const plan = planBatchFill([{ mark: 1, value: 'a' }, { mark: 2, value: 'b' }], marks);
  assert.deepEqual(plan.entries.map((item) => item.descriptor.name), ['Scrolled past', 'Visible']);
});

test('unknown, duplicated and valueless entries are reported instead of attempted', () => {
  const marks = [mark({ mark: 1, name: 'Code' })];
  const plan = planBatchFill(
    [{ mark: 1, value: 'SMOKE-1' }, { mark: 1, value: 'SMOKE-2' }, { mark: 9, value: 'x' }, { mark: 1 }],
    marks,
  );
  assert.equal(plan.entries.length, 1);
  assert.equal(plan.entries[0]!.entry.value, 'SMOKE-1');
  assert.equal(plan.rejected.length, 3);
  assert.match(plan.rejected[0]!.reason!, /twice/);
  assert.match(plan.rejected[1]!.reason!, /not one of the controls/);
});

test('a batch wider than the cap fills the cap and reports the remainder', () => {
  const marks = Array.from({ length: MAX_BATCH_FIELDS + 4 }, (_unused, index) => mark({
    mark: index + 1,
    name: `Field ${index + 1}`,
    bbox: { x: 0, y: index * 10, width: 10, height: 10 },
  }));
  const plan = planBatchFill(marks.map((item) => ({ mark: item.mark, value: 'SMOKE-x' })), marks);
  assert.equal(plan.entries.length, MAX_BATCH_FIELDS);
  assert.equal(plan.rejected.length, 4);
  assert.match(plan.rejected[0]!.reason!, new RegExp(`${MAX_BATCH_FIELDS} fields`));
});

test('an exact option beats a substring match elsewhere in the list', () => {
  assert.equal(matchOption(['Permanent Contract', 'Permanent'], 'Permanent'), 1);
  assert.equal(matchOption(['Male', 'Female'], 'male'), 0);
  assert.equal(matchOption(['A+', 'A-', 'AB+'], 'A+'), 0);
});

test('option matching tolerates case, spacing and punctuation', () => {
  assert.equal(matchOption(['Full  Time'], 'full-time'), 0);
  assert.equal(matchOption(['Hindu'], 'Hinduism'), 0);
});

test('a placeholder is never offered as a match', () => {
  assert.equal(matchOption(['— Select —', 'Male'], 'Select'), null);
  assert.equal(matchOption(['-- Choose --'], 'choose'), null);
});

test('an option the model invented does not match anything', () => {
  assert.equal(matchOption(['Male', 'Female'], 'Unspecified'), null);
  assert.equal(matchOption([], 'Male'), null);
  assert.equal(matchOption(['Male'], '  '), null);
});

function result(overrides: Partial<FillResult> = {}): FillResult {
  return { mark: 1, label: 'First name', status: 'filled', value: 'SMOKE-Anita', ...overrides };
}

test('the batch summary leads with the fields the model still has to deal with', () => {
  const summary = summariseBatch([
    result(),
    result({
      mark: 2,
      label: 'Gender',
      status: 'skipped',
      value: undefined,
      reason: '"M" is not one of the options this dropdown offers',
      available_options: ['Male', 'Female'],
    }),
  ]);
  assert.match(summary, /^Batch fill: set 1 of 2 fields\./);
  assert.ok(summary.indexOf('Not set:') < summary.indexOf('Set:'));
  assert.match(summary, /it offers Male, Female/);
  assert.match(summary, /"First name"="SMOKE-Anita"/);
});

test('a summary of a wide form is clipped rather than allowed to crowd the prompt', () => {
  const results = Array.from({ length: 40 }, (_unused, index) => result({
    mark: index + 1,
    label: `A rather long field label number ${index + 1}`,
    value: `SMOKE-value-number-${index + 1}`,
  }));
  const summary = summariseBatch(results, 300);
  assert.ok(summary.length <= 300);
  assert.match(summary, /^Batch fill: set 40 of 40 fields\./);
  assert.ok(summary.endsWith('…'));
});

test('a batch where nothing was written still says so', () => {
  const summary = summariseBatch([
    result({ status: 'refused', value: undefined, reason: 'field is credential, OTP, or a statutory identifier and must not be filled' }),
  ]);
  assert.match(summary, /set 0 of 1 fields/);
  assert.match(summary, /refused: field is credential/);
});
