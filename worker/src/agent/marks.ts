import type { Page } from 'playwright';

export type MarkDescriptor = {
  mark: number;
  tag: string;
  role: string;
  name: string;
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
const OFFSCREEN_LIMIT = 40;

const MARK_SCRIPT = `(() => {
  document.querySelectorAll('[data-smoke-mark]').forEach((el) => el.removeAttribute('data-smoke-mark'));
  document.querySelectorAll('[data-smoke-mark-badge]').forEach((el) => el.remove());
  const selector = 'a[href],button,input,select,textarea,[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="checkbox"],[role="radio"],[role="switch"],[role="option"],[tabindex],[contenteditable],[onclick]';
  const controlTags = new Set(['input', 'select', 'textarea', 'button']);
  const elements = Array.from(document.querySelectorAll(selector));
  const offscreenLimit = ${OFFSCREEN_LIMIT};
  const text = (value) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, 160);
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
    const mark = descriptors.length + 1;
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
      name: nameFor(el), type: el.getAttribute('type') || '', value: text(el.value),
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
