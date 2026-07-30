import assert from 'node:assert/strict';
import test from 'node:test';
import { dedupeUxIssues, reviewPage, type UxIssue } from './uxReviewEngine.js';
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

test('console errors that are only resource-load 404s are downgraded to medium and not treated as a JS bug hunt', () => {
  const findings = reviewPage({
    meta: meta(),
    inventory: [],
    consoleEvents: [
      { type: 'error', text: 'Failed to load resource: the server responded with a status of 404 ()' },
      { type: 'error', text: 'Failed to load resource: the server responded with a status of 404 ()' },
    ],
    networkEvents: [],
  }).filter((issue) => issue.category === 'errors');

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, 'medium');
  assert.match(findings[0]?.recommendation ?? '', /fallback/i);
  assert.doesNotMatch(findings[0]?.recommendation ?? '', /treat as P1/i);
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

test('a duplicate placeholder-style label recommends a per-field accessible name instead of renaming visible copy', () => {
  const placeholderFindings = reviewPage({
    meta: meta(),
    inventory: [button('— select —'), button('— select —'), button('— select —')],
    consoleEvents: [],
    networkEvents: [],
  }).filter((issue) => issue.category === 'layout' && issue.title.includes('select'));

  assert.equal(placeholderFindings.length, 1);
  assert.match(placeholderFindings[0]?.recommendation ?? '', /accessible name/i);
  assert.doesNotMatch(placeholderFindings[0]?.recommendation ?? '', /disambiguate via icon/i);

  const ordinaryFindings = reviewPage({
    meta: meta(),
    inventory: [button('Delete'), button('Delete'), button('Delete')],
    consoleEvents: [],
    networkEvents: [],
  }).filter((issue) => issue.category === 'layout' && issue.title.toLowerCase().includes('delete'));

  assert.equal(ordinaryFindings.length, 1);
  assert.match(ordinaryFindings[0]?.recommendation ?? '', /disambiguate via icon/i);
});
