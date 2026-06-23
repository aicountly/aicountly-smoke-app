import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api';

type DashboardSummary = {
  cards: Record<string, number>;
  last_run: { run_code: string; product_name: string; status: string } | null;
  product_scores: Array<{ product_name: string; maturity_avg: number; ux_avg: number; reports: number }>;
  recent_reports: Array<{ id: number; title: string; product_name: string; environment: string; created_at: string; ux_score: number; maturity_score: number }>;
};

const CARDS: Array<{ key: string; label: string }> = [
  { key: 'total_observations', label: 'Total Observations' },
  { key: 'screens_scanned',    label: 'Screens Scanned' },
  { key: 'feature_gaps',       label: 'Feature Gaps' },
  { key: 'ux_issues',          label: 'UX Issues' },
  { key: 'old_theme_pages',    label: 'Old Theme Pages' },
  { key: 'critical_ui_issues', label: 'Critical UI Issues' },
];

export function DashboardPage() {
  const { data } = useQuery<DashboardSummary>({
    queryKey: ['dashboard'],
    queryFn: async () => (await api.get<DashboardSummary>('/dashboard')).data,
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <p className="text-sm text-ink-500">Internal AI-assisted product observer overview.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {CARDS.map((c) => (
          <div className="card p-4" key={c.key}>
            <div className="text-xs text-ink-500">{c.label}</div>
            <div className="text-2xl font-semibold mt-1">{data?.cards?.[c.key] ?? 0}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="card p-4">
          <div className="text-sm font-semibold">Last Observation</div>
          {data?.last_run ? (
            <div className="text-sm mt-2 space-y-1">
              <div className="font-mono">{data.last_run.run_code}</div>
              <div>{data.last_run.product_name} &middot; <span className="badge-brand">{data.last_run.status}</span></div>
              <Link to="/runs" className="btn-secondary mt-2 inline-flex">View runs</Link>
            </div>
          ) : (
            <div className="text-sm text-ink-500 mt-2">No runs yet.</div>
          )}
        </div>

        <div className="card p-4">
          <div className="text-sm font-semibold">Product-wise score</div>
          <table className="w-full text-sm mt-3">
            <thead className="text-ink-500">
              <tr><th className="text-left">Product</th><th>Maturity</th><th>UX</th><th>Reports</th></tr>
            </thead>
            <tbody>
              {(data?.product_scores ?? []).map((p) => (
                <tr key={p.product_name} className="border-t border-ink-200">
                  <td className="py-1">{p.product_name}</td>
                  <td className="text-center">{Number(p.maturity_avg).toFixed(1)}</td>
                  <td className="text-center">{Number(p.ux_avg).toFixed(1)}</td>
                  <td className="text-center">{p.reports}</td>
                </tr>
              ))}
              {(data?.product_scores?.length ?? 0) === 0 && (
                <tr><td colSpan={4} className="py-2 text-ink-500">No reports yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="card p-4">
          <div className="text-sm font-semibold">Recent reports</div>
          <ul className="text-sm mt-2 space-y-2 max-h-64 overflow-auto">
            {(data?.recent_reports ?? []).map((r) => (
              <li key={r.id} className="flex justify-between">
                <Link to={`/reports?id=${r.id}`} className="truncate hover:underline">{r.title}</Link>
                <span className="text-ink-500 text-xs ml-3">{r.product_name}</span>
              </li>
            ))}
            {(data?.recent_reports?.length ?? 0) === 0 && (
              <li className="text-ink-500">No reports yet.</li>
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}
