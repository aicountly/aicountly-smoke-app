import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { materializeFixture, scenariosForProduct } from './fixtureFactory.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('fixtureFactory materializes a run-scoped copy without changing source', () => {
  const reportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-fixture-'));
  const scenario = scenariosForProduct(repoRoot, 'contacts')[0];
  assert.ok(scenario);
  const sourcePath = path.join(repoRoot, 'samples', 'fixtures', scenario.fixture);
  const before = fs.readFileSync(sourcePath);
  const fixture = materializeFixture(repoRoot, reportsDir, scenario);
  assert.notEqual(fixture.runPath, sourcePath);
  assert.deepEqual(fs.readFileSync(fixture.runPath), before);
  assert.deepEqual(fs.readFileSync(sourcePath), before);
});

test('fixture manifest covers every SaaS product', () => {
  const reportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-all-fixtures-'));
  for (const product of ['contacts','books','docs','vault','hrms','auditor','fr','secretarial','calendar','chat','my-account','ourpeople','buddy']) {
    const scenarios = scenariosForProduct(repoRoot, product);
    assert.ok(scenarios.length > 0, `missing fixture scenario for ${product}`);
    for (const scenario of scenarios) {
      assert.ok(fs.existsSync(materializeFixture(repoRoot, reportsDir, scenario).runPath));
    }
  }
});
