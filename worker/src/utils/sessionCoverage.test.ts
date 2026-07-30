import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSessionCoverage } from './sessionCoverage.js';

describe('evaluateSessionCoverage', () => {
  it('counts a session with in-scope screens as covered', () => {
    const verdict = evaluateSessionCoverage({
      scopeScreens: 4,
      menuPath: '/employees',
      workspaceSkipped: false,
    });
    assert.equal(verdict.status, 'covered');
    assert.match(verdict.reason, /4 screen/);
  });

  it('blocks a session that only ever saw login and landing', () => {
    const verdict = evaluateSessionCoverage({
      scopeScreens: 0,
      menuPath: null,
      workspaceSkipped: false,
    });
    assert.equal(verdict.status, 'blocked');
    assert.match(verdict.reason, /login and landing/);
  });

  it('names the scope it never reached', () => {
    const verdict = evaluateSessionCoverage({
      scopeScreens: 0,
      menuPath: '/employees',
      workspaceSkipped: false,
    });
    assert.equal(verdict.status, 'blocked');
    assert.match(verdict.reason, /"\/employees" was never reached/);
  });

  it('blames the missing workspace when that is what stopped it', () => {
    const verdict = evaluateSessionCoverage({
      scopeScreens: 0,
      menuPath: '/employees',
      workspaceSkipped: true,
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
    });
    assert.equal(verdict.status, 'blocked');
    assert.match(verdict.reason, /no company-scoped screen/);
  });

  it('does not blame the workspace when screens were observed anyway', () => {
    const verdict = evaluateSessionCoverage({
      scopeScreens: 2,
      menuPath: '/employees',
      workspaceSkipped: true,
    });
    assert.equal(verdict.status, 'covered');
  });
});
