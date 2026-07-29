import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import { openReport } from '@/lib/reports';

type Report = {
  id: number;
  title: string;
  kind: string;
  product_name: string;
  environment: string;
  run_code: string;
  run_id?: number | null;
  session_id?: number | null;
  maturity_score: number;
  ux_score: number;
  created_at: string;
};

/** Defensive shape for GET /reports/{id}/json — older reports omit many fields. */
type ReportJson = {
  severity_summary?: Partial<Record<'critical' | 'high' | 'medium' | 'low' | 'suggestion', number>> | null;
  ux_issues?: Array<{ severity?: string | null }> | null;
  feature_gaps?: Array<{ mode?: string | null }> | null;
  missing_features?: Array<{ mode?: string | null }> | null;
  cursor_prompts?: string | null;
  cursor_prompts_path?: string | null;
  cursor_quick_wins?: Array<{ developer_prompt?: string | null }> | null;
  [key: string]: unknown;
};

type ReportSummary = {
  critical: number;
  high: number;
  validateFirst: number;
  implement: number;
};

function activeFilters(filters: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(filters).filter(([, v]) => v.trim() !== ''));
}

function asRecord(value: unknown): ReportJson | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as ReportJson;
  }
  return null;
}

function countBySeverity(issues: Array<{ severity?: string | null }> | null | undefined, severity: string): number {
  if (!Array.isArray(issues)) return 0;
  const needle = severity.toLowerCase();
  return issues.filter((i) => String(i?.severity ?? '').toLowerCase() === needle).length;
}

function gapRows(payload: ReportJson | null): Array<{ mode?: string | null }> {
  if (!payload) return [];
  if (Array.isArray(payload.feature_gaps)) return payload.feature_gaps;
  if (Array.isArray(payload.missing_features)) return payload.missing_features;
  return [];
}

function deriveSummary(payload: ReportJson | null): ReportSummary {
  const sev = payload?.severity_summary ?? null;
  const critical =
    typeof sev?.critical === 'number' ? sev.critical : countBySeverity(payload?.ux_issues, 'critical');
  const high =
    typeof sev?.high === 'number' ? sev.high : countBySeverity(payload?.ux_issues, 'high');

  const gaps = gapRows(payload);
  let validateFirst = 0;
  let implement = 0;
  for (const g of gaps) {
    const mode = String(g?.mode ?? '').toLowerCase();
    if (mode === 'validate_first') validateFirst += 1;
    else if (mode === 'implement') implement += 1;
  }

  return { critical, high, validateFirst, implement };
}

/** Session: cursor_prompts string. Final: join cursor_quick_wins developer_prompt rows. */
function extractPromptPack(payload: ReportJson | null): string {
  if (!payload) return '';
  const direct = String(payload.cursor_prompts ?? '').trim();
  if (direct) return direct;

  const wins = Array.isArray(payload.cursor_quick_wins) ? payload.cursor_quick_wins : [];
  const parts = wins
    .map((row) => String(row?.developer_prompt ?? '').trim())
    .filter(Boolean);
  return parts.join('\n\n---\n\n');
}

function openTextBlob(content: string, mime: string, filename: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const opened = window.open(url, '_blank', 'noopener,noreferrer');
  if (!opened) {
    // Popup blocked — fall back to download
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function ReportsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [active, setActive] = useState<number | null>(() => {
    const id = searchParams.get('id');
    return id ? Number(id) : null;
  });
  const [copied, setCopied] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<number | null>(null);
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data, isLoading, isError, error } = useQuery<{ data: Report[] }>({
    queryKey: ['reports', filters],
    queryFn: async () => (await api.get('/reports', { params: activeFilters(filters) })).data,
  });

  const reports = data?.data ?? [];
  const activeReport = reports.find((r) => r.id === active) ?? null;

  useEffect(() => {
    const urlId = searchParams.get('id');
    if (urlId && reports.some((r) => r.id === Number(urlId))) {
      setActive(Number(urlId));
      return;
    }
    if (active != null && reports.some((r) => r.id === active)) {
      return;
    }
    setActive(reports[0]?.id ?? null);
  }, [reports, active, searchParams]);

  useEffect(() => {
    return () => {
      if (copyResetRef.current) clearTimeout(copyResetRef.current);
    };
  }, []);

  const selectReport = (id: number) => {
    setActive(id);
    setSearchParams({ id: String(id) }, { replace: true });
    setCopied(false);
    setActionMsg(null);
  };

  const { data: reportJson, isLoading: jsonLoading, isError: jsonError } = useQuery({
    queryKey: ['report-json', active],
    queryFn: async () => {
      const res = await api.get(`/reports/${active}/json`);
      return asRecord(res.data);
    },
    enabled: active != null,
  });

  const { data: html, isLoading: htmlLoading, isError: htmlError } = useQuery({
    queryKey: ['report-html', active],
    queryFn: async () => (await api.get(`/reports/${active}/html`, { responseType: 'text' })).data as string,
    enabled: active != null,
  });

  const summary = deriveSummary(reportJson ?? null);
  const promptPack = extractPromptPack(reportJson ?? null);
  const hasPromptPack = promptPack.length > 0;
  const hasJson = reportJson != null;

  async function handleCopyQuickWins() {
    if (!hasPromptPack) {
      setActionMsg('No quick-win prompts in this report.');
      return;
    }
    const ok = await copyText(promptPack);
    if (!ok) {
      setActionMsg('Could not copy to clipboard.');
      return;
    }
    setCopied(true);
    setActionMsg(null);
    if (copyResetRef.current) clearTimeout(copyResetRef.current);
    copyResetRef.current = setTimeout(() => setCopied(false), 2000);
  }

  function handleOpenPromptPack() {
    if (!hasPromptPack) {
      setActionMsg('No prompt pack in this report.');
      return;
    }
    const slug = String(activeReport?.run_code ?? active ?? 'report').replace(/[^\w.-]+/g, '-');
    openTextBlob(promptPack, 'text/markdown;charset=utf-8', `${slug}.cursor-prompts.md`);
    setActionMsg(null);
  }

  function handleOpenJsonEvidence() {
    if (!hasJson) {
      setActionMsg('JSON evidence is unavailable for this report.');
      return;
    }
    const pretty = JSON.stringify(reportJson, null, 2);
    const slug = String(activeReport?.run_code ?? active ?? 'report').replace(/[^\w.-]+/g, '-');
    openTextBlob(pretty, 'application/json;charset=utf-8', `${slug}.report.json`);
    setActionMsg(null);
  }

  async function handleOpenReport(id: number) {
    setOpeningId(id);
    setActionMsg(null);
    try {
      await openReport(id, 'html');
    } catch {
      setActionMsg('Could not open the full report. The file may be missing on the server.');
    } finally {
      setOpeningId(null);
    }
  }

  function sessionLogPath(r: Report): string | null {
    const runId = Number(r.run_id ?? 0);
    const sessionId = Number(r.session_id ?? 0);
    if (runId > 0 && sessionId > 0) return `/runs/${runId}/sessions/${sessionId}`;
    return null;
  }

  const activeSessionLog = activeReport ? sessionLogPath(activeReport) : null;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Reports</h1>
        <p className="text-sm text-ink-500">Session and final observation reports from completed runs.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 h-[calc(100vh-11rem)]">
        <div className="card overflow-hidden flex flex-col">
          <div className="p-3 border-b border-ink-200 flex flex-wrap gap-2">
            <select className="input flex-1" value={filters.kind ?? ''} onChange={(e) => setFilters({ ...filters, kind: e.target.value })}>
              <option value="">All kinds</option>
              <option value="session">Session</option>
              <option value="final">Final</option>
            </select>
            <input className="input flex-1" placeholder="product" value={filters.product_name ?? ''} onChange={(e) => setFilters({ ...filters, product_name: e.target.value })} />
          </div>
          <ul className="overflow-auto flex-1 divide-y divide-ink-200">
            {isLoading && (
              <li className="p-4 text-sm text-ink-500">Loading reports...</li>
            )}
            {isError && (
              <li className="p-4 text-sm text-red-700">
                Failed to load reports{(error as Error)?.message ? `: ${(error as Error).message}` : '.'}
              </li>
            )}
            {!isLoading && !isError && reports.map((r) => {
              const logPath = sessionLogPath(r);
              return (
              <li
                key={r.id}
                className={'p-3 cursor-pointer hover:bg-ink-50 ' + (active === r.id ? 'bg-brand-50' : '')}
                onClick={() => selectReport(r.id)}
              >
                <div className="font-medium text-sm">{r.title}</div>
                <div className="text-xs text-ink-500 font-mono">{r.run_code}</div>
                <div className="text-xs text-ink-500">{r.product_name} &middot; {r.environment}</div>
                <div className="flex gap-2 mt-1 text-[11px]">
                  <span className="badge-neutral">{r.kind}</span>
                  <span className="badge-brand">UX {Number(r.ux_score ?? 0).toFixed(0)}</span>
                  <span className="badge-info">Maturity {Number(r.maturity_score ?? 0).toFixed(0)}</span>
                </div>
                <div className="flex flex-wrap gap-2 mt-2" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="btn-secondary text-xs py-0.5 px-2"
                    disabled={openingId === r.id}
                    onClick={() => void handleOpenReport(r.id)}
                  >
                    {openingId === r.id ? 'Opening…' : 'Open report'}
                  </button>
                  {logPath && (
                    <Link to={logPath} className="btn-secondary text-xs py-0.5 px-2 inline-block">
                      Related session log
                    </Link>
                  )}
                </div>
              </li>
              );
            })}
            {!isLoading && !isError && reports.length === 0 && (
              <li className="p-6 text-center text-sm text-ink-500 space-y-2">
                <div>No reports yet.</div>
                <div>Complete an observation run to generate session and final reports.</div>
                <Link to="/observations/new" className="btn-primary inline-flex mt-2">Start observation</Link>
              </li>
            )}
          </ul>
        </div>

        <div className="lg:col-span-2 card overflow-hidden flex flex-col min-h-0">
          {active == null && (
            <div className="grid place-items-center flex-1 text-ink-500 text-sm">Select a report to preview.</div>
          )}
          {active != null && (
            <>
              <div className="p-3 border-b border-ink-200 space-y-3 shrink-0">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-medium text-sm truncate">{activeReport?.title ?? `Report #${active}`}</div>
                    <div className="text-xs text-ink-500 font-mono">{activeReport?.run_code}</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="btn-secondary text-xs py-1 px-2"
                      disabled={openingId === active}
                      onClick={() => active != null && void handleOpenReport(active)}
                    >
                      {openingId === active ? 'Opening…' : 'Open report'}
                    </button>
                    {activeSessionLog && (
                      <Link to={activeSessionLog} className="btn-secondary text-xs py-1 px-2 inline-block">
                        Related session log
                      </Link>
                    )}
                    <button
                      type="button"
                      className="btn-secondary text-xs py-1 px-2"
                      onClick={handleOpenPromptPack}
                      disabled={jsonLoading || !hasPromptPack}
                      title={hasPromptPack ? 'Open Cursor prompt pack' : 'No prompt pack available'}
                    >
                      Open prompt pack
                    </button>
                    <button
                      type="button"
                      className="btn-secondary text-xs py-1 px-2"
                      onClick={() => void handleCopyQuickWins()}
                      disabled={jsonLoading || !hasPromptPack}
                      title={hasPromptPack ? 'Copy quick-win prompts' : 'No quick wins available'}
                    >
                      {copied ? 'Copied' : 'Copy quick wins'}
                    </button>
                    <button
                      type="button"
                      className="btn-secondary text-xs py-1 px-2"
                      onClick={handleOpenJsonEvidence}
                      disabled={jsonLoading || !hasJson}
                      title={hasJson ? 'Open raw JSON evidence' : 'JSON unavailable'}
                    >
                      Open JSON evidence
                    </button>
                  </div>
                </div>

                {activeReport && (
                  <div className="flex flex-wrap gap-2 text-[11px]">
                    {activeReport.product_name ? (
                      <span className="badge-neutral">{activeReport.product_name}</span>
                    ) : null}
                    {activeReport.environment ? (
                      <span className="badge-neutral">{activeReport.environment}</span>
                    ) : null}
                    {activeReport.kind ? (
                      <span className="badge-neutral">{activeReport.kind}</span>
                    ) : null}
                    <span className="badge-brand">UX {Number(activeReport.ux_score ?? 0).toFixed(0)}</span>
                    <span className="badge-info">Maturity {Number(activeReport.maturity_score ?? 0).toFixed(0)}</span>
                  </div>
                )}

                {jsonLoading && <p className="text-xs text-ink-500">Loading report summary...</p>}
                {jsonError && (
                  <p className="text-xs text-red-700">Could not load report JSON. Actions and summary may be unavailable.</p>
                )}
                {actionMsg && <p className="text-xs text-amber-800">{actionMsg}</p>}

                {!jsonLoading && !jsonError && (
                  <div className="flex flex-wrap gap-2 text-[11px]">
                    <span className="badge-danger">Critical {summary.critical}</span>
                    <span className="badge-warning">High {summary.high}</span>
                    <span className="badge-neutral">Validate first {summary.validateFirst}</span>
                    <span className="badge-brand">Implement {summary.implement}</span>
                  </div>
                )}
              </div>

              <div className="flex-1 min-h-0 flex flex-col">
                <div className="px-3 py-1.5 text-[11px] uppercase tracking-wide text-ink-500 border-b border-ink-100 shrink-0">
                  HTML preview
                </div>
                {htmlLoading && (
                  <div className="grid place-items-center flex-1 text-ink-500 text-sm">Loading preview...</div>
                )}
                {htmlError && (
                  <div className="grid place-items-center flex-1 text-red-700 text-sm px-4 text-center">
                    Could not load report preview. The report file may be missing on the server.
                  </div>
                )}
                {html && (
                  <iframe
                    title="report"
                    className="flex-1 w-full min-h-[12rem]"
                    // Reports embed report-ID links (e.g. final report "Open report #N" /
                    // per-session rows) that use target="_top" so they replace the app
                    // shell instead of navigating inside the sandboxed document. A bare
                    // sandbox="" blocks all top-level navigation, so those links are
                    // inert. `allow-top-navigation-by-user-activation` unblocks only
                    // user-gesture-triggered navigation (i.e. an actual click) while
                    // still blocking scripts, popups, same-origin access, and any
                    // script-driven auto-navigation from the untrusted report HTML.
                    sandbox="allow-top-navigation-by-user-activation"
                    srcDoc={html}
                  />
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
