import type { Page } from 'playwright';
import {
  ACTION_VERB_PATTERN_SOURCE,
  BRANCH_LABEL_PATTERN_SOURCE,
  FY_LABEL_PATTERN_SOURCE,
  SEARCH_LABEL_PATTERN_SOURCE,
  SELECTOR_LABEL_PATTERN_SOURCE,
  SHELL_CHROME_LABEL_PATTERN_SOURCE,
  TOOLBAR_FILTER_LABEL_PATTERN_SOURCE,
} from './controlPatterns.js';

export type InventoryEntry = {
  kind: 'menu' | 'submenu' | 'button' | 'form' | 'table' | 'filter' | 'export' | 'print' | 'download' | 'upload' | 'shortcut' | 'help' | 'tab' | 'modal' | 'company_selector' | 'fy_selector' | 'branch_selector' | 'search' | 'ai_copilot';
  label: string;
  selector: string;
  url: string;
  payload: Record<string, unknown>;
};

/**
 * Walks the page DOM and collects an inventory of UI elements.
 * Body is a string so tsx/esbuild cannot inject `__name` into Playwright evaluate.
 */
const COLLECT_INVENTORY_JS = `
  const selectorLabelPattern = /${SELECTOR_LABEL_PATTERN_SOURCE}/i;
  const branchLabelPattern = /${BRANCH_LABEL_PATTERN_SOURCE}/i;
  const fyLabelPattern = /${FY_LABEL_PATTERN_SOURCE}/i;
  const searchLabelPattern = /${SEARCH_LABEL_PATTERN_SOURCE}/i;
  const toolbarFilterLabelPattern = /${TOOLBAR_FILTER_LABEL_PATTERN_SOURCE}/i;
  const actionVerbPattern = /${ACTION_VERB_PATTERN_SOURCE}/i;
  const shellChromeLabelPattern = /${SHELL_CHROME_LABEL_PATTERN_SOURCE}/i;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const $ = (s) => Array.from(document.querySelectorAll(s));
  const text = (el) => (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 200);
  const cssPath = (el) => {
    const parts = [];
    let cur = el;
    while (cur && cur.tagName !== 'BODY' && parts.length < 6) {
      const seg = cur.id
        ? ('#' + cur.id)
        : (cur.tagName.toLowerCase() + (cur.classList[0] ? '.' + cur.classList[0] : ''));
      parts.unshift(seg);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  };
  const url = location.href;
  const out = [];

  for (const a of $('nav a, aside a, [role="navigation"] a').filter(visible)) {
    out.push({ kind: 'menu', label: text(a), selector: cssPath(a), url: url, payload: { href: a.href } });
  }
  for (const b of $('button, [role="button"]').filter(visible)) {
    out.push({ kind: 'button', label: text(b), selector: cssPath(b), url: url, payload: {} });
  }
  for (const f of $('form').filter(visible)) {
    const inputs = Array.from(f.querySelectorAll('input,select,textarea')).map((i) => ({
      name: i.name,
      type: i.type,
      placeholder: i.placeholder,
    }));
    out.push({ kind: 'form', label: text(f).slice(0, 100), selector: cssPath(f), url: url, payload: { fields: inputs } });
  }
  for (const input of $('input[type="file"]')) {
    out.push({
      kind: 'upload',
      label: input.getAttribute('aria-label') || input.name || 'File upload',
      selector: cssPath(input),
      url: url,
      payload: { accept: input.getAttribute('accept') || '', multiple: !!input.multiple },
    });
  }
  for (const el of $('a, button, [role="button"]').filter(visible)) {
    if (/\\b(upload|import|attach)\\b/i.test(text(el))) {
      out.push({ kind: 'upload', label: text(el), selector: cssPath(el), url: url, payload: {} });
    }
  }
  for (const t of $('table').filter(visible)) {
    const headers = Array.from(t.querySelectorAll('thead th')).map((h) => text(h));
    out.push({
      kind: 'table',
      label: text(t.querySelector('caption') || t).slice(0, 100),
      selector: cssPath(t),
      url: url,
      payload: { headers: headers, rows: t.querySelectorAll('tbody tr').length },
    });
  }
  for (const f of $('select, [role="combobox"], .filter, [class*="filter"]').filter(visible)) {
    out.push({ kind: 'filter', label: text(f).slice(0, 100), selector: cssPath(f), url: url, payload: {} });
  }
  // SearchableSelect-style listbox triggers and date range inputs are page-local filters.
  for (const el of $('[aria-haspopup="listbox"]').filter(visible)) {
    out.push({ kind: 'filter', label: text(el).slice(0, 100) || 'listbox filter', selector: cssPath(el), url: url, payload: { role: 'listbox_popup' } });
  }
  for (const el of $('input[type="date"], input[type="datetime-local"]').filter(visible)) {
    out.push({
      kind: 'filter',
      label: el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('placeholder') || 'date filter',
      selector: cssPath(el),
      url: url,
      payload: { role: 'date_filter', type: el.type },
    });
  }
  // Table search boxes are filter evidence even when no classic filter control exists.
  for (const el of $('input[type="search"], [role="searchbox"]').filter(visible)) {
    out.push({ kind: 'filter', label: text(el) || el.getAttribute('placeholder') || 'search', selector: cssPath(el), url: url, payload: { role: 'table_search' } });
  }
  // All/status/from/to/... chips near a table toolbar (same parent section).
  const toolbarFilterSeen = new Set();
  for (const t of $('table').filter(visible)) {
    let scope = t.parentElement;
    for (let depth = 0; depth < 3 && scope; depth++) {
      for (const el of Array.from(scope.querySelectorAll('button, [role="button"]')).filter(visible)) {
        if (toolbarFilterSeen.has(el)) continue;
        const label = text(el) || (el.getAttribute('aria-label') || '').trim();
        if (!toolbarFilterLabelPattern.test(label)) continue;
        toolbarFilterSeen.add(el);
        out.push({ kind: 'filter', label: label.slice(0, 100), selector: cssPath(el), url: url, payload: { role: 'toolbar_filter' } });
      }
      scope = scope.parentElement;
    }
  }
  const tabularDownloadPattern = /download\\b.*\\b(csv|excel|xlsx|xls|pdf)|\\b(csv|excel|xlsx|xls|pdf)\\b/i;
  for (const tag of ['Export', 'Print', 'Download']) {
    for (const el of Array.from(document.querySelectorAll('a, button'))) {
      if (visible(el) && new RegExp('\\\\b' + tag + '\\\\b', 'i').test(el.textContent || '')) {
        const label = text(el);
        out.push({ kind: tag.toLowerCase(), label: label, selector: cssPath(el), url: url, payload: {} });
        // Tabular "Download CSV/Excel/PDF" is also export evidence for trust demotion.
        if (tag === 'Download' && tabularDownloadPattern.test(label)) {
          out.push({ kind: 'export', label: label, selector: cssPath(el), url: url, payload: { via: 'download_tabular' } });
        }
      }
    }
  }
  for (const el of $('[role="search"], input[type="search"], [aria-label*="search" i]').filter(visible)) {
    out.push({ kind: 'search', label: text(el) || 'search', selector: cssPath(el), url: url, payload: {} });
  }
  for (const el of $('[data-company-selector], [data-branch-selector], [data-fy-selector], select[name*="company" i], select[name*="branch" i], select[name*="financial" i]').filter(visible)) {
    const n = (el.name || '').toLowerCase();
    const kind = n.includes('branch') ? 'branch_selector' : n.includes('financial') ? 'fy_selector' : 'company_selector';
    out.push({ kind: kind, label: text(el) || kind, selector: cssPath(el), url: url, payload: {} });
  }
  // A custom button/combobox-based switcher (current company/branch/FY shown
  // as clickable topbar chrome rather than a native <select>) is structurally
  // invisible to the block above; catch it by its own visible label text,
  // scoped to the app shell so an unrelated body button cannot match.
  // Action-verb labels ("Add Company") are excluded. Bare tenant names next to
  // a FY/branch sibling are tagged as company_selector.
  const shellScope = document.querySelector('header, nav, aside, [role="banner"]') || document;
  const shellControls = Array.from(shellScope.querySelectorAll('button, [role="button"], [role="combobox"]')).filter(visible);
  for (const el of shellControls) {
    const label = text(el);
    if (!label) continue;
    if (searchLabelPattern.test(label)) {
      out.push({ kind: 'search', label: label, selector: cssPath(el), url: url, payload: {} });
      continue;
    }
    if (actionVerbPattern.test(label)) continue;
    if (selectorLabelPattern.test(label)) {
      const kind = branchLabelPattern.test(label) ? 'branch_selector' : fyLabelPattern.test(label) ? 'fy_selector' : 'company_selector';
      out.push({ kind: kind, label: label, selector: cssPath(el), url: url, payload: {} });
      continue;
    }
    const siblingLabels = Array.from((el.parentElement && el.parentElement.children) || [])
      .filter((sib) => sib !== el && sib.matches && sib.matches('button, [role="button"], [role="combobox"]'))
      .map((sib) => text(sib))
      .filter(Boolean);
    const hasFyOrBranchSibling = siblingLabels.some((sib) => branchLabelPattern.test(sib) || fyLabelPattern.test(sib));
    if (
      hasFyOrBranchSibling
      && !shellChromeLabelPattern.test(label)
      && label.length >= 2
      && label.length <= 80
    ) {
      out.push({ kind: 'company_selector', label: label, selector: cssPath(el), url: url, payload: { via: 'sibling_heuristic' } });
    }
  }
  if (/\\b(copilot|ai assistant|ai chat)\\b/i.test(document.body.innerText || '')) {
    out.push({ kind: 'ai_copilot', label: 'AI / copilot detected', selector: 'body', url: url, payload: {} });
  }
  return out;
`;

export async function collectInventory(page: Page): Promise<InventoryEntry[]> {
  return (await page.evaluate(`(() => {\n${COLLECT_INVENTORY_JS}\n})()`)) as InventoryEntry[];
}
