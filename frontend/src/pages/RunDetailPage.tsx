import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuthStore } from '@/store/auth';

type RunLog = {
  id: number;
  source: string;
  level: string;
  message: string;
  created_at: string;
  session_id?: number | null;
};

type SessionRow = {
  id: number;
  ordinal: number;
  name: string;
  status: string;
  job_id: number | null;
  job_status: string | null;
  attempts: number;
  last_error: string | null;
  leased_by: string | null;
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
  sessions: SessionRow[];
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
  const navigate = useNavigate();
  const qc = useQueryClient();
  const canOperate = useAuthStore((s) => s.hasRole('owner', 'product_reviewer'));
  const canDelete = useAuthStore((s) => s.hasRole('owner'));
  const logEndRef = useRef<HTMLDivElement>(null);
  const [lastLogId, setLastLogId] = useState(0);
  const [logs, setLogs] = useState<RunLog[]>([]);
  const [detailTab, setDetailTab] = useState<'inventory' | 'ux' | 'gaps'>('inventory');

  const { data } = useQuery<RunDetail>({
    queryKey: ['run', runId],
    queryFn: async () => (await api.get(`/runs/${runId}`)).data,
    refetchInterval: 3000,
  });

  const cancelMut = useMutation({
    mutationFn: async () => (await api.post(`/runs/${runId}/cancel`, {})).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['run', runId] }),
  });

  const deleteMut = useMutation({
    mutationFn: async () => (await api.delete(`/runs/${runId}`)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['runs'] });
      navigate('/runs');
    },
  });

  const rerunMut = useMutation({
    mutationFn: async (sessionId: number) =>
      (await api.post(`/runs/${runId}/sessions/${sessionId}/rerun`, {})).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['run', runId] });
    },
  });

  const inventoryQ = useQuery<{ data: Array<Record<string, unknown>> }>({
    queryKey: ['run-inventory', runId],
    queryFn: async () => (await api.get(`/runs/${runId}/inventory`)).data,
    enabled: runId > 0 && detailTab === 'inventory',
  });
  const uxQ = useQuery<{ data: Array<Record<string, unknown>> }>({
    queryKey: ['run-ux', runId],
    queryFn: async () => (await api.get(`/runs/${runId}/ux-issues`)).data,
    enabled: runId > 0 && detailTab === 'ux',
  });
  const gapsQ = useQuery<{ data: Array<Record<string, unknown>> }>({
    queryKey: ['run-gaps', runId],
    queryFn: async () => (await api.get(`/runs/${runId}/feature-gaps`)).data,
    enabled: runId > 0 && detailTab === 'gaps',
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
  const cancellable = canOperate && ['queued', 'running'].includes(data.data.status);

  function canRerun(s: SessionRow): boolean {
    if (!canOperate) return false;
    if (!s.job_id) return false;
    return s.job_status !== 'leased';
  }

  return (
    <div className="space-y-4 max-w-5xl">
      <div className="flex justify-between items-start gap-4">
        <div>
          <h1 className="text-xl font-semibold font-mono">{data.data.run_code}</h1>
          <p className="text-sm text-ink-500">
            {data.data.product_name} &middot; {data.data.environment} &middot;{' '}
            <span className="badge-brand">{data.data.status}</span>
            {' '}&middot; {data.data.sessions_done}/{data.data.sessions_total} done
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          {cancellable && (
            <button
              type="button"
              className="btn-secondary"
              disabled={cancelMut.isPending}
              onClick={() => {
                if (confirm('Cancel this run and all queued/leased jobs?')) cancelMut.mutate();
              }}
            >
              {cancelMut.isPending ? 'Cancelling…' : 'Cancel run'}
            </button>
          )}
          {canDelete && (
            <button
              type="button"
              className="btn-danger"
              disabled={deleteMut.isPending}
              onClick={() => {
                if (
                  confirm(
                    `Delete run "${data.data.run_code}"?\n\nThis permanently removes all logs, screenshots, and report files for this run. This cannot be undone.`,
                  )
                ) {
                  deleteMut.mutate();
                }
              }}
            >
              {deleteMut.isPending ? 'Deleting…' : 'Delete run'}
            </button>
          )}
        </div>
      </div>

      {deleteMut.isError && (
        <div className="rounded border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">
          Delete failed.{' '}
          {(deleteMut.error as { response?: { data?: { message?: string } } })?.response?.data?.message
            ?? 'Try again.'}
        </div>
      )}

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
            <tr>
              <th className="px-4 py-1">#</th>
              <th>Name</th>
              <th>Status</th>
              <th>Job</th>
              <th>Attempts</th>
              <th>Worker</th>
              <th>Last error</th>
              <th className="px-4 py-1 text-right">Actions</th>
            </tr>
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
                <td className="px-4 py-2 text-right whitespace-nowrap">
                  <Link
                    to={`/runs/${runId}/sessions/${s.id}`}
                    className="btn-secondary text-xs py-1 px-2 mr-2 inline-block"
                    title="View session logs and screenshots"
                  >
                    View log
                  </Link>
                  {canRerun(s) ? (
                    <button
                      type="button"
                      className="text-brand-700 hover:underline text-xs font-medium disabled:opacity-40"
                      disabled={rerunMut.isPending}
                      onClick={() => {
                        if (confirm(`Re-run session "${s.name}"? It will be queued again for the worker.`)) {
                          rerunMut.mutate(s.id);
                        }
                      }}
                    >
                      Re-run
                    </button>
                  ) : (
                    <span className="text-xs text-ink-400" title={s.job_status === 'leased' ? 'Wait until the worker finishes' : undefined}>
                      {s.job_status === 'leased' ? 'Running…' : ''}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rerunMut.isError && (
          <div className="px-4 py-2 text-xs text-red-700 border-t border-ink-200">
            Re-run failed. {(rerunMut.error as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Try again.'}
          </div>
        )}
      </div>

      <div className="card overflow-hidden">
        <div className="px-4 py-2 bg-ink-50 text-ink-600 text-sm font-semibold flex gap-3">
          {([
            ['inventory', 'UI inventory'],
            ['ux', 'UX issues'],
            ['gaps', 'Feature gaps'],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={detailTab === key ? 'text-brand-700 underline' : 'text-ink-500 hover:text-ink-800'}
              onClick={() => setDetailTab(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="p-4 text-sm max-h-80 overflow-y-auto">
          {detailTab === 'inventory' && (
            <ul className="space-y-2">
              {(inventoryQ.data?.data ?? []).map((row, i) => (
                <li key={i} className="border-b border-ink-100 pb-2">
                  <span className="badge-neutral mr-2">{String(row.kind ?? '')}</span>
                  <span className="font-medium">{String(row.label ?? '')}</span>
                  {row.url ? <div className="text-xs text-ink-500 font-mono truncate">{String(row.url)}</div> : null}
                </li>
              ))}
              {!inventoryQ.isLoading && (inventoryQ.data?.data?.length ?? 0) === 0 && (
                <li className="text-ink-500">No inventory captured yet.</li>
              )}
            </ul>
          )}
          {detailTab === 'ux' && (
            <ul className="space-y-2">
              {(uxQ.data?.data ?? []).map((row, i) => (
                <li key={i} className="border-b border-ink-100 pb-2">
                  <div className="flex gap-2 items-center">
                    <span className="badge-warning">{String(row.severity ?? '')}</span>
                    <span className="font-medium">{String(row.title ?? '')}</span>
                  </div>
                  {row.description ? <p className="text-ink-600 mt-1">{String(row.description)}</p> : null}
                </li>
              ))}
              {!uxQ.isLoading && (uxQ.data?.data?.length ?? 0) === 0 && (
                <li className="text-ink-500">No UX issues recorded yet.</li>
              )}
            </ul>
          )}
          {detailTab === 'gaps' && (
            <ul className="space-y-2">
              {(gapsQ.data?.data ?? []).map((row, i) => (
                <li key={i} className="border-b border-ink-100 pb-2">
                  <div className="flex gap-2 items-center">
                    <span className="badge-neutral">{String(row.severity ?? '')}</span>
                    <span className="font-medium">{String(row.expected_feature ?? '')}</span>
                  </div>
                  {row.recommendation ? <p className="text-ink-600 mt-1">{String(row.recommendation)}</p> : null}
                </li>
              ))}
              {!gapsQ.isLoading && (gapsQ.data?.data?.length ?? 0) === 0 && (
                <li className="text-ink-500">No feature gaps recorded yet.</li>
              )}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
