import type { Page } from 'playwright';

export type MenuItem = {
  label: string;
  href: string;
  selector: string;
  level: number;
};

/**
 * Pulls visible top-level navigation entries from common app shells. Heuristic
 * but stable: prefers <nav> elements, then aside/sidebar, then any element
 * with role="navigation".
 */
export async function scanMenus(page: Page): Promise<MenuItem[]> {
  return await page.evaluate(() => {
    const containers = Array.from(
      document.querySelectorAll('nav, aside, [role="navigation"], .sidebar, .main-menu, .left-menu'),
    );
    const seen = new Set<string>();
    const items: { label: string; href: string; selector: string; level: number }[] = [];
    for (const c of containers) {
      const links = Array.from(c.querySelectorAll('a, [role="menuitem"], button'));
      for (const el of links) {
        const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200);
        const href = (el as HTMLAnchorElement).href || '';
        if (!text || text.length < 2 || /^\d+$/.test(text)) continue;
        const key = text + '|' + href;
        if (seen.has(key)) continue;
        seen.add(key);
        const tag = el.tagName.toLowerCase();
        const cls = (el.getAttribute('class') || '').split(' ').filter(Boolean).slice(0, 3).join('.');
        const selector = cls ? `${tag}.${cls}` : tag;
        let level = 0;
        let p: Element | null = el;
        while (p && p !== c) {
          if (['UL', 'OL', 'DETAILS', 'DIV'].includes(p.tagName)) level++;
          p = p.parentElement;
        }
        items.push({ label: text, href, selector, level: Math.min(level, 5) });
      }
    }
    return items.slice(0, 200);
  });
}
