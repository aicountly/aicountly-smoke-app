import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compareArtifacts } from './compareArtifacts.js';

test('compareArtifacts passes identical CSV headers, rows, and hash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-compare-'));
  const source = path.join(dir, 'source.csv');
  const result = path.join(dir, 'result.csv');
  fs.writeFileSync(source, 'id,name\n1,Smoke\n');
  fs.copyFileSync(source, result);
  const comparison = compareArtifacts(source, result);
  assert.equal(comparison.status, 'pass');
  assert.equal(comparison.structure_ok, true);
  assert.equal(comparison.source_sha256, comparison.result_sha256);
});

test('compareArtifacts fails malformed PDF result', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-pdf-'));
  const source = path.join(dir, 'source.pdf');
  const result = path.join(dir, 'result.pdf');
  fs.writeFileSync(source, '%PDF-1.4\n%%EOF');
  fs.writeFileSync(result, 'not a pdf');
  const comparison = compareArtifacts(source, result);
  assert.equal(comparison.status, 'fail');
  assert.equal(comparison.structure_ok, false);
  assert.notEqual(comparison.source_sha256, comparison.result_sha256);
});
