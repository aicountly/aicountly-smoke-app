import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useState } from 'react';
import { api } from '@/lib/api';
import { SAAS_PRODUCTS } from '@/lib/products';

type Run = {
  id: number;
  run_code: string;
  product_name: string;
  environment: string;
  status: string;
  sessions_total: number;
  sessions_done: number;
  sessions_failed: number;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
};

export function RunsPage() {
  const [filters, setFilters] = useState<Record<string, string>>({});
  const { data } = useQuery<{ data: Run[] }>({
    queryKey: ['runs', filters],
    queryFn: async () => (await api.get('/runs', { params: filters })).data,
    refetchInterval: 3000,
  });

  function setF(k: string, v: string) {
    setFilters((f) => ({ ...f, [k]: v }));
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Observation Runs</h1>
        <p className="text-sm text-ink-500">Sequential per-session execution. Each session produces its own report; the run finalises into a consolidated report.</p>
      </div>

      <div className="card p-3 flex flex-wrap gap-3 items-end">
        <div><label className="label">Run Code</label><input className="input" value={filters.run_code ?? ''} onChange={(e) => setF('run_code', e.target.value)} /></div>
        <div>
          <label className="label">Product</label>
          <select className="input" value={filters.product_name ?? ''} onChange={(e) => setF('product_name', e.target.value)}>
            <option value="">All</option>
            {SAAS_PRODUCTS.map((p) => <option key={p.slug} value={p.slug}>{p.label}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Environment</label>
          <select className="input" value={filters.environment ?? ''} onChange={(e) => setF('environment', e.target.value)}>
            <option value="">All</option>
            <option value="sandbox">Sandbox</option>
            <option value="gh_staging">GH / Staging</option>
            <option value="production_readonly">Production R/O</option>
            <option value="production_restricted">Production Restricted</option>
          </select>
        </div>
        <div>
          <label className="label">Status</label>
          <select className="input" value={filters.status ?? ''} onChange={(e) => setF('status', e.target.value)}>
            <option value="">All</option>
            <option value="queued">Queued</option>
            <option value="running">Running</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-ink-600 text-left">
            <tr>
              <th className="px-4 py-2">Run Code</th>
              <th>Product</th>
              <th>Environment</th>
              <th>Status</th>
              <th>Progress</th>
              <th>Started</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(data?.data ?? []).map((r) => (
              <tr key={r.id} className="border-t border-ink-200">
                <td className="px-4 py-2 font-mono">{r.run_code}</td>
                <td>{r.product_name}</td>
                <td>
                  <span className={'badge-' + (r.environment.startsWith('production') ? 'danger' : 'brand')}>{r.environment}</span>
                </td>
                <td><span className={'badge-' + statusBadge(r.status)}>{r.status}</span></td>
                <td>
                  <div className="w-32 h-2 bg-ink-100 rounded-full overflow-hidden">
                    <div className="h-full bg-brand-500" style={{ width: pct(r) + '%' }} />
                  </div>
                  <div className="text-[11px] text-ink-500">{r.sessions_done}/{r.sessions_total} done, {r.sessions_failed} failed</div>
                </td>
                <td className="text-xs">{r.started_at ?? '—'}</td>
                <td className="pr-4 text-right"><Link className="btn-secondary" to={`/runs/${r.id}`}>Open</Link></td>
              </tr>
            ))}
            {(data?.data?.length ?? 0) === 0 && (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-ink-500">No runs.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function pct(r: Run): number {
  if (!r.sessions_total) return 0;
  return Math.round(((r.sessions_done + r.sessions_failed) / r.sessions_total) * 100);
}
function statusBadge(s: string): string {
  if (s === 'running') return 'info';
  if (s === 'failed') return 'danger';
  if (s === 'cancelled') return 'warning';
  if (s === 'completed') return 'brand';
  return 'neutral';
}
