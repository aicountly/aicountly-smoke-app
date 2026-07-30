import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_REPO_RULES,
  loadRepoRules,
  parseRepoRules,
  resolveOwnership,
  resolveRepoForUrl,
} from './repoAttribution.js';

const defaults = DEFAULT_REPO_RULES;

test('the /api/manage carve-out wins over the rest of the same host', () => {
  assert.equal(
    resolveRepoForUrl('https://hrms.aicountly.com/api/manage/user/logo', defaults),
    'manage-aicountly',
  );
  assert.equal(
    resolveRepoForUrl('https://hrms.aicountly.com/api/manage', defaults),
    'manage-aicountly',
  );
  assert.equal(
    resolveRepoForUrl('https://hrms.aicountly.com/dashboard', defaults),
    'hrms-react-app',
  );
});

test('path prefixes match whole segments only', () => {
  assert.equal(
    resolveRepoForUrl('https://hrms.aicountly.com/api/managed-x', defaults),
    'hrms-react-app',
  );
  assert.equal(
    resolveRepoForUrl('https://hrms.aicountly.com/api/manageable', defaults),
    'hrms-react-app',
  );
});

test('verified hosts resolve to their owning repository', () => {
  assert.equal(resolveRepoForUrl('https://my.aicountly.com/', defaults), 'my-aicountly-com');
  assert.equal(resolveRepoForUrl('https://manage.aicountly.com/companies', defaults), 'manage-aicountly');
  assert.equal(resolveRepoForUrl('https://manage.gh.aicountly.com/companies', defaults), 'manage-aicountly');
  assert.equal(resolveRepoForUrl('https://gh-hrms.aicountly.com/leave', defaults), 'hrms-react-app');
  assert.equal(resolveRepoForUrl('https://hrms.gh.aicountly.com/api/manage/user', defaults), 'manage-aicountly');
});

test('unknown hosts and relative paths never guess a repository', () => {
  assert.equal(resolveRepoForUrl('https://product.test/attendance', defaults), null);
  assert.equal(resolveRepoForUrl('https://books.aicountly.com/invoices', defaults), null);
  assert.equal(resolveRepoForUrl('/attendance', defaults), null);
  assert.equal(resolveRepoForUrl('', defaults), null);
  assert.equal(resolveRepoForUrl('not a url', defaults), null);
});

test('ownership groups by repo and collects unresolved URLs', () => {
  const ownership = resolveOwnership([
    'https://my.aicountly.com/',
    'https://hrms.aicountly.com/dashboard',
    'https://hrms.aicountly.com/dashboard',
    'https://hrms.aicountly.com/leave',
    'https://hrms.aicountly.com/api/manage/user/logo',
    'https://product.test/attendance',
  ], defaults);

  assert.deepEqual(ownership.groups.map((group) => group.repo), [
    'hrms-react-app',
    'manage-aicountly',
    'my-aicountly-com',
  ]);
  assert.deepEqual(ownership.groups[0].urls, [
    'https://hrms.aicountly.com/dashboard',
    'https://hrms.aicountly.com/leave',
  ]);
  assert.deepEqual(ownership.unresolved, ['https://product.test/attendance']);
});

test('compact rules parse hosts, paths, comments and separators', () => {
  const rules = parseRepoRules([
    '# ownership overrides',
    'https://Books.AICOUNTLY.com:8443/reports=books-app',
    '',
    'docs.aicountly.com=docs-site;calendar.aicountly.com=calendar-app',
  ].join('\n'));

  assert.deepEqual(rules, [
    { host: 'books.aicountly.com', pathPrefix: '/reports', repo: 'books-app' },
    { host: 'docs.aicountly.com', repo: 'docs-site' },
    { host: 'calendar.aicountly.com', repo: 'calendar-app' },
  ]);
  assert.equal(resolveRepoForUrl('https://books.aicountly.com/reports/aged', rules), 'books-app');
  assert.equal(resolveRepoForUrl('https://books.aicountly.com/settings', rules), null);
});

test('JSON rules parse and bad input degrades to no rules', () => {
  const rules = parseRepoRules(JSON.stringify([
    { host: 'HRMS.aicountly.com', pathPrefix: '/api/manage', repo: 'manage-aicountly' },
    { host: 'hrms.aicountly.com', repo: 'hrms-react-app' },
  ]));

  assert.deepEqual(rules, [
    { host: 'hrms.aicountly.com', pathPrefix: '/api/manage', repo: 'manage-aicountly' },
    { host: 'hrms.aicountly.com', repo: 'hrms-react-app' },
  ]);
  assert.deepEqual(parseRepoRules('[not json'), []);
  assert.deepEqual(parseRepoRules(undefined), []);
  assert.deepEqual(parseRepoRules(''), []);
});

test('wildcard hosts match but never beat an exact host', () => {
  const rules = parseRepoRules('*.aicountly.com=aicountly-monorepo,*=fallback-repo');

  assert.equal(resolveRepoForUrl('https://books.aicountly.com/x', rules), 'aicountly-monorepo');
  assert.equal(resolveRepoForUrl('https://anything.test/x', rules), 'fallback-repo');
  assert.equal(
    resolveRepoForUrl('https://my.aicountly.com/', [...rules, ...defaults]),
    'my-aicountly-com',
  );
});

test('operator rules override bundled defaults for the same host', () => {
  const inline = loadRepoRules({ SMOKE_REPO_MAP: 'my.aicountly.com=my-aicountly-fork' } as NodeJS.ProcessEnv);
  assert.equal(resolveRepoForUrl('https://my.aicountly.com/', inline), 'my-aicountly-fork');
  assert.equal(resolveRepoForUrl('https://hrms.aicountly.com/dashboard', inline), 'hrms-react-app');

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-map-')), 'map.txt');
  fs.writeFileSync(file, '# fork under test\nmanage.aicountly.com=manage-fork\n');
  try {
    const fromFile = loadRepoRules({ SMOKE_REPO_MAP_FILE: file } as NodeJS.ProcessEnv);
    assert.equal(resolveRepoForUrl('https://manage.aicountly.com/companies', fromFile), 'manage-fork');
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }

  const missingFile = loadRepoRules({ SMOKE_REPO_MAP_FILE: '/tmp/does-not-exist-smoke-map.txt' } as NodeJS.ProcessEnv);
  assert.deepEqual(missingFile, [...defaults]);
  assert.deepEqual(loadRepoRules({} as NodeJS.ProcessEnv), [...defaults]);
});
