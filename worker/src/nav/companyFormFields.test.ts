import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  financialYearWindow,
  isPlaceholderOption,
  shortCodeFor,
  synthesizeCompanyFieldValue,
  type CompanyFormField,
} from './companyFormFields.js';

function field(partial: Partial<CompanyFormField>): CompanyFormField {
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

describe('synthesizeCompanyFieldValue', () => {
  const name = 'Smoke Test Co';
  const value = (partial: Partial<CompanyFormField>) =>
    synthesizeCompanyFieldValue(field(partial), name, { now: NOW });

  it('maps the AICOUNTLY Manage company form field names', () => {
    assert.equal(value({ name: 'comp_name' }), name);
    assert.equal(value({ name: 'print_name' }), name);
    assert.equal(value({ name: 'short_name' }), 'SMOKE');
    assert.equal(value({ name: 'fy_start', type: 'date' }), '2026-04-01');
    assert.equal(value({ name: 'fy_end', type: 'date' }), '2027-03-31');
    assert.equal(value({ name: 'ro_adrs1' }), '1 Smoke Test Street');
    assert.equal(value({ name: 'ro_adrs2' }), '1 Smoke Test Street');
  });

  it('never invents a checksum-bearing identifier', () => {
    assert.equal(value({ name: 'gstin', required: true }), null);
    assert.equal(value({ name: 'gst_no', required: true }), null);
    assert.equal(value({ name: 'cin', required: true }), null);
    assert.equal(value({ name: 'bank_account_number', required: true }), null);
  });

  it('never types into a search or credential field', () => {
    assert.equal(value({ placeholder: 'Search companies, branches, FY' }), null);
    assert.equal(value({ name: 'password', type: 'password', required: true }), null);
  });

  it('fills contact and address details from labels, not just names', () => {
    assert.equal(value({ label: 'Registered office city' }), 'Bengaluru');
    assert.equal(value({ ariaLabel: 'Mobile number' }), '9000000000');
    assert.equal(value({ label: 'PIN code' }), '560001');
    assert.equal(value({ type: 'email' }), 'smoke.test@example.com');
  });

  it('honours an email override', () => {
    assert.equal(
      synthesizeCompanyFieldValue(field({ type: 'email' }), name, { email: 'qa@aicountly.com' }),
      'qa@aicountly.com',
    );
  });

  it('leaves unknown optional fields blank but fills unknown required ones', () => {
    assert.equal(value({ name: 'remarks_extra' }), null);
    assert.equal(value({ name: 'remarks_extra', required: true }), 'Smoke Test');
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
