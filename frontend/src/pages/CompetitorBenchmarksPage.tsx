import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

type Competitor = {
  id: number;
  product_name: string;
  competitor_name: string;
  feature_list_json: string | string[];
  source_url: string | null;
  enabled: boolean;
};

export function CompetitorBenchmarksPage() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState('');
  const { data } = useQuery<{ data: Competitor[] }>({
    queryKey: ['competitors', filter],
    queryFn: async () => (await api.get('/competitors', { params: filter ? { product_name: filter } : {} })).data,
  });

  const [edit, setEdit] = useState<Partial<Competitor> & { features?: string }>({});
  const save = useMutation({
    mutationFn: async () => {
      const body = {
        product_name: edit.product_name,
        competitor_name: edit.competitor_name,
        source_url: edit.source_url,
        enabled: edit.enabled ?? true,
        features: (edit.features ?? '').split('\n').map((s) => s.trim()).filter(Boolean),
      };
      if (edit.id) return (await api.put(`/competitors/${edit.id}`, body)).data;
      return (await api.post('/competitors', body)).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['competitors'] });
      setEdit({});
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Competitor Benchmarks</h1>
          <p className="text-sm text-ink-500">Configurable per-product feature lists used by the Feature Gap engine.</p>
        </div>
        <div>
          <label className="label">Filter by product</label>
          <input className="input" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="books, hrms, ..." />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="card p-4 lg:col-span-2 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="text-ink-500 text-left">
              <tr><th>Product</th><th>Competitor</th><th>Features</th><th>Enabled</th><th /></tr>
            </thead>
            <tbody>
              {(data?.data ?? []).map((c) => {
                const list = Array.isArray(c.feature_list_json) ? c.feature_list_json : (() => { try { return JSON.parse(c.feature_list_json as string) as string[]; } catch { return []; } })();
                return (
                  <tr key={c.id} className="border-t border-ink-200">
                    <td>{c.product_name}</td>
                    <td className="font-medium">{c.competitor_name}</td>
                    <td className="text-xs text-ink-500">{list.length} features</td>
                    <td>{c.enabled ? 'yes' : 'no'}</td>
                    <td><button className="btn-secondary" onClick={() => setEdit({ ...c, features: list.join('\n') })}>Edit</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="card p-4">
          <div className="font-semibold mb-3">{edit.id ? `Edit #${edit.id}` : 'Add competitor'}</div>
          <div className="space-y-2">
            <input className="input" placeholder="product (books, hrms, ...)" value={edit.product_name ?? ''} onChange={(e) => setEdit({ ...edit, product_name: e.target.value })} />
            <input className="input" placeholder="competitor name" value={edit.competitor_name ?? ''} onChange={(e) => setEdit({ ...edit, competitor_name: e.target.value })} />
            <input className="input" placeholder="source URL (optional)" value={edit.source_url ?? ''} onChange={(e) => setEdit({ ...edit, source_url: e.target.value })} />
            <textarea className="input min-h-[160px] font-mono text-xs" placeholder="One feature per line..." value={edit.features ?? ''} onChange={(e) => setEdit({ ...edit, features: e.target.value })} />
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={edit.enabled ?? true} onChange={(e) => setEdit({ ...edit, enabled: e.target.checked })} /> Enabled</label>
            <button className="btn-primary w-full" onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? 'Saving...' : 'Save'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
