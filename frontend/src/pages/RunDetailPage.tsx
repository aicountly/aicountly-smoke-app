import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

type RunDetail = {
  data: { id: number; run_code: string; product_name: string; environment: string; status: string; reports_dir: string };
  sessions: Array<{ id: number; ordinal: number; name: string; status: string; job_status: string | null; attempts: number; last_error: string | null }>;
  reports: Array<{ id: number; kind: string; title: string; html_path: string; ux_score: number; maturity_score: number; auditor_visible: boolean }>;
};

export function RunDetailPage() {
  const { id } = useParams();
  const runId = Number(id);
  const { data } = useQuery<RunDetail>({
    queryKey: ['run', runId],
    queryFn: async () => (await api.get(`/runs/${runId}`)).data,
    refetchInterval: 3000,
  });

  if (!data) return <div className="text-sm text-ink-500">Loading...</div>;

  return (
    <div className="space-y-4 max-w-5xl">
      <div>
        <h1 className="text-xl font-semibold font-mono">{data.data.run_code}</h1>
        <p className="text-sm text-ink-500">
          {data.data.product_name} &middot; {data.data.environment} &middot; <span className="badge-brand">{data.data.status}</span>
        </p>
      </div>

      <div className="card overflow-hidden">
        <div className="px-4 py-2 bg-ink-50 text-ink-600 text-sm font-semibold">Sessions</div>
        <table className="w-full text-sm">
          <thead className="text-ink-500 text-left text-xs">
            <tr><th className="px-4 py-1">#</th><th>Name</th><th>Status</th><th>Job</th><th>Attempts</th><th>Last error</th></tr>
          </thead>
          <tbody>
            {data.sessions.map((s) => (
              <tr key={s.id} className="border-t border-ink-200">
                <td className="px-4 py-2">{s.ordinal}</td>
                <td>{s.name}</td>
                <td><span className="badge-neutral">{s.status}</span></td>
                <td><span className="badge-neutral">{s.job_status ?? '—'}</span></td>
                <td>{s.attempts}</td>
                <td className="text-xs text-red-700 truncate max-w-xs">{s.last_error ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card overflow-hidden">
        <div className="px-4 py-2 bg-ink-50 text-ink-600 text-sm font-semibold">Reports</div>
        <ul className="divide-y divide-ink-200">
          {data.reports.map((r) => (
            <li key={r.id} className="px-4 py-2 flex justify-between items-center">
              <div>
                <div className="font-medium">{r.title}</div>
                <div className="text-xs text-ink-500">kind: {r.kind} &middot; UX {r.ux_score} &middot; maturity {r.maturity_score}</div>
              </div>
              <div className="flex gap-2">
                <a className="btn-secondary" href={`/api/v1/reports/${r.id}/html`} target="_blank" rel="noreferrer">HTML</a>
                <a className="btn-secondary" href={`/api/v1/reports/${r.id}/json`} target="_blank" rel="noreferrer">JSON</a>
              </div>
            </li>
          ))}
          {data.reports.length === 0 && <li className="px-4 py-3 text-ink-500 text-sm">No reports yet.</li>}
        </ul>
      </div>
    </div>
  );
}
