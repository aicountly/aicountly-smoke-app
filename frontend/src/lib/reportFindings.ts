import { gapRows, type ReportJson } from '@/lib/reports';

export type FindingKind = 'ux' | 'gap' | 'quick_win';
export type FindingMode = 'validate_first' | 'implement';

export type FindingRow = {
  key: string;
  kind: FindingKind;
  title: string;
  severity: string;
  severityRank: number;
  meta: string;
  mode: FindingMode | null;
  summary: string;
  technical: string;
  prompt: string;
  screen: string;
  selector: string;
  expectation: string;
  imageDataUri: string;
  observed: boolean;
  partial: boolean;
  passedCheck: boolean;
};

export type FindingFacetCounts = {
  critical: number;
  high: number;
  medium: number;
  low: number;
  suggestion: number;
  validateFirst: number;
  implement: number;
  total: number;
};

export type FindingsFilter = {
  severities: Set<string>;
  modes: Set<FindingMode>;
};

type ScreenshotCardLike = {
  result_id?: number | null;
  screen_title?: string | null;
  screen_url?: string | null;
  captured_at?: string | null;
  screenshot_path?: string | null;
  image_data_uri?: string | null;
};

type RawFinding = Record<string, unknown>;

const SEVERITY_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  suggestion: 0,
};

const KIND_SORT_ORDER: Record<FindingKind, number> = { ux: 0, quick_win: 0, gap: 1 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecordArray(value: unknown): RawFinding[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function fieldOrEmpty(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function firstNonEmpty(...values: string[]): string {
  for (const value of values) {
    if (value.trim() !== '') return value.trim();
  }
  return '';
}

function stringList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : value === null || value === undefined || value === '' ? [] : [value];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string' && typeof item !== 'number') continue;
    const s = String(item).trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function basename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

function firstInventorySelector(evidence: Record<string, unknown>): string {
  const inventory = Array.isArray(evidence.inventory_samples)
    ? evidence.inventory_samples
    : Array.isArray(evidence.nearby_inventory)
      ? evidence.nearby_inventory
      : [];
  const first = isRecord(inventory[0]) ? (inventory[0] as Record<string, unknown>) : null;
  return fieldOrEmpty(first?.selector);
}

/**
 * Mirrors `matchScreenshot()` in the PHP report builders: match by the
 * originating observation result, then screenshot basename, then affected
 * URL, then screen title. The worker's own session payload has no
 * `screenshot_path` on its cards, so the basename step simply finds nothing
 * there and falls through to the URL/title match, which it does carry.
 */
export function matchEvidenceImage(
  finding: { result_id?: unknown; evidence?: unknown },
  cards: unknown,
): ScreenshotCardLike | null {
  const cardList = Array.isArray(cards) ? (cards as ScreenshotCardLike[]) : [];
  if (cardList.length === 0) return null;
  const evidence = isRecord(finding.evidence) ? finding.evidence : {};
  const resultId = Number(finding.result_id ?? 0);
  const paths = stringList(evidence.screenshot_paths);
  const urls = stringList(evidence.affected_urls ?? evidence.screens_checked ?? evidence.url);
  const titles = stringList(evidence.screen_titles);

  if (resultId > 0) {
    const byResult = cardList.find((card) => Number(card.result_id ?? 0) === resultId);
    if (byResult) return byResult;
  }
  if (paths.length > 0) {
    const byPath = cardList.find((card) => {
      const cardPath = String(card.screenshot_path ?? '');
      if (!cardPath) return false;
      return paths.some((path) => path === cardPath || basename(path) === basename(cardPath));
    });
    if (byPath) return byPath;
  }
  if (urls.length > 0) {
    const byUrl = cardList.find((card) => {
      const cardUrl = String(card.screen_url ?? '').replace(/\/+$/, '');
      if (!cardUrl) return false;
      return urls.some((url) => cardUrl === url.replace(/\/+$/, ''));
    });
    if (byUrl) return byUrl;
  }
  if (titles.length > 0) {
    const byTitle = cardList.find((card) => {
      const cardTitle = String(card.screen_title ?? '');
      if (!cardTitle) return false;
      return titles.some((title) => title.toLowerCase() === cardTitle.toLowerCase());
    });
    if (byTitle) return byTitle;
  }
  return null;
}

function rowKey(bucket: 'ux' | 'gap', id: unknown, arrayName: string, index: number): string {
  const numericId = Number(id);
  if (Number.isFinite(numericId) && numericId > 0) return `${bucket}:${numericId}`;
  return `${arrayName}:${index}`;
}

function buildFindingRow(raw: RawFinding, kind: FindingKind, cards: unknown, key: string): FindingRow {
  const severity = fieldOrEmpty(raw.severity).toLowerCase();
  const severityRank = SEVERITY_RANK[severity] ?? -1;
  const modeRaw = fieldOrEmpty(raw.mode).toLowerCase();
  const mode: FindingMode | null = modeRaw === 'implement' || modeRaw === 'validate_first' ? modeRaw : null;
  const category = fieldOrEmpty(raw.category);
  const title = firstNonEmpty(fieldOrEmpty(raw.title), fieldOrEmpty(raw.expected_feature)) || 'Untitled finding';

  const summary = firstNonEmpty(
    fieldOrEmpty(raw.human_summary),
    fieldOrEmpty(raw.display_recommendation),
    fieldOrEmpty(raw.recommendation),
    fieldOrEmpty(raw.description),
  );
  const technicalCandidate = firstNonEmpty(
    fieldOrEmpty(raw.technical_recommendation),
    fieldOrEmpty(raw.recommendation),
  );
  const technical = technicalCandidate && technicalCandidate !== summary ? technicalCandidate : '';

  const evidence = isRecord(raw.evidence) ? raw.evidence : {};
  const matchedCard = matchEvidenceImage({ result_id: raw.result_id, evidence }, cards);

  const screen = firstNonEmpty(
    fieldOrEmpty(raw.evidence_screen_url),
    fieldOrEmpty(raw.evidence_screen_title),
    fieldOrEmpty(raw.visual_screen),
    fieldOrEmpty(matchedCard?.screen_url),
    fieldOrEmpty(matchedCard?.screen_title),
    stringList(evidence.affected_urls ?? evidence.screens_checked ?? evidence.url)[0] ?? '',
    stringList(evidence.screen_titles)[0] ?? '',
  );

  const selector = firstNonEmpty(
    fieldOrEmpty(raw.evidence_selector),
    fieldOrEmpty(raw.visual_selector),
    firstInventorySelector(evidence),
    stringList(evidence.target_selectors)[0] ?? '',
  ) || 'Not captured';

  const isValidateFirst = kind === 'gap' && mode === 'validate_first';
  const expectation = firstNonEmpty(
    fieldOrEmpty(raw.evidence_expectation),
    isValidateFirst
      ? 'Confirm existing coverage and product scope before implementation.'
      : fieldOrEmpty(raw.recommendation),
  );

  const imageDataUri = firstNonEmpty(fieldOrEmpty(raw.evidence_image_data_uri), fieldOrEmpty(matchedCard?.image_data_uri));

  const modeLabel = mode === 'validate_first' ? 'Validate first' : mode === 'implement' ? 'Implement' : '';
  const meta = kind === 'gap' ? [modeLabel, screen].filter(Boolean).join(' \u00b7 ') : category;

  const observed = raw.observed === true;
  const partial = raw.partial === true;
  const passedCheck = (kind === 'gap' && observed) || /passed/i.test(category);

  return {
    key,
    kind,
    title,
    severity,
    severityRank,
    meta,
    mode,
    summary,
    technical,
    prompt: fieldOrEmpty(raw.developer_prompt),
    screen,
    selector,
    expectation,
    imageDataUri,
    observed,
    partial,
    passedCheck,
  };
}

function compareFindingRows(a: FindingRow, b: FindingRow): number {
  if (b.severityRank !== a.severityRank) return b.severityRank - a.severityRank;
  if (KIND_SORT_ORDER[a.kind] !== KIND_SORT_ORDER[b.kind]) return KIND_SORT_ORDER[a.kind] - KIND_SORT_ORDER[b.kind];
  return a.title.localeCompare(b.title);
}

/**
 * Handles all three report JSON shapes: the worker's own session payload,
 * the PHP-rebuilt session payload, and the PHP final payload. `gapRows()`
 * (from `reports.ts`) already picks `feature_gaps` or `missing_features`,
 * whichever the shape carries, so gaps only need to be read once here.
 * Rows are deduped by their underlying `smoke_ux_issues` / `smoke_feature_gaps`
 * id, since the final payload repeats the same row across `quick_wins`,
 * `missing_features`, `old_ui`, and `top_issues_with_visual_evidence`.
 */
export function collectFindings(report: ReportJson | null): FindingRow[] {
  if (!report) return [];
  const cards = Array.isArray(report.screenshot_cards) ? report.screenshot_cards : [];
  const byKey = new Map<string, FindingRow>();

  const addRow = (raw: RawFinding, kind: FindingKind, arrayName: string, index: number) => {
    const bucket: 'ux' | 'gap' = kind === 'gap' ? 'gap' : 'ux';
    const key = rowKey(bucket, raw.id, arrayName, index);
    if (byKey.has(key)) return;
    byKey.set(key, buildFindingRow(raw, kind, cards, key));
  };

  asRecordArray(report.ux_issues).forEach((raw, i) => addRow(raw, 'ux', 'ux_issues', i));
  asRecordArray(gapRows(report)).forEach((raw, i) => addRow(raw, 'gap', 'gap_rows', i));
  asRecordArray(report.top_issues_with_visual_evidence).forEach((raw, i) => {
    const kind: FindingKind = fieldOrEmpty(raw.finding_type) === 'Missing feature' ? 'gap' : 'ux';
    addRow(raw, kind, 'top_issues_with_visual_evidence', i);
  });
  asRecordArray(report.quick_wins).forEach((raw, i) => addRow(raw, 'quick_win', 'quick_wins', i));
  asRecordArray(report.old_ui).forEach((raw, i) => addRow(raw, 'ux', 'old_ui', i));

  return [...byKey.values()].sort(compareFindingRows);
}

export function facetCounts(rows: FindingRow[]): FindingFacetCounts {
  const counts: FindingFacetCounts = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    suggestion: 0,
    validateFirst: 0,
    implement: 0,
    total: 0,
  };
  for (const row of rows) {
    if (row.passedCheck) continue;
    counts.total += 1;
    if (row.severity in SEVERITY_RANK) {
      (counts as Record<string, number>)[row.severity] += 1;
    }
    if (row.mode === 'validate_first') counts.validateFirst += 1;
    else if (row.mode === 'implement') counts.implement += 1;
  }
  return counts;
}

/** Rows a reviewer can act on. Passed checks are never defects, so they never appear here. */
export function filterFindings(rows: FindingRow[], filter: FindingsFilter): FindingRow[] {
  const active = rows.filter((row) => !row.passedCheck);
  if (filter.severities.size === 0 && filter.modes.size === 0) return active;
  return active.filter((row) => {
    const severityOk = filter.severities.size === 0 || filter.severities.has(row.severity);
    const modeOk = filter.modes.size === 0 || (row.mode != null && filter.modes.has(row.mode));
    return severityOk && modeOk;
  });
}

/** Findings that validated existing coverage rather than flagging a defect (e.g. an observed feature gap). */
export function passedCheckRows(rows: FindingRow[]): FindingRow[] {
  return rows.filter((row) => row.passedCheck);
}

/**
 * Both builders compute `severity_summary` from the full run, while the final
 * payload's finding arrays are capped (50 missing features, 20 quick wins, 12
 * top issues). Comparing this against the rows actually collected surfaces
 * that truncation instead of silently under-reporting.
 */
export function severitySummaryTotal(report: ReportJson | null): number {
  const summary = report?.severity_summary;
  if (!summary || typeof summary !== 'object') return 0;
  let total = 0;
  for (const value of Object.values(summary)) {
    if (typeof value === 'number' && Number.isFinite(value)) total += value;
  }
  return total;
}
