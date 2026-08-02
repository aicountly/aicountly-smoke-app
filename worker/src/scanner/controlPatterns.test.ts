import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BRANCH_LABEL_PATTERN,
  EXPORT_OR_DOWNLOAD_LABEL_PATTERN,
  FY_LABEL_PATTERN,
  ROW_ACTION_LABEL_PATTERN,
  SEARCH_LABEL_PATTERN,
  SELECTOR_LABEL_PATTERN,
  TOOLBAR_FILTER_LABEL_PATTERN,
  classifyShellLabel,
} from './controlPatterns.js';

test('selector label pattern matches a company/branch/FY switcher label', () => {
  assert.match('2026 - 27 | HO', SELECTOR_LABEL_PATTERN);
  assert.match('FY 2026-27', SELECTOR_LABEL_PATTERN);
  assert.match('Acme Company', SELECTOR_LABEL_PATTERN);
});

test('selector label pattern does not recognise a bare tenant name with no company/branch/FY word', () => {
  // Label-only pattern still misses bare tenant names; classifyShellLabel covers
  // them when a FY/branch sibling is present (see sibling heuristic tests below).
  assert.doesNotMatch('Smoke Test Co', SELECTOR_LABEL_PATTERN);
});

test('selector label pattern rejects an ordinary button', () => {
  assert.doesNotMatch('Save changes', SELECTOR_LABEL_PATTERN);
  assert.doesNotMatch('Delete', SELECTOR_LABEL_PATTERN);
});

test('branch/FY sub-patterns disambiguate the more specific inventory kind', () => {
  assert.match('2026 - 27 | HO', BRANCH_LABEL_PATTERN);
  assert.doesNotMatch('Acme Company', BRANCH_LABEL_PATTERN);
  assert.match('FY 2026-27', FY_LABEL_PATTERN);
  assert.match('2026 - 27', FY_LABEL_PATTERN);
});

test('search label pattern matches a command-palette trigger', () => {
  assert.match('Search employees, modules…', SEARCH_LABEL_PATTERN);
  assert.match('Press Ctrl+K to search', SEARCH_LABEL_PATTERN);
  assert.match('Cmd+K', SEARCH_LABEL_PATTERN);
});

test('search label pattern rejects an ordinary button', () => {
  assert.doesNotMatch('Add Employee', SEARCH_LABEL_PATTERN);
  assert.doesNotMatch('Filters', SEARCH_LABEL_PATTERN);
});

test('toolbar filter label pattern matches All/status/date-range chips', () => {
  assert.match('All', TOOLBAR_FILTER_LABEL_PATTERN);
  assert.match('Status', TOOLBAR_FILTER_LABEL_PATTERN);
  assert.match('From', TOOLBAR_FILTER_LABEL_PATTERN);
  assert.match('To date', TOOLBAR_FILTER_LABEL_PATTERN);
  assert.match('Department', TOOLBAR_FILTER_LABEL_PATTERN);
  assert.match('Branch HO', TOOLBAR_FILTER_LABEL_PATTERN);
  assert.match('Category', TOOLBAR_FILTER_LABEL_PATTERN);
  assert.match('Type', TOOLBAR_FILTER_LABEL_PATTERN);
  assert.doesNotMatch('Add Employee', TOOLBAR_FILTER_LABEL_PATTERN);
  assert.doesNotMatch('Export', TOOLBAR_FILTER_LABEL_PATTERN);
});

test('row-action label pattern matches CRUD buttons but not arbitrary labels', () => {
  assert.match('Edit', ROW_ACTION_LABEL_PATTERN);
  assert.match('Deactivate', ROW_ACTION_LABEL_PATTERN);
  assert.match('Delete', ROW_ACTION_LABEL_PATTERN);
  assert.match('View', ROW_ACTION_LABEL_PATTERN);
  assert.match('All', ROW_ACTION_LABEL_PATTERN);
  assert.match('Approve', ROW_ACTION_LABEL_PATTERN);
  assert.match('Reject', ROW_ACTION_LABEL_PATTERN);
  assert.doesNotMatch('Confirm', ROW_ACTION_LABEL_PATTERN);
  assert.doesNotMatch('Edit employee details', ROW_ACTION_LABEL_PATTERN);
});

test('export/download label pattern matches tabular downloads and export', () => {
  assert.match('Download CSV', EXPORT_OR_DOWNLOAD_LABEL_PATTERN);
  assert.match('Download Excel', EXPORT_OR_DOWNLOAD_LABEL_PATTERN);
  assert.match('Download PDF', EXPORT_OR_DOWNLOAD_LABEL_PATTERN);
  assert.match('Export', EXPORT_OR_DOWNLOAD_LABEL_PATTERN);
  assert.match('Export to XLSX', EXPORT_OR_DOWNLOAD_LABEL_PATTERN);
  assert.doesNotMatch('Download list', EXPORT_OR_DOWNLOAD_LABEL_PATTERN);
  assert.doesNotMatch('Save changes', EXPORT_OR_DOWNLOAD_LABEL_PATTERN);
});

test('classifyShellLabel: Add Company is not a company_selector', () => {
  assert.equal(classifyShellLabel('Add Company'), null);
  assert.equal(classifyShellLabel('Create Company'), null);
  assert.equal(classifyShellLabel('Manage Branch'), null);
});

test('classifyShellLabel: label-based company/branch/FY switchers still classify', () => {
  assert.equal(classifyShellLabel('Acme Company'), 'company_selector');
  assert.equal(classifyShellLabel('2026 - 27 | HO'), 'branch_selector');
  assert.equal(classifyShellLabel('FY 2026-27'), 'fy_selector');
  assert.equal(classifyShellLabel('Search employees, modules…'), 'search');
});

test('classifyShellLabel: bare tenant next to FY/HO sibling is a company_selector', () => {
  assert.equal(classifyShellLabel('Smoke Test Co', ['2026 - 27 | HO']), 'company_selector');
  assert.equal(classifyShellLabel('Smoke Test Co', ['FY 2026-27']), 'company_selector');
  assert.equal(classifyShellLabel('Smoke Test Co', []), null);
  assert.equal(classifyShellLabel('Notifications', ['2026 - 27 | HO']), null);
});
