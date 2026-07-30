import type { Page } from 'playwright';
import { SEARCH_LABEL_PATTERN_SOURCE } from './controlPatterns.js';

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
  /** The fallback/empty-state sentence itself, so a finding can quote the screen. */
  empty_state_text: string;
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

  // A fallback state is any screen that stops and asks for something before it
  // can show content. "No records found" was the only shape recognised before,
  // which missed the commonest one in a multi-company product: a dashboard that
  // renders nothing because no company, branch or financial year is selected.
  // Regex literals rather than new RegExp(string): this body is source text sent
  // to the page, where a string literal would eat the backslashes first.
  const emptyStatePatterns = [
    /[^.\\n]{0,60}no\\s+(?:records|data|results|rows|entries)\\b[^.\\n]{0,60}/i,
    /[^.\\n]{0,60}no\\s+[a-z ]{2,24}\\s+(?:selected|chosen|found|yet|available)\\b[^.\\n]{0,60}/i,
    /[^.\\n]{0,60}nothing\\s+(?:here|yet|to\\s+show)\\b[^.\\n]{0,60}/i,
    /[^.\\n]{0,60}select\\s+a\\s+[a-z ]{2,24}\\s+to\\s+[a-z][^.\\n]{0,60}/i,
  ];
  let emptyStateText = '';
  for (const pattern of emptyStatePatterns) {
    const found = pattern.exec(document.body.innerText || '');
    if (found) {
      emptyStateText = found[0].trim().replace(/\\s+/g, ' ').slice(0, 200);
      break;
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
  const hasSearchInput = Array.from(searchScope.querySelectorAll('input[type="search"], [role="searchbox"], [aria-label*="search" i]')).filter(visible).length > 0;
  // A palette/command trigger (e.g. a "Search employees, modules..." button
  // that opens a modal on click) provides the same capability as a visible
  // text input but matches none of the selectors above.
  const searchLabelPattern = /${SEARCH_LABEL_PATTERN_SOURCE}/i;
  const hasSearchTrigger = Array.from(searchScope.querySelectorAll('button, [role="button"]'))
    .filter(visible)
    .some((el) => searchLabelPattern.test((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')));
  const hasSearch = hasSearchInput || hasSearchTrigger;

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
    empty_state: emptyStateText !== '' && tables.length === 0,
    empty_state_text: emptyStateText,
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
