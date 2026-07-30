import { api } from './api';

/** Defensive shape for GET /reports/{id}/json — older reports omit many fields. */
export type ReportJson = {
  severity_summary?: Partial<Record<'critical' | 'high' | 'medium' | 'low' | 'suggestion', number>> | null;
  ux_issues?: Array<{ title?: string | null; severity?: string | null; developer_prompt?: string | null }> | null;
  feature_gaps?: Array<{
    expected_feature?: string | null;
    severity?: string | null;
    mode?: string | null;
    developer_prompt?: string | null;
  }> | null;
  missing_features?: Array<{ mode?: string | null }> | null;
  cursor_prompts?: string | null;
  cursor_prompts_path?: string | null;
  cursor_quick_wins?: Array<{
    title?: string | null;
    developer_prompt?: string | null;
    severity?: string | null;
    mode?: string | null;
  }> | null;
  status?: string | null;
  coverage_reason?: string | null;
  [key: string]: unknown;
};

export type ReportSummary = {
  critical: number;
  high: number;
  validateFirst: number;
  implement: number;
};

/** One finding's Cursor prompt, ready to hand to a developer. */
export type PromptRow = {
  key: string;
  title: string;
  group: 'UX issue' | 'Feature gap' | 'Quick win';
  meta: string;
  prompt: string;
  /** Lowercase severity, when the source finding carries one -- lets the prompts tab honour the findings filter. */
  severity: string;
  /** Only feature gaps carry a mode; other groups are null. */
  mode: 'validate_first' | 'implement' | null;
};

/**
 * A score the backend never computed comes back as null, and rendering that as
 * 0 makes an unmeasured report look like a failing one. Postgres NUMERIC
 * arrives as a string, so the value is parsed rather than trusted.
 */
export function scoreLabel(value: number | string | null | undefined, digits = 0): string {
  if (value === null || value === undefined || value === '') return '—';
  const score = Number(value);
  return Number.isFinite(score) ? score.toFixed(digits) : '—';
}

export const UNSCORED_HINT = 'Not scored: this report observed no screens.';

/**
 * The report opens as a normal app route in a new tab rather than a blob URL.
 * A blob tab has no address of its own, cannot be reloaded or shared, and shows
 * an empty page whenever the browser declines to navigate it — which is what it
 * had been doing. A route carries its own loading and error states instead.
 */
export function reportViewPath(id: number): string {
  return `/reports/${id}/view`;
}

export function openReportTab(id: number): void {
  window.open(reportViewPath(id), '_blank', 'noopener');
}

export function asReportJson(value: unknown): ReportJson | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as ReportJson;
  }
  return null;
}

function countBySeverity(
  issues: Array<{ severity?: string | null }> | null | undefined,
  severity: string,
): number {
  if (!Array.isArray(issues)) return 0;
  const needle = severity.toLowerCase();
  return issues.filter((i) => String(i?.severity ?? '').toLowerCase() === needle).length;
}

export function gapRows(payload: ReportJson | null): Array<{ mode?: string | null }> {
  if (!payload) return [];
  if (Array.isArray(payload.feature_gaps)) return payload.feature_gaps;
  if (Array.isArray(payload.missing_features)) return payload.missing_features;
  return [];
}

export function deriveSummary(payload: ReportJson | null): ReportSummary {
  const sev = payload?.severity_summary ?? null;
  const critical =
    typeof sev?.critical === 'number' ? sev.critical : countBySeverity(payload?.ux_issues, 'critical');
  const high =
    typeof sev?.high === 'number' ? sev.high : countBySeverity(payload?.ux_issues, 'high');

  let validateFirst = 0;
  let implement = 0;
  for (const g of gapRows(payload)) {
    const mode = String(g?.mode ?? '').toLowerCase();
    if (mode === 'validate_first') validateFirst += 1;
    else if (mode === 'implement') implement += 1;
  }

  return { critical, high, validateFirst, implement };
}

/**
 * The server-rendered master prompt (GET /reports/{id}/prompt-pack): every
 * finding wrapped in the verify-before-implement contract, grouped by trust,
 * rebuilt server-side if the stored report predates that format. Prefer this
 * over extractPromptPack so download/copy/on-disk text cannot diverge; that
 * function remains only as a client-side fallback when the endpoint fails.
 */
export async function fetchMasterPrompt(id: number): Promise<string> {
  const res = await api.get(`/reports/${id}/prompt-pack`, { responseType: 'text' });
  return typeof res.data === 'string' ? res.data : String(res.data ?? '');
}

/** Legacy fallback: session cursor_prompts string, or joined cursor_quick_wins developer_prompt rows. */
export function extractPromptPack(payload: ReportJson | null): string {
  if (!payload) return '';
  const direct = String(payload.cursor_prompts ?? '').trim();
  if (direct) return direct;

  return promptRows(payload).map((row) => row.prompt).join('\n\n---\n\n');
}

/**
 * Every finding that carries a Cursor prompt, so each can be copied on its own
 * instead of only as one pack.
 */
export function promptRows(payload: ReportJson | null): PromptRow[] {
  if (!payload) return [];
  const rows: PromptRow[] = [];

  const ux = Array.isArray(payload.ux_issues) ? payload.ux_issues : [];
  ux.forEach((issue, i) => {
    const prompt = String(issue?.developer_prompt ?? '').trim();
    if (!prompt) return;
    rows.push({
      key: `ux-${i}`,
      title: String(issue?.title ?? '').trim() || `UX issue ${i + 1}`,
      group: 'UX issue',
      meta: String(issue?.severity ?? '').trim(),
      prompt,
      severity: String(issue?.severity ?? '').trim().toLowerCase(),
      mode: null,
    });
  });

  const gaps = Array.isArray(payload.feature_gaps) ? payload.feature_gaps : [];
  gaps.forEach((gap, i) => {
    const prompt = String(gap?.developer_prompt ?? '').trim();
    if (!prompt) return;
    const mode = String(gap?.mode ?? '').trim().toLowerCase();
    rows.push({
      key: `gap-${i}`,
      title: String(gap?.expected_feature ?? '').trim() || `Feature gap ${i + 1}`,
      group: 'Feature gap',
      meta: [gap?.severity, mode === 'validate_first' ? 'validate first' : mode]
        .map((part) => String(part ?? '').trim())
        .filter(Boolean)
        .join(' · '),
      prompt,
      severity: String(gap?.severity ?? '').trim().toLowerCase(),
      mode: mode === 'validate_first' || mode === 'implement' ? mode : null,
    });
  });

  const wins = Array.isArray(payload.cursor_quick_wins) ? payload.cursor_quick_wins : [];
  wins.forEach((win, i) => {
    const prompt = String(win?.developer_prompt ?? '').trim();
    if (!prompt) return;
    const mode = String(win?.mode ?? '').trim().toLowerCase();
    rows.push({
      key: `win-${i}`,
      title: String(win?.title ?? '').trim() || `Quick win ${i + 1}`,
      group: 'Quick win',
      meta: '',
      prompt,
      severity: String(win?.severity ?? '').trim().toLowerCase(),
      mode: mode === 'validate_first' || mode === 'implement' ? mode : null,
    });
  });

  return rows;
}
