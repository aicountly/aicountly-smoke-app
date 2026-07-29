import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { asBool } from '@/lib/bool';

type GapStatus = 'present' | 'partial' | 'missing';
type StatusFilter = 'all' | GapStatus;

type Row = {
  product_name: string;
  expected_feature: string;
  status?: GapStatus | string | null;
  observed_any: boolean | string | number;
  partial_any?: boolean | string | number;
  severity: string;
  run_id?: number | null;
  run_code?: string | null;
};

const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'missing', label: 'Missing' },
  { key: 'partial', label: 'Partial' },
  { key: 'present', label: 'Present' },
];

function resolveStatus(r: Row): GapStatus {
  if (r.status === 'present' || r.status === 'partial' || r.status === 'missing') {
    return r.status;
  }
  if (asBool(r.observed_any)) return 'present';
  if (asBool(r.partial_any)) return 'partial';
  return 'missing';
}

function statusStyles(status: GapStatus): { cell: string; dot: string } {
  if (status === 'present') {
    return { cell: 'border-brand-200 bg-brand-50', dot: 'bg-brand-500' };
  }
  if (status === 'partial') {
    return { cell: 'border-amber-200 bg-amber-50', dot: 'bg-amber-500' };
  }
  return { cell: 'border-red-200 bg-red-50', dot: 'bg-red-500' };
}

function severityBadge(status: GapStatus, severity: string) {
  if (status === 'missing') {
    return <span className="badge-danger">{severity}</span>;
  }
  if (status === 'partial') {
    return <span className="badge-warning">{severity}</span>;
  }
  return null;
}

export function FeatureGapMatrixPage() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const { data, isLoading, isError } = useQuery<{ data: Row[] }>({
    queryKey: ['feature-gap-matrix'],
    queryFn: async () => (await api.get('/feature-gap-matrix')).data,
  });

  const allRows = data?.data ?? [];
  const grouped: Record<string, Row[]> = {};
  for (const r of allRows) {
    const status = resolveStatus(r);
    if (statusFilter !== 'all' && status !== statusFilter) continue;
    grouped[r.product_name] ??= [];
    grouped[r.product_name].push(r);
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Feature Gap Matrix</h1>
        <p className="text-sm text-ink-500">Based on the latest completed run per product.</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={
                'rounded-md border px-2.5 py-1 text-xs font-medium transition ' +
                (statusFilter === f.key
                  ? 'border-brand-300 bg-brand-50 text-brand-800'
                  : 'border-ink-200 bg-white text-ink-700 hover:bg-ink-50')
              }
              onClick={() => setStatusFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-ink-600">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-brand-500" /> Present
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-amber-500" /> Partial
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-red-500" /> Missing
          </span>
        </div>
      </div>

      {isLoading && (
        <div className="card p-6 text-center text-ink-500 text-sm">Loading feature gap data...</div>
      )}
      {isError && (
        <div className="card p-6 text-center text-red-700 text-sm">Failed to load feature gap matrix.</div>
      )}
      {!isLoading && !isError && Object.entries(grouped).map(([product, rows]) => {
        const runCode = rows.find((r) => r.run_code)?.run_code ?? null;
        return (
          <div key={product} className="card p-4">
            <div className="mb-2 flex flex-wrap items-baseline gap-2">
              <span className="font-semibold">{product}</span>
              {runCode && <span className="text-xs font-normal text-ink-500">{runCode}</span>}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
              {rows.map((r, i) => {
                const status = resolveStatus(r);
                const styles = statusStyles(status);
                return (
                  <div key={i} className={'flex items-center gap-2 p-2 border rounded-md ' + styles.cell}>
                    <span className={'w-2 h-2 rounded-full ' + styles.dot} />
                    <span className="text-sm flex-1">{r.expected_feature}</span>
                    {severityBadge(status, r.severity)}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      {!isLoading && !isError && allRows.length === 0 && (
        <div className="card p-6 text-center text-ink-500 text-sm">No feature gap data yet. Complete an observation run to populate the matrix.</div>
      )}
      {!isLoading && !isError && allRows.length > 0 && Object.keys(grouped).length === 0 && (
        <div className="card p-6 text-center text-ink-500 text-sm">No features match this filter.</div>
      )}
    </div>
  );
}
