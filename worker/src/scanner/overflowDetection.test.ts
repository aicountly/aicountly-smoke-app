import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HAS_SCROLLABLE_ANCESTOR_JS,
  hasScrollableAncestor,
  isScrollContainer,
  isViewportOverflow,
  type ScrollContainerProbe,
} from './overflowDetection.js';

function probe(partial: Partial<ScrollContainerProbe>): ScrollContainerProbe {
  return {
    overflowX: 'visible',
    overflowY: 'visible',
    clientWidth: 800,
    clientHeight: 600,
    scrollWidth: 800,
    scrollHeight: 600,
    ...partial,
  };
}

test('isScrollContainer: overflow-x auto/scroll with constrained width counts', () => {
  assert.equal(isScrollContainer(probe({ overflowX: 'auto', clientWidth: 800, scrollWidth: 1200 }), 'x'), true);
  assert.equal(isScrollContainer(probe({ overflowX: 'scroll', clientWidth: 800, scrollWidth: 800 }), 'x'), true);
  assert.equal(isScrollContainer(probe({ overflowX: 'visible', clientWidth: 800, scrollWidth: 1200 }), 'x'), false);
  assert.equal(isScrollContainer(probe({ overflowX: 'hidden', clientWidth: 800, scrollWidth: 1200 }), 'x'), false);
});

test('isScrollContainer: overflow-y auto/scroll with constrained height counts', () => {
  assert.equal(isScrollContainer(probe({ overflowY: 'auto', clientHeight: 400, scrollHeight: 900 }), 'y'), true);
  assert.equal(isScrollContainer(probe({ overflowY: 'visible', clientHeight: 400, scrollHeight: 900 }), 'y'), false);
});

test('hasScrollableAncestor: any matching ancestor suppresses overflow', () => {
  assert.equal(hasScrollableAncestor([
    probe({ overflowX: 'visible' }),
    probe({ overflowX: 'auto', clientWidth: 900, scrollWidth: 1400 }),
  ], 'x'), true);
  assert.equal(hasScrollableAncestor([
    probe({ overflowX: 'visible' }),
    probe({ overflowX: 'hidden', clientWidth: 900, scrollWidth: 1400 }),
  ], 'x'), false);
});

test('isViewportOverflow: scroll-wrapped wide table is not overflowing', () => {
  // Attendance/ledger/GST-style register: table wider than viewport, but inside overflow-x-auto.
  assert.equal(isViewportOverflow(1400, 1024, [
    probe({ overflowX: 'auto', clientWidth: 1000, scrollWidth: 1400 }),
  ], 'x'), false);
});

test('isViewportOverflow: wide table with no scroll ancestor is overflowing', () => {
  assert.equal(isViewportOverflow(1400, 1024, [
    probe({ overflowX: 'visible', clientWidth: 1400, scrollWidth: 1400 }),
  ], 'x'), true);
});

test('isViewportOverflow: table within viewport is never overflowing', () => {
  assert.equal(isViewportOverflow(900, 1024, [], 'x'), false);
});

test('isViewportOverflow: modal taller than viewport without overflow-y scroll is overflowing', () => {
  assert.equal(isViewportOverflow(1200, 800, [
    probe({ overflowY: 'visible' }),
  ], 'y'), true);
  assert.equal(isViewportOverflow(1200, 800, [
    probe({ overflowY: 'auto', clientHeight: 700, scrollHeight: 1200 }),
  ], 'y'), false);
});

test('HAS_SCROLLABLE_ANCESTOR_JS documents the evaluate-body contract', () => {
  assert.match(HAS_SCROLLABLE_ANCESTOR_JS, /overflow === 'auto' \|\| overflow === 'scroll'/);
  assert.match(HAS_SCROLLABLE_ANCESTOR_JS, /clientWidth/);
  assert.match(HAS_SCROLLABLE_ANCESTOR_JS, /clientHeight/);
});
