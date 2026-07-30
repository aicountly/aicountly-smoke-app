import assert from 'node:assert/strict';
import test from 'node:test';
import { countOffscreen, markKeyFor, markOrdinalFor, seedKeySequence } from './marks.js';
import type { MarkDescriptor } from './marks.js';

test('markKeyFor assigns distinct positional keys to same tag/name elements', () => {
  const seq = new Map<string, number>();
  const first = markKeyFor(null, 'button', 'Save', seq);
  const second = markKeyFor(null, 'button', 'Save', seq);
  const third = markKeyFor(undefined, 'button', 'Save', seq);
  assert.equal(first, 'button|Save|0');
  assert.equal(second, 'button|Save|1');
  assert.equal(third, 'button|Save|2');
});

test('markKeyFor never overwrites an existing key', () => {
  const seq = new Map<string, number>();
  const key = markKeyFor('button|Save|7', 'button', 'Save', seq);
  assert.equal(key, 'button|Save|7');
  // An element with no key yet still gets the next free ordinal, unaffected by
  // the borrowed ordinal above (seq was never told about "7").
  const next = markKeyFor(null, 'button', 'Save', seq);
  assert.equal(next, 'button|Save|0');
});

test('markKeyFor keeps distinct fields (different tag or name) from colliding', () => {
  const seq = new Map<string, number>();
  const input = markKeyFor(null, 'input', 'Email', seq);
  const select = markKeyFor(null, 'select', 'Email', seq);
  const otherName = markKeyFor(null, 'input', 'Phone', seq);
  assert.equal(input, 'input|Email|0');
  assert.equal(select, 'select|Email|0');
  assert.equal(otherName, 'input|Phone|0');
});

test('seedKeySequence continues numbering after keys already present in the DOM', () => {
  const seq = seedKeySequence(['button|Save|0', 'button|Save|1', 'input|Email|0']);
  assert.equal(markKeyFor(null, 'button', 'Save', seq), 'button|Save|2');
  assert.equal(markKeyFor(null, 'input', 'Email', seq), 'input|Email|1');
  // A base never seen before still starts at 0.
  assert.equal(markKeyFor(null, 'select', 'Department', seq), 'select|Department|0');
});

test('seedKeySequence ignores malformed keys instead of throwing', () => {
  const seq = seedKeySequence(['no-pipe-here', 'button|Save|not-a-number', '']);
  assert.equal(markKeyFor(null, 'button', 'Save', seq), 'button|Save|0');
});

test('markOrdinalFor mints one integer per key and reuses it across calls', () => {
  const registry = { ordinals: new Map<string, number>(), next: 1 };
  const first = markOrdinalFor(registry, 'button|Save|0');
  const second = markOrdinalFor(registry, 'input|Email|0');
  const firstAgain = markOrdinalFor(registry, 'button|Save|0');
  assert.equal(first, 1);
  assert.equal(second, 2);
  // Same key, called again later (as if the candidate set reshuffled and this
  // element was re-picked): the same integer mark, not a new one.
  assert.equal(firstAgain, first);
});

test('markOrdinalFor mark numbers stay stable even when candidates are re-picked out of order', () => {
  const registry = { ordinals: new Map<string, number>(), next: 1 };
  // First call sees three elements in document order.
  const a = markOrdinalFor(registry, 'a|Home|0');
  const b = markOrdinalFor(registry, 'button|Save|0');
  const c = markOrdinalFor(registry, 'a|Settings|0');
  // A later call re-picks candidates after a scroll, offering them in a
  // different order (e.g. an offscreen item now sorted first) — the same keys
  // must still resolve to the same integers.
  assert.equal(markOrdinalFor(registry, 'a|Settings|0'), c);
  assert.equal(markOrdinalFor(registry, 'a|Home|0'), a);
  assert.equal(markOrdinalFor(registry, 'button|Save|0'), b);
});

function mark(overrides: Partial<MarkDescriptor> = {}): MarkDescriptor {
  return {
    mark: 1,
    tag: 'input',
    role: '',
    name: 'Field',
    guard_label: 'Field',
    type: 'text',
    value: '',
    checked: null,
    disabled: false,
    offscreen: false,
    viewport_offset: 0,
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    ...overrides,
  };
}

test('countOffscreen counts only marks flagged offscreen', () => {
  const marks = [mark({ mark: 1, offscreen: false }), mark({ mark: 2, offscreen: true }), mark({ mark: 3, offscreen: true })];
  assert.equal(countOffscreen(marks), 2);
});
