import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

type Report = { id: number; title: string; kind: string; product_name: string; environment: string; run_code: string; maturity_score: number; ux_score: number; created_at: string };

export function ReportsPage() {
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [active, setActive] = useState<number | null>(null);

  const { data } = useQuery<{ data: Report[] }>({
    queryKey: ['reports', filters],
    queryFn: async () => (await api.get('/reports', { params: filters })).data,
  });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 h-[calc(100vh-8rem)]">
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
          {(data?.data ?? []).map((r) => (
            <li key={r.id} className={'p-3 cursor-pointer hover:bg-ink-50 ' + (active === r.id ? 'bg-brand-50' : '')} onClick={() => setActive(r.id)}>
              <div className="font-medium text-sm">{r.title}</div>
              <div className="text-xs text-ink-500 font-mono">{r.run_code}</div>
              <div className="flex gap-2 mt-1 text-[11px]">
                <span className="badge-neutral">{r.kind}</span>
                <span className="badge-brand">UX {Number(r.ux_score ?? 0).toFixed(0)}</span>
                <span className="badge-info">Maturity {Number(r.maturity_score ?? 0).toFixed(0)}</span>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="lg:col-span-2 card overflow-hidden flex flex-col">
        {active ? (
          <iframe title="report" className="flex-1 w-full" sandbox="allow-same-origin" src={`/api/v1/reports/${active}/html`} />
        ) : (
          <div className="grid place-items-center flex-1 text-ink-500 text-sm">Select a report to preview.</div>
        )}
      </div>
    </div>
  );
}
