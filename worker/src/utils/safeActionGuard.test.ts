import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateFileAction } from './safeActionGuard.js';

test('file gate always blocks production uploads even with every opt-in', () => {
  const decision = evaluateFileAction('upload_file', {
    environment: 'production_readonly',
    allowSafeDemo: true,
    destructiveAllowed: true,
    allowedActions: ['upload_file'],
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? '', /production/);
});

test('file gate requires explicit allowed action and all mutation gates', () => {
  assert.equal(evaluateFileAction('upload_file', {
    environment: 'sandbox',
    allowSafeDemo: true,
    destructiveAllowed: true,
    allowedActions: [],
  }).allowed, false);
  assert.equal(evaluateFileAction('upload_file', {
    environment: 'sandbox',
    allowSafeDemo: true,
    destructiveAllowed: true,
    allowedActions: ['upload_file'],
  }).allowed, true);
});

test('file gate allows non-production exports with explicit action', () => {
  assert.equal(evaluateFileAction('export_file', {
    environment: 'gh_staging',
    allowSafeDemo: false,
    destructiveAllowed: false,
    allowedActions: ['export_file'],
  }).allowed, true);
});

test('comparison gate requires explicit compare_file and remains blocked in production', () => {
  assert.equal(evaluateFileAction('compare_file', {
    environment: 'gh_staging',
    allowSafeDemo: false,
    destructiveAllowed: false,
    allowedActions: ['export_file'],
  }).allowed, false);
  const production = evaluateFileAction('compare_file', {
    environment: 'production_readonly',
    allowSafeDemo: true,
    destructiveAllowed: true,
    allowedActions: ['compare_file'],
  });
  assert.equal(production.allowed, false);
  assert.match(production.reason ?? '', /production/);
});
