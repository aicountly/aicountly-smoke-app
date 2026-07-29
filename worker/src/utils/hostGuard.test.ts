import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateHostGuard, normalizeHost, parseDomainList, wrongHostMessage } from './hostGuard.js';

test('an HRMS session sitting on Books fails the guard', () => {
  const result = evaluateHostGuard({
    currentUrl: 'https://books.aicountly.com/#/company/all',
    baseUrl: 'https://hrms.aicountly.com',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'mismatch');
  assert.equal(result.message, 'Wrong product host after login: expected hrms.aicountly.com, got books.aicountly.com');
});

test('the profile host passes regardless of path, port-less www or casing', () => {
  const result = evaluateHostGuard({
    currentUrl: 'https://WWW.hrms.aicountly.com/leave/requests?tab=1',
    baseUrl: 'https://hrms.aicountly.com/',
  });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'match');
  assert.equal(result.actualHost, 'hrms.aicountly.com');
});

test('still being on the auth host after login is a mismatch, not a pass', () => {
  for (const url of ['https://my.aicountly.com/dashboard', 'https://my.aicountly.com/login']) {
    const result = evaluateHostGuard({ currentUrl: url, baseUrl: 'https://hrms.aicountly.com' });
    assert.equal(result.ok, false, url);
  }
});

test('allowed_domains widens the guard, as JSON, array or wildcard', () => {
  const base = 'https://hrms.aicountly.com';
  assert.equal(evaluateHostGuard({
    currentUrl: 'https://ess.aicountly.com/home',
    baseUrl: base,
    allowedDomains: '["ess.aicountly.com"]',
  }).ok, true);
  assert.equal(evaluateHostGuard({
    currentUrl: 'https://ess.aicountly.com/home',
    baseUrl: base,
    allowedDomains: ['ess.aicountly.com'],
  }).reason, 'allowlisted');
  assert.equal(evaluateHostGuard({
    currentUrl: 'https://payroll.hrms.aicountly.com',
    baseUrl: base,
    allowedDomains: '*.hrms.aicountly.com',
  }).ok, true);
  assert.equal(evaluateHostGuard({
    currentUrl: 'https://books.aicountly.com',
    baseUrl: base,
    allowedDomains: ['ess.aicountly.com'],
  }).ok, false);
});

test('an unreadable current url fails and a missing base_url is not enforced', () => {
  assert.equal(evaluateHostGuard({ currentUrl: 'about:blank', baseUrl: 'https://hrms.aicountly.com' }).ok, false);
  const noBase = evaluateHostGuard({ currentUrl: 'https://books.aicountly.com', baseUrl: '' });
  assert.equal(noBase.ok, true);
  assert.equal(noBase.reason, 'no_base_url');
});

test('domain lists accept json, csv and empty values', () => {
  assert.deepEqual(parseDomainList('["a.com","b.com"]'), ['a.com', 'b.com']);
  assert.deepEqual(parseDomainList('a.com, b.com'), ['a.com', 'b.com']);
  assert.deepEqual(parseDomainList(null), []);
  assert.deepEqual(parseDomainList('[]'), []);
});

test('host normalisation tolerates bare domains', () => {
  assert.equal(normalizeHost('hrms.aicountly.com'), 'hrms.aicountly.com');
  assert.equal(normalizeHost(''), '');
  assert.equal(wrongHostMessage('a.com', ''), 'Wrong product host after login: expected a.com, got (unknown)');
});
