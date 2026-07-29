import assert from 'node:assert/strict';
import test from 'node:test';
import { computeVisitBudget } from './visitBudget.js';

test('matched menus can exceed the planning estimate', () => {
  assert.deepEqual(
    computeVisitBudget({ expectedScreens: 4, matchedCount: 20, safetyMax: 40 }),
    { visitLimit: 20, estimated: 4, truncated: false },
  );
});

test('matched menus determine a limit below the planning estimate', () => {
  assert.deepEqual(
    computeVisitBudget({ expectedScreens: 12, matchedCount: 3, safetyMax: 40 }),
    { visitLimit: 3, estimated: 12, truncated: false },
  );
});

test('safety maximum truncates a large discovery result', () => {
  assert.deepEqual(
    computeVisitBudget({ expectedScreens: 4, matchedCount: 100, safetyMax: 40 }),
    { visitLimit: 40, estimated: 4, truncated: true },
  );
});
