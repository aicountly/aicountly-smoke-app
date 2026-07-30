import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSessionCoverage } from './sessionCoverage.js';

describe('evaluateSessionCoverage', () => {
  it('counts a session with in-scope screens as covered', () => {
    const verdict = evaluateSessionCoverage({
      scopeScreens: 4,
      menuPath: '/employees',
      workspaceSkipped: false,
      creates_verified: 1,
      loop_status: 'done',
    });
    assert.equal(verdict.status, 'covered');
    assert.match(verdict.reason, /4 screen/);
  });

  it('blocks a session that only ever saw login and landing', () => {
    const verdict = evaluateSessionCoverage({
      scopeScreens: 0,
      menuPath: null,
      workspaceSkipped: false,
      creates_verified: 0,
      loop_status: 'blocked',
    });
    assert.equal(verdict.status, 'blocked');
    assert.match(verdict.reason, /login and landing/);
  });

  it('names the scope it never reached', () => {
    const verdict = evaluateSessionCoverage({
      scopeScreens: 0,
      menuPath: '/employees',
      workspaceSkipped: false,
      creates_verified: 0,
      loop_status: 'blocked',
    });
    assert.equal(verdict.status, 'blocked');
    assert.match(verdict.reason, /"\/employees" was never reached/);
  });

  it('blames the missing workspace when that is what stopped it', () => {
    const verdict = evaluateSessionCoverage({
      scopeScreens: 0,
      menuPath: '/employees',
      workspaceSkipped: true,
      creates_verified: 0,
      loop_status: 'blocked',
    });
    assert.equal(verdict.status, 'blocked');
    assert.match(verdict.reason, /no company workspace/);
    assert.match(verdict.reason, /\/employees/);
  });

  it('still explains a skipped workspace when the session named no scope', () => {
    const verdict = evaluateSessionCoverage({
      scopeScreens: 0,
      menuPath: '  ',
      workspaceSkipped: true,
      creates_verified: 0,
      loop_status: 'blocked',
    });
    assert.equal(verdict.status, 'blocked');
    assert.match(verdict.reason, /no company-scoped screen/);
  });

  it('does not blame the workspace when screens were observed anyway', () => {
    const verdict = evaluateSessionCoverage({
      scopeScreens: 2,
      menuPath: '/employees',
      workspaceSkipped: true,
      creates_verified: 1,
      loop_status: 'done',
    });
    assert.equal(verdict.status, 'covered');
  });

  it('reports partial when in-scope screens were seen but the budget ran out with no verified create', () => {
    const verdict = evaluateSessionCoverage({
      scopeScreens: 5,
      menuPath: '/payroll',
      workspaceSkipped: false,
      creates_verified: 0,
      loop_status: 'budget',
    });
    assert.equal(verdict.status, 'partial');
    assert.match(verdict.reason, /5 screen/);
    assert.match(verdict.reason, /exhausted its step budget/);
  });

  it('does not report partial when a create was verified before the budget ran out', () => {
    const verdict = evaluateSessionCoverage({
      scopeScreens: 5,
      menuPath: '/payroll',
      workspaceSkipped: false,
      creates_verified: 1,
      loop_status: 'budget',
    });
    assert.equal(verdict.status, 'covered');
  });

  it('does not report partial when the loop finished cleanly even on budget-adjacent counts', () => {
    const verdict = evaluateSessionCoverage({
      scopeScreens: 5,
      menuPath: '/payroll',
      workspaceSkipped: false,
      creates_verified: 0,
      loop_status: 'done',
    });
    assert.equal(verdict.status, 'covered');
  });
});
