import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  evaluateDownloadedArtifact,
  evaluateScenarioGate,
  scenarioMatchesContext,
  shouldRunFileIoSession,
} from './fileIoEngine.js';
import type { FileIoScenario } from './types.js';

const scenario: FileIoScenario = {
  key: 'dry-run',
  kind: 'round_trip',
  fixture: 'contacts/contacts-import.csv',
  expected_mime: ['text/csv'],
  menu_hints: ['import'],
  competitor_standard_prompt: 'Synthetic test',
};

test('fileIoEngine dry-run gate returns skipped/blocked semantics without touching page', () => {
  const gate = evaluateScenarioGate(scenario, {
    environment: 'production_readonly',
    allowSafeDemo: true,
    destructiveAllowed: true,
    allowedActions: ['upload_file', 'download_file', 'compare_file'],
  });
  assert.equal(gate.allowed, false);
  assert.match(gate.reason ?? '', /production/);
});

test('non-File-I/O sessions do not opt into scenario execution from detected UI alone', () => {
  assert.equal(shouldRunFileIoSession('Dashboard overview', ['click_menu', 'screenshot']), false);
  assert.equal(shouldRunFileIoSession('File I/O & exports', ['click_menu']), true);
  assert.equal(shouldRunFileIoSession('Reports', ['export_file', 'compare_file']), true);
});

test('menu hints scope scenarios to observed URLs, titles, and inventory labels', () => {
  assert.equal(scenarioMatchesContext(scenario, {
    urls: ['https://example.test/contacts'],
    titles: ['Contacts'],
    inventoryLabels: ['Import CSV'],
  }), true);
  assert.equal(scenarioMatchesContext(scenario, {
    urls: ['https://example.test/dashboard'],
    titles: ['Dashboard'],
    inventoryLabels: ['Revenue chart'],
  }), false);
});

test('round-trip and export gates require compare_file', () => {
  const context = {
    environment: 'sandbox',
    allowSafeDemo: true,
    destructiveAllowed: true,
    allowedActions: ['upload_file', 'download_file'],
  };
  const roundTrip = evaluateScenarioGate(scenario, context);
  assert.equal(roundTrip.allowed, false);
  assert.match(roundTrip.reason ?? '', /compare_file/);

  const exportScenario = { ...scenario, kind: 'export' as const };
  const exportGate = evaluateScenarioGate(exportScenario, {
    ...context,
    allowedActions: ['export_file'],
  });
  assert.equal(exportGate.allowed, false);
  assert.match(exportGate.reason ?? '', /compare_file/);
});

test('export validation ignores fixture hash mismatch and checks output structure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-export-check-'));
  const fixture = path.join(dir, 'fixture.csv');
  const exported = path.join(dir, 'export.csv');
  fs.writeFileSync(fixture, 'fixture,value\none,1\n');
  fs.writeFileSync(exported, 'account,balance\ncash,100\n');
  const comparison = evaluateDownloadedArtifact(
    { ...scenario, kind: 'export', expected_mime: ['text/csv'] },
    fixture,
    exported,
  );
  assert.equal(comparison.status, 'pass');
  assert.equal(comparison.source_sha256, undefined);
  assert.match(comparison.structure_notes, /without source-fixture hash comparison/);
});
