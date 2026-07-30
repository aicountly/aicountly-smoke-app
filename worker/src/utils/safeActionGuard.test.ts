import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateClick, evaluateFileAction } from './safeActionGuard.js';

const writeCtx = {
  environment: 'production_full_access',
  allowSafeDemo: true,
  destructiveAllowed: true,
  allowedActions: ['click_menu', 'fill_form', 'submit_form', 'create_record', 'upload_file'],
};

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

test('production_full_access opts out of the observer-only file block', () => {
  assert.equal(evaluateFileAction('upload_file', {
    environment: 'production_full_access',
    allowSafeDemo: true,
    destructiveAllowed: true,
    allowedActions: ['upload_file'],
  }).allowed, true);
  assert.equal(evaluateFileAction('export_file', {
    environment: 'production_full_access',
    allowSafeDemo: false,
    destructiveAllowed: false,
    allowedActions: ['export_file'],
  }).allowed, true);
});

test('production_full_access still honours the per-session and profile opt-ins', () => {
  const noSession = evaluateFileAction('upload_file', {
    environment: 'production_full_access',
    allowSafeDemo: true,
    destructiveAllowed: false,
    allowedActions: ['upload_file'],
  });
  assert.equal(noSession.allowed, false);
  assert.match(noSession.reason ?? '', /destructive_allowed/);

  const noSafeDemo = evaluateFileAction('upload_file', {
    environment: 'production_full_access',
    allowSafeDemo: false,
    destructiveAllowed: true,
    allowedActions: ['upload_file'],
  });
  assert.equal(noSafeDemo.allowed, false);
  assert.match(noSafeDemo.reason ?? '', /allow_safe_demo/);
});

test('constructive labels are clickable on full-access with opt-ins but never on observer tiers', () => {
  assert.equal(evaluateClick('Save Invoice', writeCtx, 'submit_form').allowed, true);

  for (const environment of ['production_readonly', 'production_restricted']) {
    const decision = evaluateClick('Save Invoice', {
      environment,
      allowSafeDemo: true,
      destructiveAllowed: true,
      allowedActions: ['submit_form'],
    }, 'submit_form');
    assert.equal(decision.allowed, false, `${environment} must block constructive labels`);
    assert.equal(decision.matchedToken, 'save');
  }
});

test('irreversible labels are permanently denied even on production_full_access', () => {
  for (const label of ['Delete Employee', 'Approve Leave', 'Pay Salary', 'Void Payment', 'Sign Out']) {
    const decision = evaluateClick(label, writeCtx, 'click_menu');
    assert.equal(decision.allowed, false, `${label} must stay denied`);
    assert.match(decision.reason ?? '', /irreversible/);
  }
});

test('production_full_access without the session opt-in still refuses constructive labels', () => {
  const decision = evaluateClick('Save Employee', {
    environment: 'production_full_access',
    allowSafeDemo: true,
    destructiveAllowed: false,
    allowedActions: ['submit_form'],
  }, 'submit_form');
  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? '', /destructive_allowed=false/);
});

test('create_record umbrella permits fill_form and submit_form', () => {
  assert.equal(evaluateClick('First name', {
    environment: 'sandbox',
    allowSafeDemo: true,
    destructiveAllowed: true,
    allowedActions: ['create_record'],
  }, 'fill_form').allowed, true);
  assert.equal(evaluateClick('Save', {
    environment: 'sandbox',
    allowSafeDemo: true,
    destructiveAllowed: true,
    allowedActions: ['create_record'],
  }, 'submit_form').allowed, true);
});
