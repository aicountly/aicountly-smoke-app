import type { Page } from 'playwright'

export type PageMetadata = {
  url: string
  title: string
  module_name: string | null
  has_breadcrumb: boolean
  has_search: boolean
  has_help_text: boolean
  has_keyboard_shortcuts: boolean
  has_export: boolean
  has_print: boolean
  has_download: boolean
  empty_state: boolean
  table_overflow: boolean
  modal_overflow: boolean
  primary_buttons: number
  forms: number
  tables: number
  filters: number
  old_theme_indicators: string[]
}

/** Browser-side script as a plain string (avoids tsx/esbuild __name injection). */
const SCAN_PAGE_JS = [
  'const $ = (s) => Array.from(document.querySelectorAll(s));',
  'const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };',
  "const allText = (document.body.innerText || '').toLowerCase();",
  'const oldThemeIndicators = [];',
  "if (document.querySelector('table[border]')) oldThemeIndicators.push('html_table_border_attr');",
  "if ($('font, marquee, blink').length) oldThemeIndicators.push('legacy_html_tags');",
  "if (document.querySelector('[bgcolor]')) oldThemeIndicators.push('inline_bgcolor');",
  "if (document.querySelector('img[align]')) oldThemeIndicators.push('img_align');",
  "if (document.querySelector('center')) oldThemeIndicators.push('center_tag');",
  'const tables = $("table").filter(visible);',
  'let tableOverflow = false;',
  'for (const t of tables) { const r = t.getBoundingClientRect(); if (r.width > window.innerWidth + 10) { tableOverflow = true; break; } }',
  'let modalOverflow = false;',
  'const modals = $(\'[role="dialog"], .modal, .ant-modal, .MuiDialog-root\');',
  'for (const m of modals) { if (!visible(m)) continue; const r = m.getBoundingClientRect(); if (r.height > window.innerHeight + 10 || r.width > window.innerWidth + 10) { modalOverflow = true; break; } }',
  'return {',
  '  url: location.href,',
  '  title: document.title,',
  "  module_name: (document.querySelector('h1, [data-module-name]') && (document.querySelector('h1, [data-module-name]').textContent || '').trim().slice(0, 200)) || null,",
  '  has_breadcrumb: $(\'[aria-label*="breadcrumb" i], .breadcrumb, .breadcrumbs\').filter(visible).length > 0,',
  '  has_search: $(\'input[type="search"], [role="searchbox"], [aria-label*="search" i]\').filter(visible).length > 0,',
  '  has_help_text: /help|tooltip|info/i.test(document.body.innerHTML.slice(0, 50000)),',
  '  has_keyboard_shortcuts: /\\bctrl\\b|\\bcmd\\b|\\u2318|\\u21E7/.test(document.body.innerHTML.slice(0, 50000)),',
  '  has_export: /\\bexport\\b/i.test(allText),',
  '  has_print: /\\bprint\\b/i.test(allText),',
  '  has_download: /\\bdownload\\b/i.test(allText),',
  '  empty_state: /no (records|data|results)|empty|nothing/i.test(allText) && tables.length === 0,',
  '  table_overflow: tableOverflow,',
  '  modal_overflow: modalOverflow,',
  '  primary_buttons: $(\'button, [role="button"]\').filter(visible).length,',
  '  forms: $("form").filter(visible).length,',
  '  tables: tables.length,',
  '  filters: $(\'[role="combobox"], select, .filter, [class*="filter"]\').filter(visible).length,',
  '  old_theme_indicators: oldThemeIndicators',
  '};',
].join('\n')

export async function scanPage(page: Page): Promise<PageMetadata> {
  return (await page.evaluate(SCAN_PAGE_JS)) as PageMetadata
}
