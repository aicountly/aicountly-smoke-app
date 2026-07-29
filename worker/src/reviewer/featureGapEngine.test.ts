import assert from 'node:assert/strict';
import test from 'node:test';
import { detectGaps, type CompetitorBenchmark } from './featureGapEngine.js';
import type { InventoryEntry } from '../scanner/uiInventory.js';

const benchmarks: CompetitorBenchmark[] = [{
  product_name: 'HRMS',
  competitor_name: 'Competitor',
  features: ['Attendance', 'Overtime rules', 'Form 16', 'PF'],
}];

function item(label: string, url: string, href = ''): InventoryEntry {
  return { kind: 'menu', label, selector: '#menu', url, payload: href ? { href } : {} };
}

test('emits observed, partial, and missing coverage rows', () => {
  const rows = detectGaps('HRMS', [
    item('Attendance', '/attendance'),
    item('Overtime', '/attendance/overtime'),
  ], benchmarks, {
    sessionName: 'Attendance',
    menuPath: '/attendance',
  });

  const attendance = rows.find((row) => row.expected_feature === 'attendance');
  assert.equal(attendance?.observed, true);
  assert.equal(attendance?.partial, false);
  assert.equal(attendance?.severity, 'suggestion');
  assert.equal(attendance?.mode, 'validate_first');
  assert.equal(attendance?.confidence, 'high');

  const overtime = rows.find((row) => row.expected_feature === 'overtime rules');
  assert.equal(overtime?.observed, false);
  assert.equal(overtime?.partial, true);

  const form16 = rows.find((row) => row.expected_feature === 'form 16');
  assert.equal(form16?.observed, false);
  assert.equal(form16?.partial, false);
  assert.equal(form16?.human_summary, '');
  assert.deepEqual(form16?.evidence.screens_checked, ['/attendance', '/attendance/overtime']);
});

test('URL/menu/href context satisfies a feature and scopes unrelated gaps to validate-first', () => {
  const rows = detectGaps('HRMS', [
    item('Daily register', 'https://product.test/attendance'),
  ], benchmarks, {
    sessionName: 'Attendance',
    menuPath: '/attendance',
    screensChecked: ['/attendance'],
  });

  const attendance = rows.find((row) => row.expected_feature === 'attendance');
  assert.equal(attendance?.observed, true);
  assert.equal(attendance?.partial, false);
  const form16 = rows.find((gap) => gap.expected_feature === 'form 16');
  assert.equal(form16?.mode, 'validate_first');
  assert.equal(form16?.severity, 'suggestion');
  assert.equal(form16?.confidence, 'low');
  const overtime = rows.find((gap) => gap.expected_feature === 'overtime rules');
  assert.equal(overtime?.mode, 'implement');
  assert.equal(overtime?.severity, 'medium');
});

test('href payload participates in feature matching', () => {
  const rows = detectGaps('HRMS', [
    item('Statutory reports', '/reports', '/payroll/form-16'),
  ], benchmarks, { sessionName: 'Payroll', menuPath: '/payroll' });
  const form16 = rows.find((row) => row.expected_feature === 'form 16');
  assert.equal(form16?.observed, true);
  assert.equal(form16?.partial, false);
});

test('an aliased product matches its canonical benchmarks, from either side', () => {
  const booksBenchmarks: CompetitorBenchmark[] = [{
    product_name: 'books',
    competitor_name: 'Competitor',
    features: ['Bank reconciliation'],
  }];
  const inventory = [item('Ledgers', '/ledgers')];

  // Bundled fallback catalogs tag rows canonically; the run carries the alias.
  const fromFallback = detectGaps('erp', inventory, booksBenchmarks, { sessionName: 'Banking' });
  assert.equal(fromFallback.length, 1);
  assert.equal(fromFallback[0]?.expected_feature, 'bank reconciliation');

  // The API echoes the requested alias back on each row.
  const fromApi = detectGaps('erp', inventory, [{ ...booksBenchmarks[0], product_name: 'erp' }], {});
  assert.equal(fromApi.length, 1);

  assert.equal(detectGaps('hrms', inventory, booksBenchmarks, {}).length, 0, 'unrelated products stay excluded');
});

test('short tokens do not over-match substrings', () => {
  const rows = detectGaps('HRMS', [
    item('AI-powered performance', '/payroll/pf-summary'),
  ], benchmarks, { sessionName: 'Payroll', menuPath: '/payroll' });
  assert.equal(rows.find((row) => row.expected_feature === 'pf')?.observed, true, 'exact URL segment should satisfy PF');

  const falsePositiveGuard = detectGaps('HRMS', [
    item('Helpful reports', '/reports/helpful'),
  ], benchmarks, { sessionName: 'Payroll', menuPath: '/payroll' });
  const pf = falsePositiveGuard.find((row) => row.expected_feature === 'pf');
  assert.equal(pf?.observed, false, '"pf" inside helpful must not match');
  assert.equal(pf?.partial, false);
});
