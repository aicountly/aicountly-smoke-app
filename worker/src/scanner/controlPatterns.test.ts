import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BRANCH_LABEL_PATTERN,
  FY_LABEL_PATTERN,
  SEARCH_LABEL_PATTERN,
  SELECTOR_LABEL_PATTERN,
} from './controlPatterns.js';

test('selector label pattern matches a company/branch/FY switcher label', () => {
  assert.match('2026 - 27 | HO', SELECTOR_LABEL_PATTERN);
  assert.match('FY 2026-27', SELECTOR_LABEL_PATTERN);
  assert.match('Acme Company', SELECTOR_LABEL_PATTERN);
});

test('selector label pattern does not recognise a bare tenant name with no company/branch/FY word', () => {
  // A known blind spot (see samples/prompts/detector-caveats.json, multi_tenant):
  // a switcher button showing only the tenant's own name, with none of the
  // literal words this heuristic looks for, still slips through undetected.
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
