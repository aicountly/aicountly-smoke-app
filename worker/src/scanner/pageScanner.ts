import type { Page } from 'playwright';

export type PageMetadata = {
  url: string;
  title: string;
  module_name: string | null;
  /**
   * True when this screen looks like the signed-in app shell rather than the
   * login/landing gate. Heuristic: a nav/aside/banner region exposing several
   * links (a real navigation menu) and no password input on screen. Cheap and
   * reliable enough to gate navigation-only heuristics without a real auth
   * signal, which the scanner has no access to.
   */
  is_authenticated_shell: boolean;
  has_breadcrumb: boolean;
  has_search: boolean;
  has_help_text: boolean;
  has_keyboard_shortcuts: boolean;
  has_export: boolean;
  has_print: boolean;
  has_download: boolean;
  has_upload: boolean;
  file_input_count: number;
  file_accept_mimes: string[];
  empty_state: boolean;
  table_overflow: boolean;
  modal_overflow: boolean;
  primary_buttons: number;
  forms: number;
  tables: number;
  filters: number;
  old_theme_indicators: string[];
};

/**
 * Read-only inspection of the currently loaded page.
 * Body is a string so tsx/esbuild cannot inject `__name` into Playwright evaluate.
 */
const SCAN_PAGE_JS = `
  const $ = (s) => Array.from(document.querySelectorAll(s));
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const allText = (document.body.innerText || '').toLowerCase();

  const oldThemeIndicators = [];
  if (document.querySelector('table[border]')) oldThemeIndicators.push('html_table_border_attr');
  if ($('font, marquee, blink').length) oldThemeIndicators.push('legacy_html_tags');
  if (document.querySelector('[bgcolor]')) oldThemeIndicators.push('inline_bgcolor');
  if (document.querySelector('img[align]')) oldThemeIndicators.push('img_align');
  if (document.querySelector('center')) oldThemeIndicators.push('center_tag');

  const tables = $('table').filter(visible);
  let tableOverflow = false;
  for (const t of tables) {
    const r = t.getBoundingClientRect();
    if (r.width > window.innerWidth + 10) { tableOverflow = true; break; }
  }
  let modalOverflow = false;
  const modals = $('[role="dialog"], .modal, .ant-modal, .MuiDialog-root');
  for (const m of modals) {
    if (!visible(m)) continue;
    const r = m.getBoundingClientRect();
    if (r.height > window.innerHeight + 10 || r.width > window.innerWidth + 10) {
      modalOverflow = true; break;
    }
  }

  const moduleEl = document.querySelector('h1, [data-module-name]');

  // See PageMetadata.is_authenticated_shell for the rationale: a real app nav
  // with several links and no visible password field reads as "signed in";
  // a bare centered login form (few/no nav links, a password input) does not.
  const shellNavLinkCount = $('nav a, aside a, [role="navigation"] a').filter(visible).length;
  const hasPasswordInput = document.querySelector('input[type="password"]') !== null;
  const isAuthenticatedShell = shellNavLinkCount >= 3 && !hasPasswordInput;

  // Scope the search-box check to a plausible app-shell container when one is
  // easily identifiable, so a login page's unrelated search-like input cannot
  // satisfy (or a stray one falsely fail) the global command-palette check.
  const shellContainer = document.querySelector('header, nav, aside, [role="banner"]');
  const searchScope = shellContainer || document;
  const hasSearch = Array.from(searchScope.querySelectorAll('input[type="search"], [role="searchbox"], [aria-label*="search" i]')).filter(visible).length > 0;

  return {
    url: location.href,
    title: document.title,
    module_name: (moduleEl && (moduleEl.textContent || '').trim().slice(0, 200)) || null,
    is_authenticated_shell: isAuthenticatedShell,
    has_breadcrumb: $('[aria-label*="breadcrumb" i], .breadcrumb, .breadcrumbs').filter(visible).length > 0,
    has_search: hasSearch,
    has_help_text: /help|tooltip|info/i.test(document.body.innerHTML.slice(0, 50000)),
    has_keyboard_shortcuts: /\\bctrl\\b|\\bcmd\\b|\\u2318|\\u21E7/.test(document.body.innerHTML.slice(0, 50000)),
    has_export: /\\bexport\\b/i.test(allText),
    has_print: /\\bprint\\b/i.test(allText),
    has_download: /\\bdownload\\b/i.test(allText),
    has_upload: $('input[type="file"]').length > 0 || /\\b(upload|import|attach)\\b/i.test(allText),
    file_input_count: $('input[type="file"]').length,
    file_accept_mimes: $('input[type="file"]').map((el) => el.getAttribute('accept') || '').filter(Boolean),
    empty_state: /no (records|data|results)|empty|nothing/i.test(allText) && tables.length === 0,
    table_overflow: tableOverflow,
    modal_overflow: modalOverflow,
    primary_buttons: $('button, [role="button"]').filter(visible).length,
    forms: $('form').filter(visible).length,
    tables: tables.length,
    filters: $('[role="combobox"], select, .filter, [class*="filter"]').filter(visible).length,
    old_theme_indicators: oldThemeIndicators,
  };
`;

export async function scanPage(page: Page): Promise<PageMetadata> {
  return (await page.evaluate(`(() => {\n${SCAN_PAGE_JS}\n})()`)) as PageMetadata;
}
