import type { Page } from 'playwright';

export type MarkDescriptor = {
  mark: number;
  tag: string;
  role: string;
  name: string;
  /**
   * Short, single-line accessible name (first line, collapsed whitespace, capped
   * ~60 chars). Used for safety-guard token matching so a long card blurb ("Daily
   * salary RECORDS Legacy: ... Approved rows ... added to Process p") does not
   * spuriously match a restricted token buried in its description. Optional so
   * older test fixtures that predate this field keep compiling.
   */
  guard_label?: string;
  type: string;
  value: string;
  checked: boolean | null;
  disabled: boolean;
  /** True when the control sits outside the viewport, so it carries no badge in the screenshot. */
  offscreen: boolean;
  /** Pixels above (negative) or below (positive) the viewport; 0 when on screen. */
  viewport_offset: number;
  bbox: { x: number; y: number; width: number; height: number };
};

/**
 * Off-viewport controls are described but not badged. A form's Save button is
 * usually below the fold, and an agent that only ever sees the viewport reads its
 * absence as proof the button does not exist. Playwright scrolls an element into
 * view before clicking, so an offscreen mark is still actionable.
 */
const OFFSCREEN_LIMIT = 80;

/**
 * Per-element identity key: tag + accessible name + a positional index among
 * elements sharing that tag/name. `existingKey` (the element's own
 * `data-smoke-key` attribute, or null/undefined the first time it is seen) wins
 * unconditionally, which is what makes the key — and therefore the mark number
 * derived from it — stable for the life of the page even though candidates are
 * re-picked from scratch on every call.
 *
 * Pure and DOM-independent on purpose: this is unit tested directly in
 * marks.test.ts, and its source is interpolated into the in-page script below
 * via `.toString()` so the browser runs the exact function under test rather
 * than a hand-copied "equivalent" of it.
 */
export function markKeyFor(
  existingKey: string | null | undefined,
  tag: string,
  name: string,
  seq: Map<string, number>,
): string {
  if (existingKey) return existingKey;
  const base = `${tag}|${name}`;
  const ordinal = seq.get(base) || 0;
  seq.set(base, ordinal + 1);
  return `${base}|${ordinal}`;
}

/**
 * Stable integer mark for a key, minted once per key and reused for the
 * registry's lifetime (the page-side `window.__smokeMarkRegistry`, since
 * `page.evaluate` reinjects this script fresh on every call — a Node-side Map
 * cannot see into the page between calls).
 */
export function markOrdinalFor(registry: { ordinals: Map<string, number>; next: number }, key: string): number {
  let mark = registry.ordinals.get(key);
  if (!mark) {
    mark = registry.next;
    registry.next += 1;
    registry.ordinals.set(key, mark);
  }
  return mark;
}

/**
 * Seeds the per-base position counter from `data-smoke-key` attributes already
 * present in the DOM, so a newly rendered sibling continues the sequence rather
 * than colliding with a key assigned on an earlier call.
 */
export function seedKeySequence(existingKeys: string[]): Map<string, number> {
  const seq = new Map<string, number>();
  for (const key of existingKeys) {
    const lastPipe = key.lastIndexOf('|');
    if (lastPipe < 0) continue;
    const base = key.slice(0, lastPipe);
    const ordinal = Number(key.slice(lastPipe + 1));
    if (Number.isFinite(ordinal)) {
      seq.set(base, Math.max(seq.get(base) || 0, ordinal + 1));
    }
  }
  return seq;
}

const MARK_SCRIPT = `(() => {
  document.querySelectorAll('[data-smoke-mark]').forEach((el) => el.removeAttribute('data-smoke-mark'));
  document.querySelectorAll('[data-smoke-mark-badge]').forEach((el) => el.remove());
  const selector = 'a[href],button,input,select,textarea,[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="checkbox"],[role="radio"],[role="switch"],[role="option"],[tabindex],[contenteditable],[onclick]';
  const controlTags = new Set(['input', 'select', 'textarea', 'button']);
  const elements = Array.from(document.querySelectorAll(selector));
  const offscreenLimit = ${OFFSCREEN_LIMIT};
  const text = (value) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, 160);
  const guardText = (value) => String(value || '').split('\\n')[0].replace(/\\s+/g, ' ').trim().slice(0, 60);
  const nameFor = (el) => {
    const labelled = el.id ? document.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null;
    const wrapping = el.closest('label');
    return text(el.getAttribute('aria-label'))
      || text(labelled && labelled.innerText)
      || text(wrapping && wrapping.innerText)
      || text(el.getAttribute('placeholder'))
      || text(el.getAttribute('title'))
      || text(el.innerText || el.textContent)
      || text(el.getAttribute('alt'))
      || text(el.value);
  };

  const markKeyFor = ${markKeyFor.toString()};
  const markOrdinalFor = ${markOrdinalFor.toString()};
  const seedKeySequence = ${seedKeySequence.toString()};

  // Mark numbers must mean the same control for the whole session, even though
  // this script is reinjected fresh on every page.evaluate call (candidates are
  // re-picked from current scroll position each time). A Node-side Map cannot see
  // into the page, so the ordinal registry lives on a page-side global instead.
  const registry = window.__smokeMarkRegistry
    || (window.__smokeMarkRegistry = { ordinals: new Map(), next: 1 });
  const existingKeys = Array.from(document.querySelectorAll('[data-smoke-key]'))
    .map((el) => el.getAttribute('data-smoke-key') || '');
  const keySeq = seedKeySequence(existingKeys);

  const candidates = [];
  for (let index = 0; index < elements.length; index += 1) {
    const el = elements[index];
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0
      || rect.width <= 0 || rect.height <= 0) continue;
    const above = rect.bottom <= 0;
    const below = rect.top >= innerHeight;
    const beside = rect.right <= 0 || rect.left >= innerWidth;
    let offset = 0;
    if (above) offset = Math.round(rect.bottom);
    else if (below) offset = Math.round(rect.top - innerHeight);
    else if (beside) offset = rect.right <= 0 ? Math.round(rect.right) : Math.round(rect.left - innerWidth);
    candidates.push({
      el, rect, index, offset,
      offscreen: above || below || beside,
      distance: Math.abs(offset),
      isControl: controlTags.has(el.tagName.toLowerCase())
    });
  }

  // Every on-screen control, plus the nearest offscreen ones. Form controls and
  // buttons win the cap over links, so a Save button below the fold survives a
  // page with a long navigation menu.
  const offscreenPick = new Set(candidates
    .filter((item) => item.offscreen)
    .sort((a, b) => (a.isControl === b.isControl ? a.distance - b.distance : (a.isControl ? -1 : 1)))
    .slice(0, offscreenLimit));
  const selected = candidates.filter((item) => !item.offscreen || offscreenPick.has(item));

  const descriptors = [];
  for (const item of selected) {
    const el = item.el;
    const rect = item.rect;
    const name = nameFor(el);
    // Set once, never overwritten: an element that already carries a
    // data-smoke-key keeps it for the life of the page regardless of how the
    // candidate set reshuffles around it.
    const key = markKeyFor(el.getAttribute('data-smoke-key'), el.tagName.toLowerCase(), name, keySeq);
    if (!el.hasAttribute('data-smoke-key')) el.setAttribute('data-smoke-key', key);
    const mark = markOrdinalFor(registry, key);
    el.setAttribute('data-smoke-mark', String(mark));
    if (!item.offscreen) {
      const badge = document.createElement('div');
      badge.setAttribute('data-smoke-mark-badge', String(mark));
      badge.textContent = String(mark);
      Object.assign(badge.style, {
        position: 'fixed', left: Math.max(0, rect.left - 6) + 'px', top: Math.max(0, rect.top - 8) + 'px',
        zIndex: '2147483647', pointerEvents: 'none', background: '#ef4444', color: '#fff',
        border: '2px solid #fff', borderRadius: '999px', padding: '1px 5px',
        font: 'bold 12px/16px system-ui', boxShadow: '0 1px 4px #0008'
      });
      document.documentElement.appendChild(badge);
    }
    descriptors.push({
      mark, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '',
      name, guard_label: guardText(name), type: el.getAttribute('type') || '', value: text(el.value),
      checked: typeof el.checked === 'boolean' ? el.checked : null,
      disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
      offscreen: item.offscreen, viewport_offset: item.offset,
      bbox: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
    });
  }
  return descriptors;
})()`;

export async function markInteractive(page: Page): Promise<MarkDescriptor[]> {
  return page.evaluate<MarkDescriptor[]>(MARK_SCRIPT);
}

export async function unmark(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    document.querySelectorAll('[data-smoke-mark]').forEach((el) => el.removeAttribute('data-smoke-mark'));
    document.querySelectorAll('[data-smoke-mark-badge]').forEach((el) => el.remove());
  })()`).catch(() => {});
}

/** Controls the model can act on but cannot see in the screenshot. */
export function countOffscreen(marks: MarkDescriptor[]): number {
  return marks.filter((mark) => mark.offscreen).length;
}
