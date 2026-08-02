import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyNetworkEvents,
  isAnalyticsNoise,
  isExpectedCreateConflict,
  isHardNetworkFailure,
  isSoftAssetFailure,
} from './networkNoise.js';

test('analytics URLs are noise', () => {
  assert.equal(isAnalyticsNoise('https://www.google-analytics.com/g/collect?v=2'), true);
  assert.equal(isAnalyticsNoise('https://www.googletagmanager.com/gtm.js'), true);
  assert.equal(isAnalyticsNoise('https://product.test/api/employees'), false);
});

test('logo/image/font URLs are soft assets', () => {
  assert.equal(isSoftAssetFailure({ url: 'https://product.test/logo.png', content_type: '' }), true);
  assert.equal(isSoftAssetFailure({ url: 'https://product.test/favicon.ico' }), true);
  assert.equal(isSoftAssetFailure({ url: 'https://cdn.test/x', content_type: 'image/png' }), true);
  assert.equal(isSoftAssetFailure({ url: 'https://product.test/api/employees' }), false);
});

test('POST/PUT 409 is an expected create conflict', () => {
  assert.equal(isExpectedCreateConflict({ method: 'POST', status: 409 }), true);
  assert.equal(isExpectedCreateConflict({ method: 'PUT', status: 409 }), true);
  assert.equal(isExpectedCreateConflict({ method: 'GET', status: 409 }), false);
  assert.equal(isExpectedCreateConflict({ method: 'POST', status: 500 }), false);
});

test('classifyNetworkEvents splits hard / soft / conflicts / ignored', () => {
  const classified = classifyNetworkEvents([
    { url: 'https://www.google-analytics.com/g/collect', method: 'GET', status: 0, ok: false },
    { url: 'https://product.test/logo.png', method: 'GET', status: 404, ok: false },
    { url: 'https://product.test/api/employees', method: 'POST', status: 409, ok: false },
    { url: 'https://product.test/api/employees', method: 'GET', status: 500, ok: false },
  ]);
  assert.equal(classified.ignored.length, 1);
  assert.equal(classified.soft.length, 1);
  assert.equal(classified.conflicts.length, 1);
  assert.equal(classified.hard.length, 1);
  assert.equal(isHardNetworkFailure(classified.hard[0]!), true);
});
