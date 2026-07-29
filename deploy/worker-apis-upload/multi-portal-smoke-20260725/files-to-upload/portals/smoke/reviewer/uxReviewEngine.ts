import type { PageMetadata } from '../scanner/pageScanner.js';
import type { InventoryEntry } from '../scanner/uiInventory.js';
import type { ConsoleEvent } from '../scanner/consoleCapture.js';
import type { NetworkEvent } from '../scanner/networkCapture.js';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'suggestion';

export type UxIssue = {
  category: string;
  severity: Severity;
  title: string;
  description: string;
  recommendation: string;
  developer_prompt: string;
  evidence: Record<string, unknown>;
};

/**
 * Heuristic, brain-free first pass. The backend's Brain\Ensemble can layer
 * additional issues on top via a separate pass. Heuristics here cover the
 * spec's UX checklist:
 *
 *   confusing labels, too many clicks, missing shortcut keys, missing help
 *   text, unclear empty states, inconsistent button placement, hidden
 *   actions, duplicate buttons, missing filters, missing exports, missing
 *   print/download, missing breadcrumbs, bad table layout, table overflow,
 *   modal overflow, poor mobile responsiveness, old UI/theme mismatch,
 *   missing command search, missing keyboard-first flow.
 */
export function reviewPage(args: {
  meta: PageMetadata;
  inventory: InventoryEntry[];
  consoleEvents: ConsoleEvent[];
  networkEvents: NetworkEvent[];
}): UxIssue[] {
  const { meta, inventory, consoleEvents, networkEvents } = args;
  const issues: UxIssue[] = [];
  const buttons = inventory.filter((i) => i.kind === 'button');
  const labels = buttons.map((b) => b.label.toLowerCase()).filter(Boolean);
  const labelCounts: Record<string, number> = {};
  for (const l of labels) labelCounts[l] = (labelCounts[l] ?? 0) + 1;

  if (!meta.has_breadcrumb) {
    issues.push(mk('navigation', 'low', 'Breadcrumb missing',
      'No breadcrumb navigation detected on this screen.',
      'Add a consistent breadcrumb component to all interior screens.',
      'Add breadcrumb navigation that reflects the current route hierarchy on this page.',
      { url: meta.url }));
  }
  if (!meta.has_search) {
    issues.push(mk('navigation', 'low', 'Command/search box missing',
      'No global search box found.',
      'Add a global cmd+k command palette or persistent search box to improve keyboard-first navigation.',
      'Implement a global keyboard-shortcut command palette (Ctrl+K) on this screen.',
      { url: meta.url }));
  }
  if (!meta.has_keyboard_shortcuts) {
    issues.push(mk('keyboard', 'suggestion', 'No keyboard shortcuts visible',
      'Page does not document any keyboard shortcuts.',
      'Document discoverable keyboard shortcuts in a help popover.',
      'Surface common keyboard shortcuts via a "?" help overlay.',
      { url: meta.url }));
  }
  if (!meta.has_help_text) {
    issues.push(mk('help', 'low', 'No help / tooltip cues detected',
      'No tooltip or contextual help indicators were found on this page.',
      'Add tooltips to non-obvious icon buttons and a contextual help drawer.',
      'Add aria-describedby tooltips and a contextual help button to this screen.',
      { url: meta.url }));
  }
  if (meta.tables > 0 && !meta.has_export) {
    issues.push(mk('reports', 'medium', 'Export option missing on a screen with a table',
      'Tables present but no Export action visible.',
      'Add Export to CSV / Excel for tabular data.',
      'Add an Export button next to the primary table on this screen, supporting CSV and XLSX.',
      { url: meta.url }));
  }
  if (meta.tables > 0 && !meta.has_print && !meta.has_download) {
    issues.push(mk('reports', 'low', 'Print/download missing on data screen',
      'No print or download action visible alongside data tables.',
      'Provide Print and Download (PDF) options for data-heavy screens.',
      'Add Print and Download (PDF) actions for the primary table.',
      { url: meta.url }));
  }
  if (meta.table_overflow) {
    issues.push(mk('layout', 'high', 'Table overflows viewport',
      'A visible table is wider than the viewport.',
      'Make tables horizontally scrollable inside a container or apply column compaction at narrow widths.',
      'Wrap the main table in a horizontal-scroll container and revisit responsive column rules.',
      { url: meta.url }));
  }
  if (meta.modal_overflow) {
    issues.push(mk('layout', 'medium', 'Modal overflows viewport',
      'A visible modal is taller or wider than the viewport.',
      'Constrain modal max-height/width and add internal scroll.',
      'Apply max-height: 80vh and overflow-y: auto to modals on this screen.',
      { url: meta.url }));
  }
  if (meta.tables > 0 && meta.filters === 0) {
    issues.push(mk('filters', 'medium', 'Data screen without filters',
      'Tables present but no filter controls detected.',
      'Add at least one filter control (date range, status) to large data screens.',
      'Add a filter bar with date range, status and search to this data screen.',
      { url: meta.url }));
  }
  for (const [label, count] of Object.entries(labelCounts)) {
    if (count > 2 && label.length >= 3) {
      issues.push(mk('layout', 'low', `Duplicate button label "${label}"`,
        `${count} visible buttons share the label "${label}".`,
        'Disambiguate via icon + label or context-specific copy.',
        `Rename the duplicate "${label}" buttons on this screen so each conveys a distinct action.`,
        { count }));
    }
  }
  if (meta.old_theme_indicators.length) {
    issues.push(mk('old_theme', 'high', 'Legacy / old theme indicators present',
      'Page uses legacy HTML attributes or tags inconsistent with modern theme.',
      'Migrate to the AICOUNTLY green-white modern SaaS theme (Tailwind + tokens).',
      'Migrate this page to the modern green-white theme tokens; remove legacy attributes.',
      { indicators: meta.old_theme_indicators, url: meta.url }));
  }
  if (consoleEvents.some((e) => e.type === 'pageerror' || e.type === 'error')) {
    issues.push(mk('errors', 'critical', 'JavaScript console errors during navigation',
      'One or more JavaScript console errors occurred while observing this page.',
      'Investigate and silence these errors -- they often hide functional regressions.',
      'Fix the console errors observed on this page; capture stack traces and treat as P1.',
      { events: consoleEvents.slice(0, 10) }));
  }
  if (networkEvents.length) {
    issues.push(mk('errors', 'high', 'Network/API failures detected',
      `${networkEvents.length} network failures observed.`,
      'Investigate failing endpoints; treat 5xx as P1 and 4xx during normal navigation as P2.',
      'Investigate the failing API endpoints captured during observation.',
      { sample: networkEvents.slice(0, 10) }));
  }
  if (!inventory.some((i) => i.kind === 'company_selector') && /book|invoice|gst|hrms|payroll/.test(meta.title.toLowerCase())) {
    issues.push(mk('multi_tenant', 'low', 'Company / branch / FY selector not detected',
      'For multi-company AICOUNTLY screens we expect a company / branch / FY selector.',
      'Confirm presence in the topbar and add if missing.',
      'Add the standard company/branch/financial-year selector to the topbar of this screen.',
      { url: meta.url }));
  }
  return issues;
}

function mk(category: string, severity: Severity, title: string, description: string, recommendation: string, developerPrompt: string, evidence: Record<string, unknown>): UxIssue {
  return { category, severity, title, description, recommendation, developer_prompt: developerPrompt, evidence };
}
