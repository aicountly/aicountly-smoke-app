import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { CopyButton } from '@/components/CopyButton';
import { FindingFilterChips } from '@/components/FindingFilterChips';
import { ReportFindings } from '@/components/ReportFindings';
import { ReportPrompts } from '@/components/ReportPrompts';
import {
  asReportJson,
  extractPromptPack,
  fetchMasterPrompt,
  openReportTab,
  reportViewPath,
  scoreLabel,
  UNSCORED_HINT,
} from '@/lib/reports';
import { collectFindings, facetCounts, severitySummaryTotal } from '@/lib/reportFindings';
import { useFindingsView } from '@/lib/useFindingsView';

type Report = {
  id: number;
  title: string;
  kind: string;
  product_name: string;
  environment: string;
  run_code: string;
  run_id?: number | null;
  session_id?: number | null;
  /** Null until the report is scored; a run that observed no screens never is. */
  maturity_score: number | string | null;
  ux_score: number | string | null;
  created_at: string;
};

function activeFilters(filters: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(filters).filter(([, v]) => v.trim() !== ''));
}

/**
 * Saves the text as a file. These used to open a blob URL in a new tab, which
 * lands on an empty page whenever the browser declines to navigate one; a
 * download either arrives or reports a failure.
 */
function downloadText(content: string, mime: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function ReportsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [active, setActive] = useState<number | null>(() => {
    const id = searchParams.get('id');
    return id ? Number(id) : null;
  });
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [paneTab, setPaneTab] = useState<'findings' | 'preview' | 'prompts'>('findings');
  const { filter, view, hasActiveFilter, setView, toggleSeverity, toggleMode, clearFilter } = useFindingsView({
    syncUrl: false,
  });

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

  const selectReport = (id: number) => {
    setActive(id);
    setSearchParams({ id: String(id) }, { replace: true });
    setActionMsg(null);
  };

  const { data: reportJson, isLoading: jsonLoading, isError: jsonError } = useQuery({
    queryKey: ['report-json', active],
    queryFn: async () => asReportJson((await api.get(`/reports/${active}/json`)).data),
    enabled: active != null,
  });

  const { data: html, isLoading: htmlLoading, isError: htmlError } = useQuery({
    queryKey: ['report-html', active],
    queryFn: async () => (await api.get(`/reports/${active}/html`, { responseType: 'text' })).data as string,
    enabled: active != null && paneTab === 'preview',
  });

  const findingRows = useMemo(() => collectFindings(reportJson ?? null), [reportJson]);
  const findingCounts = useMemo(() => facetCounts(findingRows), [findingRows]);
  const sevTotal = useMemo(() => severitySummaryTotal(reportJson ?? null), [reportJson]);

  // The server rebuilds old reports into the master-prompt format on demand; if
  // that request fails for any reason, fall back to whatever this browser
  // already has from the JSON payload rather than showing nothing.
  const {
    data: masterPrompt,
    isLoading: masterPromptLoading,
    isError: masterPromptError,
  } = useQuery({
    queryKey: ['report-prompt-pack', active],
    queryFn: () => fetchMasterPrompt(active as number),
    enabled: active != null,
    retry: false,
  });
  const legacyPromptPack = extractPromptPack(reportJson ?? null);
  const promptPack = masterPrompt ?? (masterPromptError ? legacyPromptPack : '');
  const hasPromptPack = promptPack.length > 0;
  const hasJson = reportJson != null;

  function reportSlug(): string {
    return String(activeReport?.run_code ?? active ?? 'report').replace(/[^\w.-]+/g, '-');
  }

  function handleDownloadPromptPack() {
    if (!hasPromptPack) {
      setActionMsg('No prompt pack in this report.');
      return;
    }
    downloadText(promptPack, 'text/markdown;charset=utf-8', `${reportSlug()}.master-cursor-prompt.md`);
    setActionMsg(null);
  }

  function handleDownloadJsonEvidence() {
    if (!hasJson) {
      setActionMsg('JSON evidence is unavailable for this report.');
      return;
    }
    downloadText(JSON.stringify(reportJson, null, 2), 'application/json;charset=utf-8', `${reportSlug()}.report.json`);
    setActionMsg(null);
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
                  <span className="badge-brand">UX {scoreLabel(r.ux_score)}</span>
                  <span
                    className="badge-info"
                    title={r.maturity_score == null ? UNSCORED_HINT : undefined}
                  >
                    Maturity {scoreLabel(r.maturity_score)}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2 mt-2" onClick={(e) => e.stopPropagation()}>
                  <Link
                    to={reportViewPath(r.id)}
                    target="_blank"
                    rel="noopener"
                    className="btn-secondary text-xs py-0.5 px-2 inline-block"
                  >
                    Open report
                  </Link>
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
                      onClick={() => active != null && openReportTab(active)}
                    >
                      Open report
                    </button>
                    {activeSessionLog && (
                      <Link to={activeSessionLog} className="btn-secondary text-xs py-1 px-2 inline-block">
                        Related session log
                      </Link>
                    )}
                    <button
                      type="button"
                      className="btn-secondary text-xs py-1 px-2"
                      onClick={handleDownloadPromptPack}
                      disabled={masterPromptLoading || !hasPromptPack}
                      title={hasPromptPack ? 'Download the master Cursor prompt as Markdown' : 'No prompt pack available'}
                    >
                      Download master prompt
                    </button>
                    <CopyButton
                      text={promptPack}
                      label="Copy master prompt"
                      copiedLabel="Copied"
                      className="btn-secondary text-xs py-1 px-2"
                      disabled={masterPromptLoading || !hasPromptPack}
                      title={hasPromptPack ? 'Copy the master Cursor prompt for this report' : 'No prompts available'}
                    />
                    <button
                      type="button"
                      className="btn-secondary text-xs py-1 px-2"
                      onClick={handleDownloadJsonEvidence}
                      disabled={jsonLoading || !hasJson}
                      title={hasJson ? 'Download the raw JSON evidence' : 'JSON unavailable'}
                    >
                      Download JSON evidence
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
                    <span className="badge-brand">UX {scoreLabel(activeReport.ux_score)}</span>
                    <span
                      className="badge-info"
                      title={activeReport.maturity_score == null ? UNSCORED_HINT : undefined}
                    >
                      Maturity {scoreLabel(activeReport.maturity_score)}
                    </span>
                  </div>
                )}

                {jsonLoading && <p className="text-xs text-ink-500">Loading report summary...</p>}
                {jsonError && (
                  <p className="text-xs text-red-700">Could not load report JSON. Actions and summary may be unavailable.</p>
                )}
                {actionMsg && <p className="text-xs text-amber-800">{actionMsg}</p>}

                {!jsonLoading && !jsonError && (
                  <FindingFilterChips
                    counts={findingCounts}
                    filter={filter}
                    onToggleSeverity={toggleSeverity}
                    onToggleMode={toggleMode}
                    onClear={clearFilter}
                    onChipActivated={() => setPaneTab('findings')}
                  />
                )}
              </div>

              <div className="flex-1 min-h-0 flex flex-col">
                <div className="flex gap-1 px-3 pt-1.5 border-b border-ink-100 shrink-0">
                  {([
                    ['findings', 'Findings'],
                    ['preview', 'HTML preview'],
                    ['prompts', 'Cursor prompts'],
                  ] as const).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      className={
                        'text-[11px] uppercase tracking-wide px-2 py-1 border-b-2 ' +
                        (paneTab === key
                          ? 'border-brand-500 text-brand-700 font-semibold'
                          : 'border-transparent text-ink-500 hover:text-ink-800')
                      }
                      onClick={() => setPaneTab(key)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {paneTab === 'findings' && (
                  <div className="flex-1 min-h-0 flex flex-col">
                    <ReportFindings
                      rows={findingRows}
                      loading={jsonLoading}
                      filter={filter}
                      view={view}
                      onViewChange={setView}
                      onClearFilter={clearFilter}
                      severitySummaryTotal={sevTotal}
                    />
                  </div>
                )}
                {paneTab === 'prompts' && (
                  <div className="flex-1 min-h-0 overflow-auto">
                    <ReportPrompts
                      report={reportJson ?? null}
                      loading={jsonLoading}
                      filter={hasActiveFilter ? filter : undefined}
                    />
                  </div>
                )}
                {paneTab === 'preview' && htmlLoading && (
                  <div className="grid place-items-center flex-1 text-ink-500 text-sm">Loading preview...</div>
                )}
                {paneTab === 'preview' && htmlError && (
                  <div className="grid place-items-center flex-1 text-red-700 text-sm px-4 text-center">
                    Could not load report preview. The report file may be missing on the server.
                  </div>
                )}
                {paneTab === 'preview' && html && (
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
