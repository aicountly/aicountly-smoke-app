import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDateFindings,
  buildNativeLocaleFinding,
  dateFieldKey,
  isDateishMark,
  keepsIndianOrder,
  type DateProbe,
} from './dateFieldProbe.js';
import type { MarkDescriptor } from './marks.js';

function mark(overrides: Partial<MarkDescriptor> = {}): MarkDescriptor {
  return {
    mark: 23,
    tag: 'input',
    role: '',
    name: 'DATE OF JOINING',
    type: 'date',
    value: '',
    checked: null,
    disabled: false,
    offscreen: false,
    viewport_offset: 0,
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    ...overrides,
  };
}

function probe(overrides: Partial<DateProbe> = {}): DateProbe {
  return {
    label: 'Date of joining',
    url: 'https://hrms.test/employees/new',
    kind: 'custom',
    input_type: 'text',
    placeholder: 'dd/mm/yyyy',
    locale: 'en-IN',
    picker_opened: true,
    accepted_ddmmyyyy: true,
    read_back: '31/12/2024',
    validation_message: '',
    ...overrides,
  };
}

test('date fields are recognised by input type or by label', () => {
  assert.equal(isDateishMark(mark()), true);
  assert.equal(isDateishMark(mark({ type: 'text', name: 'Date of joining' })), true);
  assert.equal(isDateishMark(mark({ type: 'text', name: 'DOB' })), true);
  assert.equal(isDateishMark(mark({ type: 'text', name: 'dd/mm/yyyy' })), true);
  assert.equal(isDateishMark(mark({ type: 'text', name: 'First name' })), false);
  assert.equal(isDateishMark(mark({ type: 'email', name: 'Joining date email' })), false);
  assert.equal(isDateishMark(mark({ disabled: true })), false);
});

test('a control may reformat the date but not reorder it', () => {
  assert.equal(keepsIndianOrder('31/12/2024'), true);
  assert.equal(keepsIndianOrder('31-12-2024'), true);
  assert.equal(keepsIndianOrder('2024-12-31'), true);
  assert.equal(keepsIndianOrder('12/31/2024'), false);
  assert.equal(keepsIndianOrder(''), false);
});

test('a custom control with no picker and a refused date raises both findings', () => {
  const issues = buildDateFindings(probe({
    picker_opened: false,
    accepted_ddmmyyyy: false,
    read_back: '',
    validation_message: 'Malformed value',
  }));
  assert.equal(issues.length, 2);
  assert.deepEqual(issues.map((issue) => issue.severity), ['medium', 'medium']);
  assert.match(issues[0].title, /does not open a date picker/);
  assert.match(issues[1].title, /does not accept dd\/mm\/yyyy/);
  // The label has to be in the title, or dedupeUxIssues collapses two fields into one.
  for (const issue of issues) assert.match(issue.title, /Date of joining/);
  assert.equal(issues[1].evidence.read_back, '');
  assert.equal(issues[1].evidence.validation_message, 'Malformed value');
});

test('a control that behaves raises nothing', () => {
  assert.deepEqual(buildDateFindings(probe()), []);
});

test('a native control raises no per-field finding, only the session note', () => {
  const native = probe({ kind: 'native', input_type: 'date', picker_opened: null, accepted_ddmmyyyy: null });
  assert.deepEqual(buildDateFindings(native), []);

  const note = buildNativeLocaleFinding([native, probe()]);
  assert.equal(note?.severity, 'suggestion');
  assert.match(String(note?.title), /inherit the end user's locale/);
  assert.deepEqual(note?.evidence.native_date_fields, ['Date of joining']);
});

test('no native fields means no session note', () => {
  assert.equal(buildNativeLocaleFinding([probe()]), null);
  assert.equal(buildNativeLocaleFinding([]), null);
});

test('probe keys separate fields but ignore label casing', () => {
  assert.equal(
    dateFieldKey('https://hrms.test/x', 'Date of joining'),
    dateFieldKey('https://hrms.test/x', 'DATE OF JOINING '),
  );
  assert.notEqual(
    dateFieldKey('https://hrms.test/x', 'Date of joining'),
    dateFieldKey('https://hrms.test/x', 'Date of birth'),
  );
});
