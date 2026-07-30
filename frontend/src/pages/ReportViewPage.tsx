import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { CopyButton } from '@/components/CopyButton';
import { FindingFilterChips } from '@/components/FindingFilterChips';
import { ReportFindings } from '@/components/ReportFindings';
import { ReportPrompts } from '@/components/ReportPrompts';
import { asReportJson, extractPromptPack } from '@/lib/reports';
import { collectFindings, facetCounts, severitySummaryTotal } from '@/lib/reportFindings';
import { useFindingsView } from '@/lib/useFindingsView';

type ReportMeta = {
  id: number;
  title: string;
  kind: string;
  run_id?: number | null;
  session_id?: number | null;
  html_path?: string | null;
  maturity_score?: number | null;
  ux_score?: number | null;
};

type Tab = 'findings' | 'prompts' | 'html';

function errorText(err: unknown): string {
  const status = (err as { response?: { status?: number } })?.response?.status;
  if (status === 404) {
    return 'The report file is missing on the server, and there was not enough recorded evidence to rebuild it.';
  }
  if (status === 401 || status === 403) {
    return 'Your session is not authorised to read this report. Sign in again and retry.';
  }
  return (err as Error)?.message || 'The report could not be loaded.';
}

/**
 * A whole report on its own route, so "Open report" produces a real, reloadable
 * page with proper loading and failure states.
 */
export function ReportViewPage() {
  const { id } = useParams();
  const reportId = Number(id);
  const [tab, setTab] = useState<Tab>('findings');
  const { filter, view, hasActiveFilter, setView, toggleSeverity, toggleMode, clearFilter } = useFindingsView();

  const metaQ = useQuery<ReportMeta | null>({
    queryKey: ['report-meta', reportId],
    queryFn: async () => {
      const res = await api.get<{ data: ReportMeta }>(`/reports/${reportId}`);
      return res.data?.data ?? null;
    },
    enabled: reportId > 0,
  });

  const jsonQ = useQuery({
    queryKey: ['report-json', reportId],
    queryFn: async () => asReportJson((await api.get(`/reports/${reportId}/json`)).data),
    enabled: reportId > 0,
  });

  // The HTML document embeds the same base64 screenshots the JSON already
  // carries, so it is only fetched once the reviewer actually opens that tab.
  const htmlQ = useQuery({
    queryKey: ['report-html', reportId],
    queryFn: async () =>
      (await api.get(`/reports/${reportId}/html`, { responseType: 'text' })).data as string,
    enabled: reportId > 0 && tab === 'html',
    retry: false,
  });

  const report = jsonQ.data ?? null;
  const rows = useMemo(() => collectFindings(report), [report]);
  const counts = useMemo(() => facetCounts(rows), [rows]);
  const sevTotal = useMemo(() => severitySummaryTotal(report), [report]);
  const pack = extractPromptPack(report);
  const meta = metaQ.data ?? null;
  const runId = Number(meta?.run_id ?? 0);
  const sessionId = Number(meta?.session_id ?? 0);
  const status = String(report?.status ?? '');
  const blocked = status === 'blocked';
  const partial = status === 'partial';

  function jumpToFindings() {
    setTab('findings');
  }

  if (!(reportId > 0)) {
    return (
      <div className="p-6 text-sm text-red-700">
        Not a valid report id. <Link className="text-brand-700 underline" to="/reports">Back to reports</Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-7rem)] gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to="/reports" className="text-xs text-brand-700 hover:underline">
            ← Back to reports
          </Link>
          <h1 className="text-xl font-semibold truncate">
            {meta?.title ?? `Report #${reportId}`}
          </h1>
          <div className="mt-1">
            <FindingFilterChips
              kind={meta?.kind ?? null}
              counts={counts}
              filter={filter}
              onToggleSeverity={toggleSeverity}
              onToggleMode={toggleMode}
              onClear={clearFilter}
              onChipActivated={jumpToFindings}
            />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <CopyButton
            text={pack}
            label="Copy all for Cursor"
            copiedLabel="Copied all"
            className="btn-secondary text-xs py-1 px-2"
            title={pack ? 'Copy every prompt in this report' : 'This report has no prompts'}
          />
          {runId > 0 && sessionId > 0 && (
            <Link to={`/runs/${runId}/sessions/${sessionId}`} className="btn-secondary text-xs py-1 px-2 inline-block">
              Session log
            </Link>
          )}
          {runId > 0 && (
            <Link to={`/runs/${runId}`} className="btn-secondary text-xs py-1 px-2 inline-block">
              Run detail
            </Link>
          )}
        </div>
      </div>

      {blocked && (
        <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          This session covered nothing{report?.coverage_reason ? `: ${report.coverage_reason}` : ''}. The
          findings below are incomplete.
        </div>
      )}
      {partial && (
        <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          This session saw in-scope screens but did not finish cleanly
          {report?.coverage_reason ? `: ${report.coverage_reason}` : ''}. Treat the findings below as incomplete.
        </div>
      )}

      <div className="card overflow-hidden flex flex-col flex-1 min-h-0">
        <div className="flex gap-1 px-3 pt-2 border-b border-ink-200 shrink-0">
          {([
            ['findings', 'Findings'],
            ['prompts', 'Cursor prompts'],
            ['html', 'Full report (HTML)'],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={
                'text-xs px-3 py-1.5 rounded-t border-b-2 ' +
                (tab === key
                  ? 'border-brand-500 text-brand-700 font-medium'
                  : 'border-transparent text-ink-500 hover:text-ink-800')
              }
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'findings' && (
          <div className="flex-1 min-h-0 flex flex-col">
            <ReportFindings
              rows={rows}
              loading={jsonQ.isLoading}
              filter={filter}
              view={view}
              onViewChange={setView}
              onClearFilter={clearFilter}
              severitySummaryTotal={sevTotal}
            />
          </div>
        )}

        {tab === 'prompts' && (
          <div className="flex-1 min-h-0 overflow-auto">
            <ReportPrompts report={report} loading={jsonQ.isLoading} filter={hasActiveFilter ? filter : undefined} />
          </div>
        )}

        {tab === 'html' && (
          <div className="flex-1 min-h-0 flex flex-col">
            {htmlQ.isLoading && (
              <div className="grid place-items-center flex-1 text-sm text-ink-500">Loading report…</div>
            )}
            {htmlQ.isError && (
              <div className="grid place-items-center flex-1 px-6 text-center text-sm text-red-700">
                {errorText(htmlQ.error)}
              </div>
            )}
            {htmlQ.data && (
              <iframe
                title="report"
                className="flex-1 w-full bg-white"
                // The report is generated from the observed product's own text, so
                // it is rendered without scripts or same-origin access. Only
                // user-initiated top-level navigation is allowed, which is what
                // the report's own cross-links need.
                sandbox="allow-top-navigation-by-user-activation"
                srcDoc={htmlQ.data}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
