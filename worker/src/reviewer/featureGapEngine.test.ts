import assert from 'node:assert/strict';
import test from 'node:test';
import { countExpectedFeatures, detectGaps, type CompetitorBenchmark } from './featureGapEngine.js';
import type { InventoryEntry } from '../scanner/uiInventory.js';

const benchmarks: CompetitorBenchmark[] = [{
  product_name: 'HRMS',
  competitor_name: 'Competitor',
  features: ['Attendance', 'Overtime rules', 'Form 16', 'PF'],
}];

function item(label: string, url: string, href = ''): InventoryEntry {
  return { kind: 'menu', label, selector: '#menu', url, payload: href ? { href } : {} };
}

test('never emits a gap row for a fully observed feature', () => {
  const rows = detectGaps('HRMS', [
    item('Attendance', '/attendance'),
  ], [{ product_name: 'HRMS', competitor_name: 'Competitor', features: ['Attendance'] }], {
    sessionName: 'Attendance',
    menuPath: '/attendance',
  });
  assert.equal(rows.length, 0);
  assert.ok(rows.every((row) => row.observed === false), 'no row in the output may claim observed:true');
});

test('omits fully observed features and keeps partial/missing ones with the original display spelling', () => {
  const rows = detectGaps('HRMS', [
    item('Attendance', '/attendance'),
    item('Overtime', '/attendance/overtime'),
  ], benchmarks, {
    sessionName: 'Attendance',
    menuPath: '/attendance',
  });

  assert.equal(rows.find((row) => row.expected_feature === 'Attendance'), undefined,
    'fully observed features generate no gap row at all');

  const overtime = rows.find((row) => row.expected_feature === 'Overtime rules');
  assert.equal(overtime?.observed, false);
  assert.equal(overtime?.partial, true);
  assert.equal(overtime?.severity, 'low');
  assert.equal(overtime?.mode, 'implement');

  // "Form 16" has zero token matches and no relation to the Attendance session
  // scope — no partial evidence either, so it is dropped as noise rather than
  // emitted as a validate_first row citing unrelated inventory.
  assert.equal(rows.find((row) => row.expected_feature === 'Form 16'), undefined);
});

test('URL/menu/href context satisfies a feature (dropping it) and scopes unrelated gaps to validate-first', () => {
  const rows = detectGaps('HRMS', [
    item('Daily register', 'https://product.test/attendance'),
  ], benchmarks, {
    sessionName: 'Attendance',
    menuPath: '/attendance',
    screensChecked: ['/attendance'],
  });

  // Attendance is fully satisfied by the URL, so it produces no row.
  assert.equal(rows.find((row) => row.expected_feature === 'Attendance'), undefined);
  // Form 16 has zero evidence and no scope relation — dropped as noise.
  assert.equal(rows.find((row) => row.expected_feature === 'Form 16'), undefined);

  // Overtime is in Attendance family scope but has zero inventory hits → validate_first.
  const overtime = rows.find((row) => row.expected_feature === 'Overtime rules');
  assert.equal(overtime?.mode, 'validate_first');
  assert.equal(overtime?.severity, 'suggestion');
  assert.deepEqual(overtime?.evidence.matched_context, []);
});

test('href payload contributes a partial match without being dropped', () => {
  const rows = detectGaps('HRMS', [
    // The href names "form" but not "16", so Form 16 is a partial (not full) match.
    item('Statutory reports', '/reports', '/payroll/form-request'),
  ], benchmarks, { sessionName: 'Payroll', menuPath: '/payroll' });
  const form16 = rows.find((row) => row.expected_feature === 'Form 16');
  assert.equal(form16?.observed, false);
  assert.equal(form16?.partial, true);
  assert.equal(form16?.evidence.matched_context?.includes('form'), true);
});

test('href payload can fully satisfy a feature, which then emits no row at all', () => {
  const rows = detectGaps('HRMS', [
    item('Statutory reports', '/reports', '/payroll/form-16'),
  ], benchmarks, { sessionName: 'Payroll', menuPath: '/payroll' });
  assert.equal(rows.find((row) => row.expected_feature === 'Form 16'), undefined);
});

test('an aliased product matches its canonical benchmarks, from either side', () => {
  const booksBenchmarks: CompetitorBenchmark[] = [{
    product_name: 'books',
    competitor_name: 'Competitor',
    features: ['Bank reconciliation'],
  }];
  const inventory = [item('Ledgers', '/ledgers')];

  // Bundled fallback catalogs tag rows canonically; the run carries the alias.
  // "Banking" as the session name keeps this feature in-scope so it survives
  // the out-of-scope/zero-evidence drop introduced alongside this test.
  const fromFallback = detectGaps('erp', inventory, booksBenchmarks, { sessionName: 'Banking' });
  assert.equal(fromFallback.length, 1);
  assert.equal(fromFallback[0]?.expected_feature, 'Bank reconciliation');

  // The API echoes the requested alias back on each row.
  const fromApi = detectGaps('erp', inventory, [{ ...booksBenchmarks[0], product_name: 'erp' }], { sessionName: 'Banking' });
  assert.equal(fromApi.length, 1);

  assert.equal(detectGaps('hrms', inventory, booksBenchmarks, {}).length, 0, 'unrelated products stay excluded');
});

test('short tokens do not over-match substrings', () => {
  const rows = detectGaps('HRMS', [
    item('AI-powered performance', '/payroll/pf-summary'),
  ], benchmarks, { sessionName: 'Payroll', menuPath: '/payroll' });
  assert.equal(rows.find((row) => row.expected_feature === 'PF'), undefined,
    'an exact URL segment fully satisfies PF, so no gap row is emitted');

  const falsePositiveGuard = detectGaps('HRMS', [
    item('Helpful reports', '/reports/helpful'),
  ], benchmarks, { sessionName: 'Payroll', menuPath: '/payroll' });
  const pf = falsePositiveGuard.find((row) => row.expected_feature === 'PF');
  assert.equal(pf?.observed, false, '"pf" inside helpful must not match');
  assert.equal(pf?.partial, false);
});

test('countExpectedFeatures counts every distinct expected feature regardless of what was observed', () => {
  assert.equal(countExpectedFeatures('HRMS', benchmarks), 4);
  assert.equal(countExpectedFeatures('HRMS', []), 0);
  assert.equal(countExpectedFeatures('books', benchmarks), 0, 'unrelated product has none');
});

test('synonym + title context makes employee directory observed (no implement row)', () => {
  const rows = detectGaps('HRMS', [
    item('Employees', '/employees'),
  ], [{ product_name: 'HRMS', competitor_name: 'Competitor', features: ['employee directory', 'employee profile'] }], {
    sessionName: 'Employees',
    menuPath: '/employees',
    pageTitles: ['Employees'],
    moduleNames: ['Employee Directory'],
  });

  assert.equal(rows.find((row) => /directory/i.test(row.expected_feature)), undefined,
    'directory covered by employees synonym / title must not emit a gap');
});

test('employee profile is observed when title/module carries profile synonyms', () => {
  const rows = detectGaps('HRMS', [
    item('Employees', '/employees'),
  ], [{ product_name: 'HRMS', competitor_name: 'Competitor', features: ['employee profile'] }], {
    sessionName: 'Employees',
    menuPath: '/employees',
    pageTitles: ['Employee details'],
    moduleNames: ['View details'],
  });
  assert.equal(rows.find((row) => /profile/i.test(row.expected_feature)), undefined);
});

test('inventory/menu Leave fully observes leave tracker (no implement row)', () => {
  const rows = detectGaps('HRMS', [
    item('Leave', '/attendance?tab=leave'),
  ], [{ product_name: 'HRMS', competitor_name: 'Competitor', features: ['leave tracker', 'Overtime rules'] }], {
    sessionName: 'Leave',
    menuPath: '/attendance?tab=leave',
    pageTitles: ['Leave'],
    moduleNames: ['Attendance'],
  });

  assert.equal(rows.find((row) => /leave tracker/i.test(row.expected_feature)), undefined,
    'leave tracker covered by Leave menu / phrase synonym must not emit a gap');
});

test('Portal approvals / Approvals fully observes approvals workflow (no implement row)', () => {
  const viaPortal = detectGaps('HRMS', [
    item('Portal approvals', '/approvals'),
  ], [{ product_name: 'HRMS', competitor_name: 'Competitor', features: ['approvals workflow'] }], {
    sessionName: 'Approvals',
    menuPath: '/approvals',
    pageTitles: ['Portal approvals'],
  });
  assert.equal(viaPortal.find((row) => /approvals workflow/i.test(row.expected_feature)), undefined);

  const viaApprovals = detectGaps('HRMS', [
    item('Approvals', '/workflow/approvals'),
  ], [{ product_name: 'HRMS', competitor_name: 'Competitor', features: ['approvals workflow'] }], {
    sessionName: 'Approvals',
    menuPath: '/workflow/approvals',
    pageTitles: ['Approvals'],
  });
  assert.equal(viaApprovals.find((row) => /approvals workflow/i.test(row.expected_feature)), undefined);
});

test('out-of-scope gap evidence is always filtered to session-related inventory, never login-page noise', () => {
  const rows = detectGaps('HRMS', [
    item('Sign in', '/login'),
    item('Region: IN', '/login'),
    item('Payroll module', '/payroll'),
  ], [{ product_name: 'HRMS', competitor_name: 'Competitor', features: ['Payroll settings'] }], {
    sessionName: 'Attendance',
    menuPath: '/attendance',
  });
  const gap = rows.find((row) => row.expected_feature === 'Payroll settings');
  assert.ok(gap, 'partial match on "payroll" keeps the row from being dropped as pure noise');
  assert.equal(gap?.mode, 'validate_first');
  assert.equal(gap?.evidence.sample_labels.includes('Sign in'), false);
  assert.equal(gap?.evidence.sample_labels.includes('Region: IN'), false);
});

test('zero-evidence in-scope session-family features become validate_first, not implement', () => {
  const rows = detectGaps('HRMS', [
    item('Attendance & Leave', '/attendance'),
  ], [{
    product_name: 'HRMS',
    competitor_name: 'Competitor',
    features: ['shift scheduler', 'timesheet', 'geo attendance'],
  }], {
    sessionName: 'Attendance',
    menuPath: '/attendance',
  });

  const shift = rows.find((row) => row.expected_feature === 'shift scheduler');
  assert.equal(shift?.mode, 'validate_first');
  assert.equal(shift?.confidence, 'low');
  assert.deepEqual(shift?.evidence.matched_context, []);
  assert.match(shift?.notes ?? '', /confirm product scope/i);

  const timesheet = rows.find((row) => row.expected_feature === 'timesheet');
  assert.equal(timesheet?.mode, 'validate_first');
  assert.deepEqual(timesheet?.evidence.matched_context, []);

  // geo attendance matches only the generic anchor → validate_first (not implement+partial).
  const geo = rows.find((row) => row.expected_feature === 'geo attendance');
  assert.equal(geo?.mode, 'validate_first');
  assert.equal(geo?.partial, true);
  assert.deepEqual(geo?.evidence.matched_context, ['attendance']);
});

test('partial gaps that match a distinctive token stay implement', () => {
  const rows = detectGaps('HRMS', [
    item('Overtime', '/attendance/overtime'),
  ], [{ product_name: 'HRMS', competitor_name: 'Competitor', features: ['Overtime rules'] }], {
    sessionName: 'Attendance',
    menuPath: '/attendance',
  });
  const overtime = rows.find((row) => row.expected_feature === 'Overtime rules');
  assert.equal(overtime?.mode, 'implement');
  assert.equal(overtime?.partial, true);
  assert.ok(overtime?.evidence.matched_context?.includes('overtime'));
});
