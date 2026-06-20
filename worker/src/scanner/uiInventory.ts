import type { Page } from 'playwright';

export type InventoryEntry = {
  kind: 'menu' | 'submenu' | 'button' | 'form' | 'table' | 'filter' | 'export' | 'print' | 'download' | 'shortcut' | 'help' | 'tab' | 'modal' | 'company_selector' | 'fy_selector' | 'branch_selector' | 'search' | 'ai_copilot';
  label: string;
  selector: string;
  url: string;
  payload: Record<string, unknown>;
};

/**
 * Walks the page DOM and collects an inventory of UI elements that the
 * UI Inventory Engine cares about. Pure read -- no clicks.
 */
export async function collectInventory(page: Page): Promise<InventoryEntry[]> {
  return await page.evaluate(() => {
    const visible = (el: Element): boolean => {
      const r = (el as HTMLElement).getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const $ = (s: string) => Array.from(document.querySelectorAll(s));
    const text = (el: Element) => (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200);
    const cssPath = (el: Element): string => {
      const parts: string[] = [];
      let cur: Element | null = el;
      while (cur && cur.tagName !== 'BODY' && parts.length < 6) {
        const seg = cur.id ? `#${cur.id}` : `${cur.tagName.toLowerCase()}${cur.classList[0] ? '.' + cur.classList[0] : ''}`;
        parts.unshift(seg);
        cur = cur.parentElement;
      }
      return parts.join(' > ');
    };
    const url = location.href;
    const out: InventoryEntry[] = [];

    for (const a of $('nav a, aside a, [role="navigation"] a').filter(visible)) {
      out.push({ kind: 'menu',  label: text(a), selector: cssPath(a), url, payload: { href: (a as HTMLAnchorElement).href } });
    }
    for (const b of $('button, [role="button"]').filter(visible)) {
      out.push({ kind: 'button', label: text(b), selector: cssPath(b), url, payload: {} });
    }
    for (const f of $('form').filter(visible)) {
      const inputs = Array.from(f.querySelectorAll('input,select,textarea')).map((i) => ({
        name: (i as HTMLInputElement).name,
        type: (i as HTMLInputElement).type,
        placeholder: (i as HTMLInputElement).placeholder,
      }));
      out.push({ kind: 'form', label: text(f).slice(0, 100), selector: cssPath(f), url, payload: { fields: inputs } });
    }
    for (const t of $('table').filter(visible)) {
      const headers = Array.from(t.querySelectorAll('thead th')).map((h) => text(h));
      out.push({ kind: 'table', label: text(t.querySelector('caption') ?? t).slice(0, 100), selector: cssPath(t), url, payload: { headers, rows: t.querySelectorAll('tbody tr').length } });
    }
    for (const f of $('select, [role="combobox"], .filter, [class*="filter"]').filter(visible)) {
      out.push({ kind: 'filter', label: text(f).slice(0, 100), selector: cssPath(f), url, payload: {} });
    }
    for (const tag of ['Export', 'Print', 'Download']) {
      for (const el of Array.from(document.querySelectorAll('a, button'))) {
        if (visible(el) && new RegExp('\\b' + tag + '\\b', 'i').test(el.textContent || '')) {
          out.push({ kind: tag.toLowerCase() as InventoryEntry['kind'], label: text(el), selector: cssPath(el), url, payload: {} });
        }
      }
    }
    for (const el of $('[role="search"], input[type="search"], [aria-label*="search" i]').filter(visible)) {
      out.push({ kind: 'search', label: text(el) || 'search', selector: cssPath(el), url, payload: {} });
    }
    for (const el of $('[data-company-selector], [data-branch-selector], [data-fy-selector], select[name*="company" i], select[name*="branch" i], select[name*="financial" i]').filter(visible)) {
      const n = (el as HTMLSelectElement).name?.toLowerCase() ?? '';
      const kind: InventoryEntry['kind'] = n.includes('branch') ? 'branch_selector' : n.includes('financial') ? 'fy_selector' : 'company_selector';
      out.push({ kind, label: text(el) || kind, selector: cssPath(el), url, payload: {} });
    }
    if (/\b(copilot|ai assistant|ai chat)\b/i.test(document.body.innerText || '')) {
      out.push({ kind: 'ai_copilot', label: 'AI / copilot detected', selector: 'body', url, payload: {} });
    }
    return out;
  });
}
