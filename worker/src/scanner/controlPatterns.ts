/**
 * Regex sources (not RegExp objects) for control-label heuristics that must run
 * in two very different places: inside a Playwright page.evaluate() string,
 * where they are interpolated via `${...}` straight into a regex literal (so
 * the source text must contain no unescaped "/"), and directly in Node, in
 * worker/src/reporter/cursorHandoff.ts's own-evidence trust classification.
 * Kept here once so both stay in sync, and so they are unit-testable without a
 * DOM (see controlPatterns.test.ts).
 *
 * These match a native `<select>`-free, button/combobox-based control purely
 * by its visible label text -- the shape the detectors originally missed: a
 * topbar showing the current company/branch/financial-year as a clickable
 * button, and a search/command-palette trigger button instead of a visible
 * text input.
 */

/** A topbar company/branch/financial-year switcher, by its visible label text alone. */
export const SELECTOR_LABEL_PATTERN_SOURCE = '\\b(fy|company|branch|ho)\\b|20\\d{2}\\s*[-\u2013]\\s*\\d{2,4}';

/** A search or command-palette trigger, by its visible label/aria-label text alone. */
export const SEARCH_LABEL_PATTERN_SOURCE = 'search|\\bcmd\\s*\\+?\\s*k\\b|\\bctrl\\s*\\+?\\s*k\\b';

/**
 * Common table-toolbar filter chip/button labels. Only counted as filter
 * evidence when the control sits in the same parent section as a table — see
 * pageScanner / uiInventory.
 */
export const TOOLBAR_FILTER_LABEL_PATTERN_SOURCE =
  '^(all|status|from|to|department|branch|category|type)\\b';

/**
 * Repeated CRUD / row-action labels that are intentionally identical across
 * table rows. Softened / suppressed in uxReviewEngine and demoted in
 * cursorHandoff trust classification when any residual finding remains.
 */
export const ROW_ACTION_LABEL_PATTERN_SOURCE =
  '^(edit|delete|deactivate|activate|view|all|remove|approve|reject)$';

/**
 * Tabular export / download-as-file controls. "Download CSV" counts as export
 * evidence even when the literal word "export" is absent.
 */
export const EXPORT_OR_DOWNLOAD_LABEL_PATTERN_SOURCE =
  'download\\b.*\\b(csv|excel|xlsx|xls|pdf)|\\bexport\\b';

/** A branch/head-office switcher specifically, used to pick a more specific inventory kind than the generic selector match. */
export const BRANCH_LABEL_PATTERN_SOURCE = '\\bbranch\\b|\\bho\\b';

/** A financial-year switcher specifically, used to pick a more specific inventory kind than the generic selector match. */
export const FY_LABEL_PATTERN_SOURCE = '\\bfy\\b|20\\d{2}\\s*[-\u2013]\\s*\\d{2,4}';

/**
 * Action verbs that mean "do something with a company/branch", not "switch the
 * current company context". "Add Company" must not become a company_selector.
 */
export const ACTION_VERB_PATTERN_SOURCE =
  '\\b(add|create|new|edit|delete|settings|manage|list|view)\\b';

/** Ordinary shell chrome that sits near FY/branch controls but is not a tenant switcher. */
export const SHELL_CHROME_LABEL_PATTERN_SOURCE =
  '^(home|settings|profile|notifications?|logout|log\\s*out|help|menu|user|account|dashboard|messages?|inbox|alerts?|reports?)$';

export const SELECTOR_LABEL_PATTERN: RegExp = new RegExp(SELECTOR_LABEL_PATTERN_SOURCE, 'i');
export const SEARCH_LABEL_PATTERN: RegExp = new RegExp(SEARCH_LABEL_PATTERN_SOURCE, 'i');
export const TOOLBAR_FILTER_LABEL_PATTERN: RegExp = new RegExp(TOOLBAR_FILTER_LABEL_PATTERN_SOURCE, 'i');
export const ROW_ACTION_LABEL_PATTERN: RegExp = new RegExp(ROW_ACTION_LABEL_PATTERN_SOURCE, 'i');
export const EXPORT_OR_DOWNLOAD_LABEL_PATTERN: RegExp = new RegExp(EXPORT_OR_DOWNLOAD_LABEL_PATTERN_SOURCE, 'i');
export const BRANCH_LABEL_PATTERN: RegExp = new RegExp(BRANCH_LABEL_PATTERN_SOURCE, 'i');
export const FY_LABEL_PATTERN: RegExp = new RegExp(FY_LABEL_PATTERN_SOURCE, 'i');
export const ACTION_VERB_PATTERN: RegExp = new RegExp(ACTION_VERB_PATTERN_SOURCE, 'i');
export const SHELL_CHROME_LABEL_PATTERN: RegExp = new RegExp(SHELL_CHROME_LABEL_PATTERN_SOURCE, 'i');

export type ShellControlKind = 'company_selector' | 'branch_selector' | 'fy_selector' | 'search';

/**
 * Pure mirror of the shell-control classification used inside uiInventory's
 * page.evaluate body. `siblingLabels` are other button/combobox labels that
 * share the same parent (used for bare-tenant-next-to-FY/HO detection).
 */
export function classifyShellLabel(
  label: string,
  siblingLabels: string[] = [],
): ShellControlKind | null {
  const trimmed = label.trim();
  if (!trimmed) return null;
  if (SEARCH_LABEL_PATTERN.test(trimmed)) return 'search';
  if (ACTION_VERB_PATTERN.test(trimmed)) return null;
  if (SELECTOR_LABEL_PATTERN.test(trimmed)) {
    if (BRANCH_LABEL_PATTERN.test(trimmed)) return 'branch_selector';
    if (FY_LABEL_PATTERN.test(trimmed)) return 'fy_selector';
    return 'company_selector';
  }
  const hasFyOrBranchSibling = siblingLabels.some(
    (sibling) => BRANCH_LABEL_PATTERN.test(sibling) || FY_LABEL_PATTERN.test(sibling),
  );
  if (
    hasFyOrBranchSibling
    && !SHELL_CHROME_LABEL_PATTERN.test(trimmed)
    && trimmed.length >= 2
    && trimmed.length <= 80
  ) {
    return 'company_selector';
  }
  return null;
}
