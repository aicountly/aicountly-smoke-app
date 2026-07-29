import type { Page } from 'playwright'

export type MenuItem = {
  label: string
  href: string
  selector: string
  level: number
}

const SCAN_MENUS_JS = [
  "const containers = Array.from(document.querySelectorAll('nav, aside, [role=\"navigation\"], .sidebar, .main-menu, .left-menu'));",
  'const seen = new Set();',
  'const items = [];',
  'for (const c of containers) {',
  "  const links = Array.from(c.querySelectorAll('a, [role=\"menuitem\"], button'));",
  '  for (const el of links) {',
  "    const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 200);",
  "    const href = el.href || '';",
  '    if (!text || text.length < 2 || /^\\d+$/.test(text)) continue;',
  "    const key = text + '|' + href;",
  '    if (seen.has(key)) continue;',
  '    seen.add(key);',
  '    const tag = el.tagName.toLowerCase();',
  "    const cls = (el.getAttribute('class') || '').split(' ').filter(Boolean).slice(0, 3).join('.');",
  "    const selector = cls ? (tag + '.' + cls) : tag;",
  '    let level = 0;',
  '    let p = el;',
  '    while (p && p !== c) {',
  "      if (['UL', 'OL', 'DETAILS', 'DIV'].includes(p.tagName)) level++;",
  '      p = p.parentElement;',
  '    }',
  '    items.push({ label: text, href: href, selector: selector, level: Math.min(level, 5) });',
  '  }',
  '}',
  'return items.slice(0, 200);',
].join('\n')

export async function scanMenus(page: Page): Promise<MenuItem[]> {
  return (await page.evaluate(`(() => {\n${SCAN_MENUS_JS}\n})()`)) as MenuItem[]
}
