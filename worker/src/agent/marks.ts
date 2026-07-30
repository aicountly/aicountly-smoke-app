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
  bbox: { x: number; y: number; width: number; height: number };
};

const MARK_SCRIPT = `(() => {
  document.querySelectorAll('[data-smoke-mark]').forEach((el) => el.removeAttribute('data-smoke-mark'));
  document.querySelectorAll('[data-smoke-mark-badge]').forEach((el) => el.remove());
  const selector = 'a[href],button,input,select,textarea,[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="checkbox"],[role="radio"],[role="switch"],[role="option"],[tabindex],[contenteditable],[onclick]';
  const elements = Array.from(document.querySelectorAll(selector));
  const descriptors = [];
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
  for (const el of elements) {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0
      || rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.right <= 0
      || rect.top >= innerHeight || rect.left >= innerWidth) continue;
    const mark = descriptors.length + 1;
    el.setAttribute('data-smoke-mark', String(mark));
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
    descriptors.push({
      mark, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '',
      name: nameFor(el), type: el.getAttribute('type') || '', value: text(el.value),
      checked: typeof el.checked === 'boolean' ? el.checked : null,
      disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
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
