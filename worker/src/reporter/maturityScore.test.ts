import assert from 'node:assert/strict';
import test from 'node:test';
import { maturityLabel, scoreMaturity, scoreUx, type ScorableGap, type SeveritySummary } from './maturityScore.js';

const CLEAN: SeveritySummary = { critical: 0, high: 0, medium: 0, low: 0, suggestion: 0 };

test('a session that observed nothing is not scored rather than scored zero', () => {
  assert.equal(scoreMaturity(CLEAN, [], 0), null);
  assert.equal(maturityLabel(null), 'Not scored (no screens observed)');
});

test('a clean session scores 100 and reports it', () => {
  assert.equal(scoreMaturity(CLEAN, [], 12), 100);
  assert.equal(maturityLabel(100), '100/100');
});

test('maturity is the UX score minus what the product is missing', () => {
  const severity: SeveritySummary = { critical: 0, high: 1, medium: 0, low: 0, suggestion: 0 };
  const gaps: ScorableGap[] = [{ observed: false, severity: 'high', mode: 'implement' }];

  assert.equal(scoreUx(severity, 10), 94);
  assert.equal(scoreMaturity(severity, gaps, 10), 88);
});

test('features confirmed present cost nothing', () => {
  const gaps: ScorableGap[] = [
    { observed: true, severity: 'critical', mode: 'implement' },
    { observed: true, severity: 'critical', mode: 'implement' },
  ];
  assert.equal(scoreMaturity(CLEAN, gaps, 10), 100);
});

test('an unconfirmed gap costs a quarter of a confirmed one', () => {
  const confirmed = scoreMaturity(CLEAN, [{ severity: 'medium', mode: 'implement' }], 10);
  const unconfirmed = scoreMaturity(CLEAN, [{ severity: 'medium', mode: 'validate_first' }], 10);

  assert.equal(confirmed, 97);
  assert.equal(unconfirmed, 99.25);
});

test('the gap penalty scales with the run, so a longer run is not punished for looking further', () => {
  const gaps = (count: number): ScorableGap[] =>
    Array.from({ length: count }, () => ({ severity: 'medium', mode: 'validate_first' }));

  assert.equal(scoreMaturity(CLEAN, gaps(4), 4), scoreMaturity(CLEAN, gaps(40), 40));
});

test('missing features alone cannot sink a clean product below the gap cap', () => {
  const gaps: ScorableGap[] = Array.from({ length: 200 }, () => ({ severity: 'critical', mode: 'implement' }));
  assert.equal(scoreMaturity(CLEAN, gaps, 5), 60);
});

test('an unknown gap severity is treated as medium', () => {
  const known = scoreMaturity(CLEAN, [{ severity: 'medium', mode: 'implement' }], 10);
  assert.equal(scoreMaturity(CLEAN, [{ severity: '', mode: 'implement' }], 10), known);
});
