import assert from 'node:assert/strict';
import test from 'node:test';
import { meaningfulScopeTokens, scopeRelevantUrlPart, scopeTokensMatchUrl, tokensMatch } from './scopeMatch.js';

test('singular menu labels match plural product routes', () => {
  // The reported miss: an "Engagement Setup" session spent its whole run on the
  // engagement wizard and was reported as having reached nothing in scope.
  const scope = meaningfulScopeTokens('Engagement > Setup Engagement Setup');

  assert.equal(scopeTokensMatchUrl(scope, 'https://auditor.aicountly.com/engagements/new'), true);
  assert.equal(scopeTokensMatchUrl(scope, 'https://auditor.aicountly.com/engagements'), true);
});

test('the host contributes no scope signal', () => {
  // Every screen in the product shares a host, so matching it would mark everything
  // in scope — "audit" must not match "auditor.aicountly.com".
  const scope = meaningfulScopeTokens('Audit Registry');

  assert.equal(scopeTokensMatchUrl(scope, 'https://auditor.aicountly.com/settings/profile'), false);
  assert.equal(scopeTokensMatchUrl(scope, 'https://auditor.aicountly.com/audit-registry'), true);
});

test('an unrelated screen is still out of scope', () => {
  const scope = meaningfulScopeTokens('Engagement > Setup');

  assert.equal(scopeTokensMatchUrl(scope, 'https://auditor.aicountly.com/reports/hub'), false);
  assert.equal(scopeTokensMatchUrl(scope, 'https://auditor.aicountly.com/company'), false);
});

test('hash routes are matched as well as paths', () => {
  const scope = meaningfulScopeTokens('Company Sharing');

  assert.equal(scopeTokensMatchUrl(scope, 'https://manage.aicountly.com/#/company/60/share'), true);
});

test('short tokens do not match on a prefix', () => {
  assert.equal(tokensMatch('new', 'news'), false);
  assert.equal(tokensMatch('add', 'address'), false);
  assert.equal(tokensMatch('report', 'reports'), true);
  assert.equal(tokensMatch('engagement', 'engagements'), true);
  // Forgiving the suffix is not the same as matching a shared prefix in the middle.
  assert.equal(tokensMatch('ledger', 'general'), false);
});

test('a relative or malformed url still yields its path', () => {
  assert.equal(scopeRelevantUrlPart('/engagements/new').trim(), '/engagements/new');
  assert.equal(scopeRelevantUrlPart('').trim(), '');
  assert.match(scopeRelevantUrlPart('https://host.example/engagements?x=1#y'), /\/engagements/);
});
