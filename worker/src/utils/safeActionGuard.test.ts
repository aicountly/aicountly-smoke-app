import assert from 'node:assert/strict';
import test from 'node:test';
import { isUnsafeToFill } from '../forms/fieldSynthesis.js';
import {
  evaluateClick,
  evaluateFileAction,
  isConstructiveLabel,
  isDismissalLabel,
  isRestrictedLabel,
  isSessionEndingLabel,
} from './safeActionGuard.js';

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

test('restricted labels are clickable on full-access with opt-ins but never on observer tiers', () => {
  assert.equal(evaluateClick('Save Invoice', writeCtx, 'submit_form').allowed, true);
  assert.equal(evaluateClick('Delete Employee', writeCtx, 'click_menu').allowed, true);
  assert.equal(evaluateClick('Approve Leave', writeCtx, 'click_menu').allowed, true);
  assert.equal(evaluateClick('Pay Salary', writeCtx, 'click_menu').allowed, true);
  assert.equal(evaluateClick('Accounting / Journal', writeCtx, 'click_menu').allowed, true);
  assert.equal(evaluateClick('Banking & Reconcile', writeCtx, 'click_menu').allowed, true);

  for (const environment of ['production_readonly', 'production_restricted']) {
    const decision = evaluateClick('Save Invoice', {
      environment,
      allowSafeDemo: true,
      destructiveAllowed: true,
      allowedActions: ['submit_form'],
    }, 'submit_form');
    assert.equal(decision.allowed, false, `${environment} must block restricted labels`);
    assert.equal(decision.matchedToken, 'save');
  }
});

test('session-ending controls are denied on every tier including full-access', () => {
  for (const label of ['Sign Out', 'Log out', 'Logout', 'sign-out']) {
    assert.equal(isSessionEndingLabel(label), true, label);
    const decision = evaluateClick(label, writeCtx, 'click_menu');
    assert.equal(decision.allowed, false, `${label} must stay denied`);
    assert.match(decision.reason ?? '', /session-ending/);
  }
});

test('exact-match dismissal controls are allowed on every tier', () => {
  for (const label of ['Cancel', 'Close', 'Dismiss', 'Back', 'No', 'Not now']) {
    assert.equal(isDismissalLabel(label), true, label);
    assert.equal(evaluateClick(label, {
      environment: 'production_readonly',
      allowSafeDemo: false,
      destructiveAllowed: false,
      allowedActions: ['click_menu'],
    }, 'click_menu').allowed, true, `${label} must dismiss modals on observer tiers`);
  }
  // Compound labels still go through the restricted gate.
  assert.equal(isDismissalLabel('Cancel Invoice'), false);
  assert.equal(evaluateClick('Cancel Invoice', {
    environment: 'production_readonly',
    allowSafeDemo: true,
    destructiveAllowed: true,
    allowedActions: ['click_menu'],
  }, 'click_menu').allowed, false);
});

test('bare add/create are not restricted so observer sessions can open create forms', () => {
  assert.equal(isRestrictedLabel('Add Employee').matched, false);
  assert.equal(isRestrictedLabel('Create Company').matched, false);
  assert.equal(evaluateClick('Add Employee', {
    environment: 'production_restricted',
    allowSafeDemo: false,
    destructiveAllowed: false,
    allowedActions: ['click_menu'],
  }, 'click_menu').allowed, true);
  // Phrase forms stay restricted.
  assert.equal(isRestrictedLabel('Create Invoice').matched, true);
});

test('production_full_access without the session opt-in still refuses restricted labels', () => {
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

test('isConstructiveLabel still identifies save/submit for the submit_form action name', () => {
  assert.equal(isConstructiveLabel('Save Employee').matched, true);
  assert.equal(isConstructiveLabel('Submit').token, 'submit');
  assert.equal(isConstructiveLabel('Employees').matched, false);
});

test('Payment terms field is fillable; credential and GSTIN fields are not', () => {
  // Field labels containing "payment" must not block typing via isUnsafeToFill.
  assert.equal(isUnsafeToFill({
    tag: 'input',
    type: 'text',
    name: 'payment_terms',
    id: '',
    placeholder: '',
    ariaLabel: '',
    label: 'Payment terms (days)',
    required: false,
  }), false);

  assert.equal(isUnsafeToFill({
    tag: 'input',
    type: 'password',
    name: 'password',
    id: '',
    placeholder: '',
    ariaLabel: '',
    label: 'Password',
    required: true,
  }), true);

  assert.equal(isUnsafeToFill({
    tag: 'input',
    type: 'text',
    name: 'gstin',
    id: '',
    placeholder: '',
    ariaLabel: '',
    label: 'GSTIN',
    required: true,
  }), true);

  // Clicking a control labelled "Payment terms" on full-access is allowed (tier gate).
  assert.equal(evaluateClick('Payment terms (days)', writeCtx, 'click_menu').allowed, true);
});
