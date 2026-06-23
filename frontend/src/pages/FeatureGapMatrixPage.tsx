import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

type Row = { product_name: string; expected_feature: string; observed_any: boolean; severity: string };

export function FeatureGapMatrixPage() {
  const { data, isLoading, isError } = useQuery<{ data: Row[] }>({
    queryKey: ['feature-gap-matrix'],
    queryFn: async () => (await api.get('/feature-gap-matrix')).data,
  });

  const grouped: Record<string, Row[]> = {};
  for (const r of data?.data ?? []) {
    grouped[r.product_name] ??= [];
    grouped[r.product_name].push(r);
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Feature Gap Matrix</h1>
        <p className="text-sm text-ink-500">Aggregated across all observation runs.</p>
      </div>
      {isLoading && (
        <div className="card p-6 text-center text-ink-500 text-sm">Loading feature gap data...</div>
      )}
      {isError && (
        <div className="card p-6 text-center text-red-700 text-sm">Failed to load feature gap matrix.</div>
      )}
      {!isLoading && !isError && Object.entries(grouped).map(([product, rows]) => (
        <div key={product} className="card p-4">
          <div className="font-semibold mb-2">{product}</div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
            {rows.map((r, i) => (
              <div key={i} className={'flex items-center gap-2 p-2 border rounded-md ' + (r.observed_any ? 'border-brand-200 bg-brand-50' : 'border-red-200 bg-red-50')}>
                <span className={'w-2 h-2 rounded-full ' + (r.observed_any ? 'bg-brand-500' : 'bg-red-500')} />
                <span className="text-sm flex-1">{r.expected_feature}</span>
                {!r.observed_any && <span className="badge-danger">{r.severity}</span>}
              </div>
            ))}
          </div>
        </div>
      ))}
      {!isLoading && !isError && Object.keys(grouped).length === 0 && (
        <div className="card p-6 text-center text-ink-500 text-sm">No feature gap data yet. Complete an observation run to populate the matrix.</div>
      )}
    </div>
  );
}
