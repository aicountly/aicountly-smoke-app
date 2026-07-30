import type { PageMetadata } from '../scanner/pageScanner.js';
import type { InventoryEntry } from '../scanner/uiInventory.js';
import type { ConsoleEvent } from '../scanner/consoleCapture.js';
import type { NetworkEvent } from '../scanner/networkCapture.js';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'suggestion';

export type UxIssue = {
  result_id?: number;
  category: string;
  severity: Severity;
  title: string;
  description: string;
  recommendation: string;
  human_summary: string;
  developer_prompt: string;
  evidence: Record<string, unknown>;
};

const severityRank: Record<Severity, number> = {
  suggestion: 0, low: 1, medium: 2, high: 3, critical: 4,
};

/** Controls that could plausibly resolve a fallback state rather than navigate past it. */
const EMPTY_STATE_CTA_REGEX =
  /\b(add|create|new|import|upload|select|choose|switch|invite|connect|get started|browse)\b/i;

/** A shared label that is a form-field placeholder, not distinct visible copy some human chose to repeat. */
const PLACEHOLDER_LABEL_REGEX = /^(—|-|--)?\s*(select|choose)\s*(—|-|--)?$/i;

/** A console error whose text is a browser-generated "resource failed to load" notice for a 404, not a script exception. */
const RESOURCE_404_CONSOLE_REGEX = /fail(?:ed)?\s+to\s+load\s+resource.*\b404\b|\b404\b.*\bnot\s+found\b/i;

/** Collapses repeated cross-screen heuristics while preserving screen evidence. */
export function dedupeUxIssues(issues: UxIssue[]): UxIssue[] {
  const byFinding = new Map<string, UxIssue>();
  for (const issue of issues) {
    const key = `${issue.category.trim().toLowerCase()}\u0000${issue.title.trim().toLowerCase()}`;
    const current = byFinding.get(key);
    if (!current) {
      byFinding.set(key, { ...issue, evidence: normalizeEvidence(issue.evidence) });
      continue;
    }
    if (severityRank[issue.severity] > severityRank[current.severity]) current.severity = issue.severity;
    current.evidence = mergeEvidence(current.evidence, issue.evidence);
    // Keep one representative result so the DB row links to an observed screen.
    current.result_id ??= issue.result_id;
  }
  return [...byFinding.values()];
}

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

  // A pre-login screen has no app shell to carry a breadcrumb, command
  // palette, keyboard shortcuts, or contextual help — flagging their absence
  // there is a false positive attributed to the wrong screen/repo.
  if (meta.is_authenticated_shell) {
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
  }
  // A fallback state is what the product shows instead of the screen the user
  // asked for, so it is the moment a run is most likely to lose its way — and
  // until now nothing consumed meta.empty_state, so those screens reached no
  // report at all. The state itself is not a defect; one whose way out is absent,
  // or sitting somewhere other than the message explaining it, is.
  if (meta.is_authenticated_shell && meta.empty_state) {
    const copy = (meta.empty_state_text ?? '').trim();
    const quoted = copy ? ` ("${copy}")` : '';
    const resolvers = inventory.filter((item) =>
      (item.kind === 'button' || item.kind === 'menu') && EMPTY_STATE_CTA_REGEX.test(item.label));
    if (!resolvers.length) {
      issues.push(mk('empty_state', 'medium', 'Fallback state offers no way forward',
        `This screen stopped at a fallback state${quoted} and exposes no visible control that would resolve it.`,
        'Give every empty/fallback state a primary action that resolves it, next to the copy that explains it.',
        'Add a visible primary call-to-action to the empty state on this screen, beside its explanatory copy.',
        { url: meta.url, empty_state_text: copy }));
    } else {
      issues.push(mk('empty_state', 'low', 'Fallback state resolved only by controls outside it',
        `This screen stopped at a fallback state${quoted}. The controls that could resolve it `
        + `(${resolvers.slice(0, 3).map((item) => `"${item.label.slice(0, 60)}"`).join(', ')}) `
        + 'sit elsewhere on the screen rather than in the message itself.',
        'Repeat the resolving action inside the empty-state block so the next step is where the user is already looking.',
        'Render the resolving call-to-action inside the empty-state block on this screen, not only in the shell chrome.',
        {
          url: meta.url,
          empty_state_text: copy,
          candidate_actions: resolvers.slice(0, 5).map((item) => item.label),
        }));
    }
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
      if (PLACEHOLDER_LABEL_REGEX.test(label)) {
        // A shared placeholder like "— select —" is the visible copy for
        // several distinct per-field controls by design; renaming the on-screen
        // text would just make every field say something different for no
        // reason. The actual ambiguity is for assistive tech, not sighted users.
        issues.push(mk('layout', 'low', `Duplicate button label "${label}"`,
          `${count} visible buttons share the placeholder-style label "${label}".`,
          'Give each field-level control its own accessible name (aria-label / aria-labelledby pointing at the adjacent field label); keep the shared visible placeholder text.',
          `Add a distinct aria-label (or aria-labelledby referencing the adjacent field label) to each "${label}" control on this screen. Do not change the visible placeholder copy itself.`,
          { count }));
      } else {
        issues.push(mk('layout', 'low', `Duplicate button label "${label}"`,
          `${count} visible buttons share the label "${label}".`,
          'Disambiguate via icon + label or context-specific copy.',
          `Rename the duplicate "${label}" buttons on this screen so each conveys a distinct action.`,
          { count }));
      }
    }
  }
  if (meta.old_theme_indicators.length) {
    issues.push(mk('old_theme', 'high', 'Legacy / old theme indicators present',
      'Page uses legacy HTML attributes or tags inconsistent with modern theme.',
      'Migrate to the AICOUNTLY green-white modern SaaS theme (Tailwind + tokens).',
      'Migrate this page to the modern green-white theme tokens; remove legacy attributes.',
      { indicators: meta.old_theme_indicators, url: meta.url }));
  }
  const consoleErrors = consoleEvents.filter((e) => e.type === 'pageerror' || e.type === 'error');
  if (consoleErrors.length) {
    // A page that fails to load an optional logo/avatar image logs a console
    // error shaped identically to a script exception; a real JS bug and a
    // missing asset are not the same severity of problem.
    const onlyResource404s = consoleErrors.every((e) => e.type !== 'pageerror' && RESOURCE_404_CONSOLE_REGEX.test(e.text));
    issues.push(mk('errors', onlyResource404s ? 'medium' : 'critical', 'JavaScript console errors during navigation',
      onlyResource404s
        ? 'All captured console errors are failed resource loads (404 on an image/asset), not script exceptions.'
        : 'One or more JavaScript console errors occurred while observing this page.',
      onlyResource404s
        ? 'Add a client-side fallback for the missing resource (skip the request, or catch the load error and show a placeholder) instead of treating this as a script bug.'
        : 'Investigate and silence these errors -- they often hide functional regressions.',
      onlyResource404s
        ? 'Add a graceful fallback for the missing resource(s) captured below (e.g. an onerror handler or default image); this is a 404 on an optional asset, not a JavaScript exception.'
        : 'Fix the console errors observed on this page; capture stack traces and treat as P1.',
      { events: consoleEvents.slice(0, 10) }));
  }
  if (networkEvents.length) {
    issues.push(mk('errors', 'high', 'Network/API failures detected',
      `${networkEvents.length} network failures observed.`,
      'Investigate failing endpoints; treat 5xx as P1 and 4xx during normal navigation as P2.',
      'Investigate the failing API endpoints captured during observation.',
      { sample: networkEvents.slice(0, 10) }));
  }
  // A pre-login/landing screen has no topbar of its own to carry a company
  // switcher, so checking for one there is a false positive attributed to the
  // wrong screen (see is_authenticated_shell above).
  if (
    meta.is_authenticated_shell
    && !inventory.some((i) => i.kind === 'company_selector' || i.kind === 'branch_selector' || i.kind === 'fy_selector')
    && /book|invoice|gst|hrms|payroll/.test(meta.title.toLowerCase())
  ) {
    issues.push(mk('multi_tenant', 'low', 'Company / branch / FY selector not detected',
      'For multi-company AICOUNTLY screens we expect a company / branch / FY selector.',
      'Confirm presence in the topbar and add if missing.',
      'Add the standard company/branch/financial-year selector to the topbar of this screen.',
      { url: meta.url }));
  }
  return issues;
}

function mk(category: string, severity: Severity, title: string, description: string, recommendation: string, developerPrompt: string, evidence: Record<string, unknown>): UxIssue {
  return { category, severity, title, description, recommendation, human_summary: '', developer_prompt: developerPrompt, evidence };
}

function normalizeEvidence(evidence: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...evidence };
  if (evidence.url && !evidence.affected_urls) normalized.affected_urls = [String(evidence.url)];
  for (const key of ['affected_urls', 'screen_titles', 'screenshot_paths', 'inventory_samples', 'console_events', 'network_events']) {
    if (normalized[key] !== undefined && !Array.isArray(normalized[key])) normalized[key] = [normalized[key]];
  }
  return normalized;
}

function mergeEvidence(left: Record<string, unknown>, right: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...normalizeEvidence(left), ...normalizeEvidence(right) };
  for (const key of ['affected_urls', 'screen_titles', 'screenshot_paths', 'inventory_samples', 'console_events', 'network_events']) {
    const values = [...asArray(normalizeEvidence(left)[key]), ...asArray(normalizeEvidence(right)[key])];
    if (values.length) {
      const seen = new Set<string>();
      merged[key] = values.filter((value) => {
        const fingerprint = typeof value === 'string' ? value : JSON.stringify(value);
        if (seen.has(fingerprint)) return false;
        seen.add(fingerprint);
        return true;
      });
    }
  }
  delete merged.url;
  return merged;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}
