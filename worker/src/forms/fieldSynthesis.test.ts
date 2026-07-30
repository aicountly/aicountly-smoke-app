import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  financialYearWindow,
  isPlaceholderOption,
  isUnsafeToFill,
  lastResortValue,
  shortCodeFor,
  synthesizeFieldValue,
  type FormFieldDescriptor,
} from './fieldSynthesis.js';

function field(partial: Partial<FormFieldDescriptor>): FormFieldDescriptor {
  return {
    tag: 'input',
    type: 'text',
    name: '',
    id: '',
    placeholder: '',
    ariaLabel: '',
    label: '',
    required: false,
    ...partial,
  };
}

const NOW = new Date('2026-07-30T00:00:00');

describe('financialYearWindow', () => {
  it('runs April to March for a date after April', () => {
    assert.deepEqual(financialYearWindow(NOW), { start: '2026-04-01', end: '2027-03-31' });
  });

  it('belongs to the previous April for a date before April', () => {
    assert.deepEqual(
      financialYearWindow(new Date('2026-02-10T00:00:00')),
      { start: '2025-04-01', end: '2026-03-31' },
    );
  });
});

describe('synthesizeFieldValue on a company form', () => {
  const entityName = 'Smoke Test Co';
  const value = (partial: Partial<FormFieldDescriptor>) =>
    synthesizeFieldValue(field(partial), { entityName, now: NOW });

  it('maps the AICOUNTLY Manage company form field names', () => {
    assert.equal(value({ name: 'comp_name' }), entityName);
    assert.equal(value({ name: 'print_name' }), entityName);
    assert.equal(value({ name: 'short_name' }), 'SMOKE');
    assert.equal(value({ name: 'fy_start', type: 'date' }), '2026-04-01');
    assert.equal(value({ name: 'fy_end', type: 'date' }), '2027-03-31');
    assert.equal(value({ name: 'ro_adrs1' }), '1 Smoke Test Street');
    assert.equal(value({ name: 'ro_adrs2' }), '1 Smoke Test Street');
  });

  it('fills contact and address details from labels, not just names', () => {
    assert.equal(value({ label: 'Registered office city' }), 'Bengaluru');
    assert.equal(value({ ariaLabel: 'Mobile number' }), '9000000000');
    assert.equal(value({ label: 'PIN code' }), '560001');
    assert.equal(value({ type: 'email' }), 'smoke.test@example.com');
  });

  it('honours an email override', () => {
    assert.equal(
      synthesizeFieldValue(field({ type: 'email' }), { entityName, email: 'qa@aicountly.com' }),
      'qa@aicountly.com',
    );
  });
});

describe('synthesizeFieldValue on an unfamiliar transaction form', () => {
  const value = (partial: Partial<FormFieldDescriptor>) =>
    synthesizeFieldValue(field(partial), { now: NOW });

  it('keeps every money and quantity value tiny', () => {
    assert.equal(value({ label: 'Quantity', type: 'number' }), '1');
    assert.equal(value({ label: 'Unit price', type: 'number' }), '1');
    assert.equal(value({ label: 'Discount %', type: 'number' }), '0');
    assert.equal(value({ label: 'Credit limit' }), '1');
  });

  it('answers free-text prompts with an obviously synthetic sentence', () => {
    assert.equal(value({ label: 'Narration' }), 'Synthetic smoke test entry');
    assert.equal(value({ label: 'Remarks', tag: 'textarea' }), 'Synthetic smoke test entry');
  });

  it('builds a traceable reference for document numbers', () => {
    assert.equal(value({ label: 'Invoice number' }), 'SMOKE-20260730');
    assert.equal(value({ name: 'voucher_no' }), 'SMOKE-20260730');
  });

  it('dates an undated field today and a range across the financial year', () => {
    assert.equal(value({ label: 'Voucher date', type: 'date' }), '2026-07-30');
    assert.equal(value({ label: 'From', type: 'date' }), '2026-04-01');
    assert.equal(value({ label: 'To', type: 'date' }), '2027-03-31');
  });

  it('does not read a bare "to" as a date range outside a date field', () => {
    assert.equal(value({ label: 'Ship to' }), null);
    assert.equal(value({ label: 'Ship to', type: 'date' }), '2027-03-31');
  });

  it('leaves a label it cannot read unanswered, required or not', () => {
    assert.equal(value({ name: 'custom_attr_7' }), null);
    assert.equal(value({ name: 'custom_attr_7', required: true }), null);
  });

  it('picks a plausible default for taxonomy fields', () => {
    assert.equal(value({ label: 'HSN' }), '9983');
    assert.equal(value({ label: 'Payment terms (days)' }), '30');
  });
});

describe('fields the run refuses to touch', () => {
  const value = (partial: Partial<FormFieldDescriptor>) =>
    synthesizeFieldValue(field(partial), { entityName: 'Smoke Test Co', now: NOW });

  it('never invents a checksum-bearing identifier', () => {
    for (const name of ['gstin', 'gst_no', 'cin', 'bank_account_number', 'ifsc_code', 'aadhaar']) {
      assert.equal(value({ name, required: true }), null, name);
      assert.equal(isUnsafeToFill(field({ name })), true, name);
    }
  });

  it('never types into a search or credential field', () => {
    assert.equal(value({ placeholder: 'Search companies, branches, FY' }), null);
    assert.equal(value({ name: 'password', type: 'password', required: true }), null);
    assert.equal(value({ name: 'otp', required: true }), null);
    assert.equal(isUnsafeToFill(field({ name: 'api_key' })), true);
  });

  it('allows an ordinary field', () => {
    assert.equal(isUnsafeToFill(field({ name: 'comp_name' })), false);
  });
});

describe('lastResortValue', () => {
  it('answers by type once nothing else could read the label', () => {
    assert.equal(lastResortValue(field({ name: 'custom_attr_7' })), 'Smoke Test');
    assert.equal(lastResortValue(field({ name: 'x', type: 'number' })), '1');
    assert.equal(lastResortValue(field({ name: 'x', type: 'email' })), 'smoke.test@example.com');
    assert.equal(lastResortValue(field({ name: 'x', tag: 'textarea' })), 'Synthetic smoke test entry');
  });

  it('still refuses the fields nothing may fill', () => {
    assert.equal(lastResortValue(field({ name: 'gstin' })), null);
    assert.equal(lastResortValue(field({ name: 'password', type: 'password' })), null);
  });
});

describe('shortCodeFor', () => {
  it('uppercases the first word and caps the length', () => {
    assert.equal(shortCodeFor('Smoke Test Co'), 'SMOKE');
    assert.equal(shortCodeFor('Extraordinarily Long Name'), 'EXTRAORD');
  });
});

describe('isPlaceholderOption', () => {
  it('treats empty values and prompt text as placeholders', () => {
    assert.equal(isPlaceholderOption('', 'Karnataka'), true);
    assert.equal(isPlaceholderOption('0', '-- Select state --'), true);
    assert.equal(isPlaceholderOption('29', 'Karnataka'), false);
  });
});
