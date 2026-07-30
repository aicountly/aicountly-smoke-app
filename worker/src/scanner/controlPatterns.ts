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

/** A branch/head-office switcher specifically, used to pick a more specific inventory kind than the generic selector match. */
export const BRANCH_LABEL_PATTERN_SOURCE = '\\bbranch\\b|\\bho\\b';

/** A financial-year switcher specifically, used to pick a more specific inventory kind than the generic selector match. */
export const FY_LABEL_PATTERN_SOURCE = '\\bfy\\b|20\\d{2}\\s*[-\u2013]\\s*\\d{2,4}';

export const SELECTOR_LABEL_PATTERN: RegExp = new RegExp(SELECTOR_LABEL_PATTERN_SOURCE, 'i');
export const SEARCH_LABEL_PATTERN: RegExp = new RegExp(SEARCH_LABEL_PATTERN_SOURCE, 'i');
export const BRANCH_LABEL_PATTERN: RegExp = new RegExp(BRANCH_LABEL_PATTERN_SOURCE, 'i');
export const FY_LABEL_PATTERN: RegExp = new RegExp(FY_LABEL_PATTERN_SOURCE, 'i');
