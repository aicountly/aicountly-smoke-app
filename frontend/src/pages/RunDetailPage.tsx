import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { openReport } from '@/lib/reports';

type RunLog = {
  id: number;
  source: string;
  level: string;
  message: string;
  created_at: string;
};

type RunDetail = {
  data: {
    id: number;
    run_code: string;
    product_name: string;
    environment: string;
    status: string;
    sessions_total: number;
    sessions_done: number;
    sessions_failed: number;
    reports_dir: string;
  };
  sessions: Array<{
    id: number;
    ordinal: number;
    name: string;
    status: string;
    job_status: string | null;
    attempts: number;
    last_error: string | null;
    leased_by: string | null;
  }>;
  reports: Array<{ id: number; kind: string; title: string; html_path: string; ux_score: number; maturity_score: number; auditor_visible: boolean }>;
  worker: { online: boolean; queued_jobs: number; active_leases: number; last_seen_at: string | null; message: string };
};

function logLevelClass(level: string): string {
  if (level === 'error') return 'text-red-400';
  if (level === 'warn') return 'text-amber-300';
  return 'text-emerald-200';
}

export function RunDetailPage() {
  const { id } = useParams();
  const runId = Number(id);
  const logEndRef = useRef<HTMLDivElement>(null);
  const [lastLogId, setLastLogId] = useState(0);
  const [logs, setLogs] = useState<RunLog[]>([]);

  const { data } = useQuery<RunDetail>({
    queryKey: ['run', runId],
    queryFn: async () => (await api.get(`/runs/${runId}`)).data,
    refetchInterval: 3000,
  });

  const logsQuery = useQuery<{ data: RunLog[] }>({
    queryKey: ['run-logs', runId, lastLogId],
    queryFn: async () =>
      (await api.get(`/runs/${runId}/logs`, { params: lastLogId > 0 ? { after_id: lastLogId } : undefined })).data,
    refetchInterval: 2000,
    enabled: runId > 0,
  });

  useEffect(() => {
    const incoming = logsQuery.data?.data ?? [];
    if (incoming.length === 0) return;
    setLogs((prev) => {
      const merged = [...prev];
      for (const row of incoming) {
        if (!merged.some((l) => l.id === row.id)) merged.push(row);
      }
      return merged.sort((a, b) => a.id - b.id);
    });
    const maxId = Math.max(...incoming.map((l) => l.id));
    if (maxId > lastLogId) setLastLogId(maxId);
  }, [logsQuery.data, lastLogId]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs.length]);

  if (!data) return <div className="text-sm text-ink-500">Loading...</div>;

  const showWorkerAlert = !data.worker.online && ['queued', 'running'].includes(data.data.status);

  return (
    <div className="space-y-4 max-w-5xl">
      <div>
        <h1 className="text-xl font-semibold font-mono">{data.data.run_code}</h1>
        <p className="text-sm text-ink-500">
          {data.data.product_name} &middot; {data.data.environment} &middot;{' '}
          <span className="badge-brand">{data.data.status}</span>
          {' '}&middot; {data.data.sessions_done}/{data.data.sessions_total} done
        </p>
      </div>

      {showWorkerAlert && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <div className="font-semibold">Worker offline — jobs will not run until the Playwright worker is started</div>
          <p className="mt-1 text-amber-800">{data.worker.message}</p>
          <pre className="mt-2 overflow-x-auto rounded bg-amber-100/80 p-2 text-xs text-amber-950">
{`cd /home/YOUR_USER/public_html/worker
cp .env.example .env   # WORKER_SHARED_TOKEN must match api/.env
npm install --omit=dev
npx playwright install chromium
pm2 start npm --name smoke-worker -- start`}
          </pre>
        </div>
      )}

      {!showWorkerAlert && data.worker.message && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900">
          {data.worker.message}
          {data.worker.last_seen_at && (
            <span className="text-emerald-700"> &middot; last seen {data.worker.last_seen_at}</span>
          )}
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="px-4 py-2 bg-ink-50 text-ink-600 text-sm font-semibold flex justify-between items-center">
          <span>Live log</span>
          <span className="text-xs font-normal text-ink-500">{logs.length} line(s)</span>
        </div>
        <div className="bg-ink-900 text-ink-100 font-mono text-xs max-h-72 overflow-y-auto p-3 space-y-1">
          {logs.length === 0 && (
            <div className="text-ink-400">
              {data.data.status === 'queued'
                ? 'Waiting for worker… No log lines yet. Start smoke-worker on the server to process this run.'
                : 'No log lines yet.'}
            </div>
          )}
          {logs.map((l) => (
            <div key={l.id} className="whitespace-pre-wrap break-words">
              <span className="text-ink-500">{l.created_at}</span>{' '}
              <span className="text-ink-400">[{l.source}/{l.level}]</span>{' '}
              <span className={logLevelClass(l.level)}>{l.message}</span>
            </div>
          ))}
          <div ref={logEndRef} />
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="px-4 py-2 bg-ink-50 text-ink-600 text-sm font-semibold">Sessions</div>
        <table className="w-full text-sm">
          <thead className="text-ink-500 text-left text-xs">
            <tr><th className="px-4 py-1">#</th><th>Name</th><th>Status</th><th>Job</th><th>Attempts</th><th>Worker</th><th>Last error</th></tr>
          </thead>
          <tbody>
            {data.sessions.map((s) => (
              <tr key={s.id} className="border-t border-ink-200">
                <td className="px-4 py-2">{s.ordinal}</td>
                <td>{s.name}</td>
                <td><span className="badge-neutral">{s.status}</span></td>
                <td><span className="badge-neutral">{s.job_status ?? '—'}</span></td>
                <td>{s.attempts}</td>
                <td className="text-xs text-ink-500">{s.leased_by ?? '—'}</td>
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
                <button type="button" className="btn-secondary" onClick={() => openReport(r.id, 'html')}>HTML</button>
                <button type="button" className="btn-secondary" onClick={() => openReport(r.id, 'json')}>JSON</button>
              </div>
            </li>
          ))}
          {data.reports.length === 0 && (
            <li className="px-4 py-3 text-ink-500 text-sm">
              No reports yet — reports appear after each session completes.
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
