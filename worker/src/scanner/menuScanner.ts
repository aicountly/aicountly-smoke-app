import type { Page } from 'playwright';

export type MenuItem = {
  label: string;
  href: string;
  selector: string;
  level: number;
};

/**
 * Pulls visible navigation entries from common SaaS app shells (including
 * AICountly-style left sidebars that may not use semantic <nav>).
 */
export async function scanMenus(page: Page): Promise<MenuItem[]> {
  return await page.evaluate(() => {
    const visible = (el: Element): boolean => {
      const r = (el as HTMLElement).getBoundingClientRect();
      const style = window.getComputedStyle(el as HTMLElement);
      return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };

    const containerSel = [
      'nav',
      'aside',
      '[role="navigation"]',
      '.sidebar',
      '.main-menu',
      '.left-menu',
      '[class*="sidebar" i]',
      '[class*="side-nav" i]',
      '[class*="sidenav" i]',
      '[class*="SideNav"]',
      '[class*="main-menu" i]',
      '[class*="left-menu" i]',
      '.MuiDrawer-root',
      'mat-sidenav',
      '#sidebar',
      '#side-bar',
      '.app-menu',
      '[data-testid*="sidebar" i]',
      '[data-testid*="nav" i]',
    ].join(', ');

    const containers = Array.from(document.querySelectorAll(containerSel)).filter(visible);
    // Fallback: left rail of the viewport often hosts the app menu.
    if (containers.length === 0) {
      const leftRail = Array.from(document.querySelectorAll('a, button, [role="menuitem"], [role="link"]'))
        .filter(visible)
        .filter((el) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return r.left < 320 && r.width > 20 && r.height > 12;
        });
      if (leftRail.length) {
        // Synthetic container: reuse body and filter later by left position.
        containers.push(document.body);
      }
    }

    const seen = new Set<string>();
    const items: { label: string; href: string; selector: string; level: number }[] = [];

    const cssPath = (el: Element): string => {
      const htmlEl = el as HTMLElement;
      if (htmlEl.id) return `#${htmlEl.id}`;
      const parts: string[] = [];
      let cur: Element | null = el;
      while (cur && cur.tagName !== 'BODY' && parts.length < 5) {
        let seg = cur.tagName.toLowerCase();
        if (cur.classList?.[0]) {
          const cls = cur.classList[0].replace(/[^a-zA-Z0-9_-]/g, '');
          if (cls) seg += '.' + cls;
        }
        const parentEl: Element | null = cur.parentElement;
        if (parentEl) {
          const tag = cur.tagName;
          const siblings = Array.from(parentEl.children).filter((child) => child.tagName === tag);
          if (siblings.length > 1) {
            const idx = siblings.indexOf(cur) + 1;
            seg += `:nth-of-type(${idx})`;
          }
        }
        parts.unshift(seg);
        cur = parentEl;
      }
      return parts.join(' > ');
    };

    const pushItem = (el: Element, levelHint = 0) => {
      if (!visible(el)) return;
      const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120);
      if (!text || text.length < 2 || /^\d+$/.test(text)) return;
      // Skip obvious auth chrome.
      if (/^(sign\s*in|log\s*in|sign\s*up|register|forgot)/i.test(text)) return;

      const href = (el as HTMLAnchorElement).href || el.getAttribute('href') || '';
      const key = text.toLowerCase() + '|' + href;
      if (seen.has(key)) return;
      seen.add(key);

      items.push({
        label: text,
        href,
        selector: cssPath(el),
        level: Math.min(levelHint, 5),
      });
    };

    for (const c of containers) {
      const links = Array.from(
        c.querySelectorAll('a, [role="menuitem"], [role="link"], button, [data-menu-item], [class*="menu-item" i]'),
      );
      for (const el of links) {
        // When falling back to body, only keep left-rail items.
        if (c === document.body) {
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.left >= 320) continue;
        }
        let level = 0;
        let p: Element | null = el;
        while (p && p !== c) {
          if (['UL', 'OL', 'DETAILS', 'DIV'].includes(p.tagName)) level++;
          p = p.parentElement;
        }
        pushItem(el, level);
      }
    }

    // Prefer shorter labels (menu entries) over long paragraph buttons.
    items.sort((a, b) => a.label.length - b.label.length);
    return items.slice(0, 200);
  });
}
