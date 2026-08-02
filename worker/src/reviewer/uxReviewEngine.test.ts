import assert from 'node:assert/strict';
import test from 'node:test';
import { dedupeUxIssues, dropProvenShellUxIssues, reviewPage, type UxIssue } from './uxReviewEngine.js';
import type { PageMetadata } from '../scanner/pageScanner.js';
import type { InventoryEntry } from '../scanner/uiInventory.js';

function meta(overrides: Partial<PageMetadata> = {}): PageMetadata {
  return {
    url: 'https://hrms.test/company',
    title: 'HRMS',
    module_name: 'Dashboard',
    is_authenticated_shell: true,
    has_breadcrumb: true,
    has_search: true,
    has_help_text: true,
    has_keyboard_shortcuts: true,
    has_export: true,
    has_print: true,
    has_download: true,
    has_upload: false,
    file_input_count: 0,
    file_accept_mimes: [],
    empty_state: false,
    empty_state_text: '',
    table_overflow: false,
    modal_overflow: false,
    primary_buttons: 4,
    forms: 0,
    tables: 0,
    filters: 1,
    old_theme_indicators: [],
    ...overrides,
  };
}

function button(label: string): InventoryEntry {
  return { kind: 'button', label, selector: 'button', url: 'https://hrms.test/company', payload: {} };
}

function issue(url: string, screenshot: string, resultId: number): UxIssue {
  return {
    result_id: resultId,
    category: 'navigation',
    severity: 'low',
    title: 'Breadcrumb missing',
    description: 'No breadcrumb.',
    recommendation: 'Add breadcrumb.',
    human_summary: 'Make this screen easier to navigate.',
    developer_prompt: '',
    evidence: {
      affected_urls: [url],
      screenshot_paths: [screenshot],
      inventory_samples: [{ kind: 'menu', label: url, selector: '#nav' }],
    },
  };
}

test('dedupes UX findings by category/title and merges screen evidence', () => {
  const findings = dedupeUxIssues([
    issue('/attendance', '/shots/attendance.png', 10),
    issue('/attendance/regularization', '/shots/regularization.png', 11),
  ]);

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.result_id, 10);
  assert.deepEqual(findings[0]?.evidence.affected_urls, ['/attendance', '/attendance/regularization']);
  assert.deepEqual(findings[0]?.evidence.screenshot_paths, ['/shots/attendance.png', '/shots/regularization.png']);
  assert.equal(findings[0]?.human_summary, 'Make this screen easier to navigate.');
});

test('a fallback state with no resolving control is reported as a dead end', () => {
  const findings = reviewPage({
    meta: meta({ empty_state: true, empty_state_text: 'No company selected' }),
    inventory: [button('Refresh')],
    consoleEvents: [],
    networkEvents: [],
  }).filter((issue) => issue.category === 'empty_state');

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, 'medium');
  assert.match(String(findings[0]?.description), /No company selected/);
});

test('a fallback state whose only way out sits elsewhere on the screen is still reported', () => {
  // The way forward existed on the observed dashboard — "Switch Company" and
  // "Add Company" — just not in the message that stopped the user, which is the
  // whole complaint. Saying nothing at all was the previous behaviour.
  const findings = reviewPage({
    meta: meta({ empty_state: true, empty_state_text: 'No company selected' }),
    inventory: [button('Switch Company'), button('Add Company')],
    consoleEvents: [],
    networkEvents: [],
  }).filter((issue) => issue.category === 'empty_state');

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, 'low');
  assert.match(String(findings[0]?.description), /Switch Company/);
});

test('a screen that is not in a fallback state raises no empty-state finding', () => {
  const findings = reviewPage({
    meta: meta(),
    inventory: [button('Add Company')],
    consoleEvents: [],
    networkEvents: [],
  }).filter((issue) => issue.category === 'empty_state');

  assert.equal(findings.length, 0);
});

test('no multi_tenant finding fires on an unauthenticated screen, even with a matching title', () => {
  const findings = reviewPage({
    meta: meta({ is_authenticated_shell: false, title: 'HRMS Payroll — Sign in' }),
    inventory: [],
    consoleEvents: [],
    networkEvents: [],
  }).filter((issue) => issue.category === 'multi_tenant');

  assert.equal(findings.length, 0);
});

test('a company/branch/FY inventory entry of any selector kind suppresses the multi_tenant finding', () => {
  const withSelector = reviewPage({
    meta: meta({ title: 'HRMS Payroll' }),
    inventory: [{ kind: 'branch_selector', label: '2026 - 27 | HO', selector: 'button', url: 'https://hrms.test/company', payload: {} }],
    consoleEvents: [],
    networkEvents: [],
  }).filter((issue) => issue.category === 'multi_tenant');
  assert.equal(withSelector.length, 0);

  const withoutSelector = reviewPage({
    meta: meta({ title: 'HRMS Payroll' }),
    inventory: [],
    consoleEvents: [],
    networkEvents: [],
  }).filter((issue) => issue.category === 'multi_tenant');
  assert.equal(withoutSelector.length, 1);
});

test('logo/resource 404 console + soft-asset network emit no error-category UX issues', () => {
  const findings = reviewPage({
    meta: meta(),
    inventory: [],
    consoleEvents: [
      { type: 'error', text: 'Failed to load resource: the server responded with a status of 404 ()' },
      { type: 'error', text: 'Failed to load resource: the server responded with a status of 404 ()' },
    ],
    networkEvents: [
      { url: 'https://product.test/logo.png', method: 'GET', status: 404, ok: false },
    ],
  }).filter((issue) => issue.category === 'errors');

  assert.equal(findings.length, 0);
});

test('a real script exception still reports critical even alongside a resource 404', () => {
  const findings = reviewPage({
    meta: meta(),
    inventory: [],
    consoleEvents: [
      { type: 'error', text: 'Failed to load resource: the server responded with a status of 404 ()' },
      { type: 'pageerror', text: 'TypeError: cannot read properties of undefined' },
    ],
    networkEvents: [],
  }).filter((issue) => issue.category === 'errors');

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, 'critical');
});

test('search inventory suppresses the filters finding on a table screen', () => {
  const withSearch = reviewPage({
    meta: meta({ tables: 1, filters: 0, has_export: true, has_print: true }),
    inventory: [{ kind: 'search', label: 'Search employees', selector: 'input', url: 'https://hrms.test/employees', payload: {} }],
    consoleEvents: [],
    networkEvents: [],
  }).filter((issue) => issue.category === 'filters');
  assert.equal(withSearch.length, 0);

  const without = reviewPage({
    meta: meta({ tables: 1, filters: 0, has_export: true, has_print: true }),
    inventory: [],
    consoleEvents: [],
    networkEvents: [],
  }).filter((issue) => issue.category === 'filters');
  assert.equal(without.length, 1);
});

test('meta.filters > 0 suppresses the filters finding even without inventory kinds', () => {
  const findings = reviewPage({
    meta: meta({ tables: 1, filters: 2, has_export: true, has_print: true }),
    inventory: [],
    consoleEvents: [],
    networkEvents: [],
  }).filter((issue) => issue.category === 'filters');
  assert.equal(findings.length, 0);
});

test('analytics and logo 404s do not yield a high network finding', () => {
  const findings = reviewPage({
    meta: meta(),
    inventory: [],
    consoleEvents: [
      { type: 'error', text: 'Failed to load resource: the server responded with a status of 404 ()' },
    ],
    networkEvents: [
      { url: 'https://www.google-analytics.com/g/collect?v=2', method: 'GET', status: 0, ok: false },
      { url: 'https://product.test/logo.png', method: 'GET', status: 404, ok: false },
    ],
  }).filter((issue) => issue.category === 'errors' && /network|api|asset/i.test(issue.title));

  assert.ok(findings.every((f) => f.severity !== 'high'));
  assert.ok(!findings.some((f) => /Network\/API failures/i.test(f.title)));
});

test('POST 409 create conflicts are low, not high', () => {
  const findings = reviewPage({
    meta: meta(),
    inventory: [],
    consoleEvents: [],
    networkEvents: [
      { url: 'https://product.test/api/employees', method: 'POST', status: 409, ok: false },
    ],
  }).filter((issue) => issue.category === 'errors');

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, 'low');
  assert.match(findings[0]?.title ?? '', /409/i);
});

test('multi_tenant fires on any authenticated shell without selectors, not only HRMS-titled pages', () => {
  const findings = reviewPage({
    meta: meta({ title: 'Portal Home' }),
    inventory: [],
    consoleEvents: [],
    networkEvents: [],
  }).filter((issue) => issue.category === 'multi_tenant');
  assert.equal(findings.length, 1);
});

test('placeholder and CRUD row-action duplicate labels are not emitted as UX issues', () => {
  const placeholderFindings = reviewPage({
    meta: meta(),
    inventory: [button('— select —'), button('— select —'), button('— select —')],
    consoleEvents: [],
    networkEvents: [],
  }).filter((issue) => issue.category === 'layout' && issue.title.includes('select'));
  assert.equal(placeholderFindings.length, 0);

  const editButtons = Array.from({ length: 17 }, () => button('Edit'));
  const deactivateButtons = Array.from({ length: 17 }, () => button('Deactivate'));
  const rowActionFindings = reviewPage({
    meta: meta(),
    inventory: [...editButtons, ...deactivateButtons],
    consoleEvents: [],
    networkEvents: [],
  }).filter((issue) => issue.category === 'layout' && /duplicate button label/i.test(issue.title));
  assert.equal(rowActionFindings.length, 0);
});

test('thrice-repeated custom labels still fire a duplicate finding', () => {
  const findings = reviewPage({
    meta: meta(),
    inventory: [button('Save draft'), button('Save draft'), button('Save draft')],
    consoleEvents: [],
    networkEvents: [],
  }).filter((issue) => issue.category === 'layout' && /save draft/i.test(issue.title));

  assert.equal(findings.length, 1);
  assert.match(findings[0]?.recommendation ?? '', /disambiguate via icon/i);
});

test('Download/export inventory suppresses the export finding on a table screen', () => {
  const withDownload = reviewPage({
    meta: meta({ tables: 1, has_export: false, has_download: true, has_print: false }),
    inventory: [{ kind: 'download', label: 'Download CSV', selector: 'button', url: 'https://hrms.test/reports', payload: {} }],
    consoleEvents: [],
    networkEvents: [],
  }).filter((issue) => issue.category === 'reports' && /export/i.test(issue.title));
  assert.equal(withDownload.length, 0);

  const withMetaExport = reviewPage({
    meta: meta({ tables: 1, has_export: true, has_download: true }),
    inventory: [],
    consoleEvents: [],
    networkEvents: [],
  }).filter((issue) => issue.category === 'reports' && /export/i.test(issue.title));
  assert.equal(withMetaExport.length, 0);

  const missing = reviewPage({
    meta: meta({ tables: 1, has_export: false, has_download: false, has_print: false }),
    inventory: [],
    consoleEvents: [],
    networkEvents: [],
  }).filter((issue) => issue.category === 'reports' && /export/i.test(issue.title));
  assert.equal(missing.length, 1);
});

test('search inventory suppresses Command/search missing even when meta.has_search is false', () => {
  const findings = reviewPage({
    meta: meta({ has_search: false }),
    inventory: [{ kind: 'search', label: 'Open search', selector: 'button', url: 'https://hrms.test/app', payload: {} }],
    consoleEvents: [],
    networkEvents: [],
  }).filter((issue) => issue.category === 'navigation' && /search|command/i.test(issue.title));
  assert.equal(findings.length, 0);

  const without = reviewPage({
    meta: meta({ has_search: false }),
    inventory: [],
    consoleEvents: [],
    networkEvents: [],
  }).filter((issue) => issue.category === 'navigation' && /search|command/i.test(issue.title));
  assert.equal(without.length, 1);
});

test('dropProvenShellUxIssues removes multi_tenant and search when run labels prove them', () => {
  const issues: UxIssue[] = [
    {
      category: 'multi_tenant',
      severity: 'low',
      title: 'Company / branch / FY selector not detected',
      description: '',
      recommendation: '',
      human_summary: '',
      developer_prompt: 'x',
      evidence: {},
    },
    {
      category: 'navigation',
      severity: 'low',
      title: 'Command/search box missing',
      description: '',
      recommendation: '',
      human_summary: '',
      developer_prompt: 'x',
      evidence: {},
    },
    {
      category: 'navigation',
      severity: 'low',
      title: 'Breadcrumb missing',
      description: '',
      recommendation: '',
      human_summary: '',
      developer_prompt: 'x',
      evidence: {},
    },
  ];
  const kept = dropProvenShellUxIssues(issues, ['2026 - 27 | HO', 'Search employees…']);
  assert.equal(kept.length, 1);
  assert.equal(kept[0]?.title, 'Breadcrumb missing');
});

test('listbox/date filter inventory shapes suppress the filters finding on a table screen', () => {
  const listbox = reviewPage({
    meta: meta({ tables: 1, filters: 0, has_export: true, has_print: true }),
    inventory: [{
      kind: 'filter',
      label: 'Department',
      selector: 'button',
      url: 'https://hrms.test/leave',
      payload: { role: 'listbox_popup' },
    }],
    consoleEvents: [],
    networkEvents: [],
  }).filter((issue) => issue.category === 'filters');
  assert.equal(listbox.length, 0);

  const dateFilter = reviewPage({
    meta: meta({ tables: 1, filters: 0, has_export: true, has_print: true }),
    inventory: [{
      kind: 'filter',
      label: 'From',
      selector: 'input',
      url: 'https://hrms.test/leave',
      payload: { role: 'date_filter', type: 'date' },
    }],
    consoleEvents: [],
    networkEvents: [],
  }).filter((issue) => issue.category === 'filters');
  assert.equal(dateFilter.length, 0);
});
