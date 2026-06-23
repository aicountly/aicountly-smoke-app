import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

type Report = {
  id: number;
  title: string;
  kind: string;
  product_name: string;
  environment: string;
  run_code: string;
  maturity_score: number;
  ux_score: number;
  created_at: string;
};

function activeFilters(filters: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(filters).filter(([, v]) => v.trim() !== ''));
}

export function ReportsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [active, setActive] = useState<number | null>(() => {
    const id = searchParams.get('id');
    return id ? Number(id) : null;
  });

  const { data, isLoading, isError, error } = useQuery<{ data: Report[] }>({
    queryKey: ['reports', filters],
    queryFn: async () => (await api.get('/reports', { params: activeFilters(filters) })).data,
  });

  const reports = data?.data ?? [];

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
  };

  const { data: html, isLoading: htmlLoading, isError: htmlError } = useQuery({
    queryKey: ['report-html', active],
    queryFn: async () => (await api.get(`/reports/${active}/html`, { responseType: 'text' })).data as string,
    enabled: active != null,
  });

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
            {!isLoading && !isError && reports.map((r) => (
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
              </li>
            ))}
            {!isLoading && !isError && reports.length === 0 && (
              <li className="p-6 text-center text-sm text-ink-500 space-y-2">
                <div>No reports yet.</div>
                <div>Complete an observation run to generate session and final reports.</div>
                <Link to="/observations/new" className="btn-primary inline-flex mt-2">Start observation</Link>
              </li>
            )}
          </ul>
        </div>

        <div className="lg:col-span-2 card overflow-hidden flex flex-col">
          {active == null && (
            <div className="grid place-items-center flex-1 text-ink-500 text-sm">Select a report to preview.</div>
          )}
          {active != null && htmlLoading && (
            <div className="grid place-items-center flex-1 text-ink-500 text-sm">Loading preview...</div>
          )}
          {active != null && htmlError && (
            <div className="grid place-items-center flex-1 text-red-700 text-sm px-4 text-center">
              Could not load report preview. The report file may be missing on the server.
            </div>
          )}
          {active != null && html && (
            <iframe title="report" className="flex-1 w-full" sandbox="" srcDoc={html} />
          )}
        </div>
      </div>
    </div>
  );
}
