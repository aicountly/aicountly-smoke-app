import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isRenderableExtension, renderFixture } from './renderFixture.js';

test('recognises renderable extensions', () => {
  assert.equal(isRenderableExtension('a.csv'), true);
  assert.equal(isRenderableExtension('a.pdf'), true);
  assert.equal(isRenderableExtension('a.xlsx'), false);
});

test('renders CSV datasets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-fixture-'));
  const file = path.join(dir, 'employees.csv');
  const result = renderFixture(file, {
    columns: ['code', 'name'],
    rows: [['SMOKE-1', 'SMOKE-Ada'], ['SMOKE-2', 'SMOKE-Grace']],
  });
  assert.equal(result.ok, true);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^code,name\n/);
  assert.match(text, /SMOKE-Ada/);
});

test('renders a minimal PDF with the PDF magic header', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-fixture-'));
  const file = path.join(dir, 'note.pdf');
  const result = renderFixture(file, {
    columns: ['title'],
    rows: [['SMOKE-Doc']],
  });
  assert.equal(result.ok, true);
  const buf = fs.readFileSync(file);
  assert.equal(buf.subarray(0, 5).toString('utf8'), '%PDF-');
});
