import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { openReport } from '@/lib/reports';
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

type SessionDetail = {
  session: SessionRow & { description?: string; menu_path?: string };
  logs: RunLog[];
  results: Array<{
    id: number;
    screen_url: string;
    screen_title: string;
    module_name: string;
    has_screenshot: boolean;
    screenshot_url: string | null;
    captured_at?: string;
    created_at?: string;
  }>;
  reports: Array<{ id: number; kind: string; title: string; ux_score: number; maturity_score: number }>;
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
  reports: Array<{
    id: number;
    kind: string;
    title: string;
    html_path: string;
    ux_score: number;
    maturity_score: number;
    auditor_visible: boolean;
    session_id?: number | null;
  }>;
  worker: { online: boolean; queued_jobs: number; active_leases: number; last_seen_at: string | null; message: string };
};

function logLevelClass(level: string): string {
  if (level === 'error') return 'text-red-400';
  if (level === 'warn') return 'text-amber-300';
  return 'text-emerald-200';
}

function ScreenshotThumb({ runId, resultId, title }: { runId: number; resultId: number; title: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get(`/runs/${runId}/results/${resultId}/screenshot`, { responseType: 'blob' });
        if (cancelled) return;
        objectUrl = URL.createObjectURL(res.data as Blob);
        setSrc(objectUrl);
      } catch {
        if (!cancelled) setErr(true);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [runId, resultId]);

  if (err) return <div className="text-xs text-ink-500">Screenshot unavailable</div>;
  if (!src) return <div className="h-40 bg-ink-100 animate-pulse rounded" />;

  return (
    <a href={src} target="_blank" rel="noreferrer" className="block">
      <img src={src} alt={title || 'Screenshot'} className="w-full max-h-80 object-contain rounded border border-ink-200 bg-ink-50" />
    </a>
  );
}

type TimelineItem =
  | { kind: 'log'; at: string; log: RunLog }
  | { kind: 'screen'; at: string; result: SessionDetail['results'][number] };

function buildSessionTimeline(detail: SessionDetail | undefined): TimelineItem[] {
  if (!detail) return [];
  const items: TimelineItem[] = [
    ...detail.logs.map((log) => ({ kind: 'log' as const, at: log.created_at, log })),
    ...detail.results.map((result) => ({
      kind: 'screen' as const,
      at: result.captured_at ?? result.created_at ?? '',
      result,
    })),
  ];
  return items.sort((a, b) => {
    const ta = a.at ? Date.parse(a.at) : 0;
    const tb = b.at ? Date.parse(b.at) : 0;
    if (ta !== tb) return ta - tb;
    if (a.kind !== b.kind) return a.kind === 'log' ? -1 : 1;
    return 0;
  });
}

function SessionLogDrawer({
  runId,
  sessionId,
  sessionName,
  onClose,
}: {
  runId: number;
  sessionId: number;
  sessionName: string;
  onClose: () => void;
}) {
  const [reportErr, setReportErr] = useState<string | null>(null);
  const { data, isLoading, refetch, isFetching, isError, error } = useQuery<SessionDetail>({
    queryKey: ['session-detail', runId, sessionId],
    queryFn: async () => (await api.get(`/runs/${runId}/sessions/${sessionId}`)).data,
    refetchInterval: 3000,
  });

  const timeline = buildSessionTimeline(data);
  const shotCount = data?.results.filter((r) => r.has_screenshot).length ?? 0;

  async function handleOpenReport(id: number, format: 'html' | 'json') {
    setReportErr(null);
    try {
      await openReport(id, format);
    } catch (e) {
      const ax = e as { response?: { data?: { message?: string } }; message?: string };
      setReportErr(ax?.response?.data?.message || ax?.message || `Failed to open ${format.toUpperCase()} report.`);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink-900/40" onClick={onClose}>
      <div
        className="h-full w-full max-w-2xl bg-white shadow-xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-ink-200 flex items-start justify-between gap-3">
          <div>
            <div className="text-xs text-ink-500 uppercase tracking-wide">Session log</div>
            <h2 className="text-lg font-semibold">{sessionName}</h2>
            {data?.session && (
              <p className="text-xs text-ink-500 mt-0.5">
                status <span className="badge-neutral">{data.session.status}</span>
                {' '}&middot; job <span className="badge-neutral">{data.session.job_status ?? '—'}</span>
                {' '}&middot; attempts {data.session.attempts}
                {' '}&middot; {data.logs.length} log(s)
                {' '}&middot; {shotCount} screenshot(s)
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <button type="button" className="btn-secondary" onClick={() => refetch()} disabled={isFetching}>
              Refresh
            </button>
            <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {isLoading && <div className="text-sm text-ink-500">Loading session log…</div>}
          {isError && (
            <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              Failed to load session log. {(error as Error)?.message ?? 'Try again.'}
            </div>
          )}

          {data?.session.last_error && (
            <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              {data.session.last_error}
            </div>
          )}

          {reportErr && (
            <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              {reportErr}
            </div>
          )}

          {(data?.reports.length ?? 0) > 0 && (
            <section>
              <h3 className="text-sm font-semibold text-ink-700 mb-2">Session reports</h3>
              <ul className="space-y-2">
                {data!.reports.map((r) => (
                  <li key={r.id} className="flex justify-between items-center text-sm border border-ink-200 rounded px-3 py-2">
                    <div>
                      <div className="font-medium">{r.title}</div>
                      <div className="text-xs text-ink-500">UX {r.ux_score} · maturity {r.maturity_score}</div>
                    </div>
                    <div className="flex gap-2">
                      <button type="button" className="btn-secondary" onClick={() => handleOpenReport(r.id, 'html')}>HTML</button>
                      <button type="button" className="btn-secondary" onClick={() => handleOpenReport(r.id, 'json')}>JSON</button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h3 className="text-sm font-semibold text-ink-700 mb-2">
              Action timeline ({timeline.length})
            </h3>
            <p className="text-xs text-ink-500 mb-3">
              Every worker log line and every captured screen for this session, in order.
            </p>
            {timeline.length === 0 && !isLoading && (
              <p className="text-sm text-ink-500">No log lines or screenshots for this session yet.</p>
            )}
            <div className="space-y-3">
              {timeline.map((item) =>
                item.kind === 'log' ? (
                  <div
                    key={`log-${item.log.id}`}
                    className="rounded border border-ink-200 bg-ink-900 text-ink-100 font-mono text-xs px-3 py-2 whitespace-pre-wrap break-words"
                  >
                    <span className="text-ink-500">{item.log.created_at}</span>{' '}
                    <span className="text-ink-400">[{item.log.source}/{item.log.level}]</span>{' '}
                    <span className={logLevelClass(item.log.level)}>{item.log.message}</span>
                  </div>
                ) : (
                  <div key={`screen-${item.result.id}`} className="rounded border border-brand-200 bg-brand-50/40 p-3 space-y-2">
                    <div className="flex justify-between gap-2 text-sm">
                      <div>
                        <div className="text-[11px] uppercase tracking-wide text-brand-700 font-semibold">Screenshot / action</div>
                        <div className="font-medium">
                          {item.result.screen_title || item.result.module_name || `Screen #${item.result.id}`}
                        </div>
                        {item.result.screen_url && (
                          <div className="text-xs text-ink-500 font-mono truncate">{item.result.screen_url}</div>
                        )}
                      </div>
                      <div className="text-xs text-ink-500 whitespace-nowrap">
                        {item.result.captured_at ?? item.result.created_at ?? ''}
                      </div>
                    </div>
                    {item.result.has_screenshot ? (
                      <ScreenshotThumb runId={runId} resultId={item.result.id} title={item.result.screen_title} />
                    ) : (
                      <div className="text-xs text-ink-500">No screenshot file for this screen.</div>
                    )}
                  </div>
                ),
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

export function RunDetailPage() {
  const { id } = useParams();
  const runId = Number(id);
  const qc = useQueryClient();
  const canOperate = useAuthStore((s) => s.hasRole('owner', 'product_reviewer'));
  const logEndRef = useRef<HTMLDivElement>(null);
  const [lastLogId, setLastLogId] = useState(0);
  const [logs, setLogs] = useState<RunLog[]>([]);
  const [detailTab, setDetailTab] = useState<'inventory' | 'ux' | 'gaps'>('inventory');
  const [logSession, setLogSession] = useState<{ id: number; name: string } | null>(null);
  const [reportErr, setReportErr] = useState<string | null>(null);

  async function handleOpenReport(id: number, format: 'html' | 'json') {
    setReportErr(null);
    try {
      await openReport(id, format);
    } catch (e) {
      const ax = e as { response?: { data?: { message?: string } }; message?: string };
      setReportErr(ax?.response?.data?.message || ax?.message || `Failed to open ${format.toUpperCase()} report.`);
    }
  }

  const { data } = useQuery<RunDetail>({
    queryKey: ['run', runId],
    queryFn: async () => (await api.get(`/runs/${runId}`)).data,
    refetchInterval: 3000,
  });

  const cancelMut = useMutation({
    mutationFn: async () => (await api.post(`/runs/${runId}/cancel`, {})).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['run', runId] }),
  });

  const rerunMut = useMutation({
    mutationFn: async (sessionId: number) =>
      (await api.post(`/runs/${runId}/sessions/${sessionId}/rerun`, {})).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['run', runId] });
      if (logSession) {
        qc.invalidateQueries({ queryKey: ['session-detail', runId, logSession.id] });
      }
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
        {cancellable && (
          <button
            type="button"
            className="btn-danger"
            disabled={cancelMut.isPending}
            onClick={() => {
              if (confirm('Cancel this run and all queued/leased jobs?')) cancelMut.mutate();
            }}
          >
            {cancelMut.isPending ? 'Cancelling…' : 'Cancel run'}
          </button>
        )}
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
                  <button
                    type="button"
                    className="btn-secondary text-xs py-1 px-2 mr-2"
                    onClick={() => setLogSession({ id: s.id, name: s.name })}
                    title="View session logs and screenshots for every action"
                  >
                    View log
                  </button>
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
        <div className="px-4 py-2 bg-ink-50 text-ink-600 text-sm font-semibold">Reports</div>
        {reportErr && (
          <div className="px-4 py-2 text-sm text-red-700 border-b border-red-100 bg-red-50">
            {reportErr}
          </div>
        )}
        <ul className="divide-y divide-ink-200">
          {data.reports.map((r) => (
            <li key={r.id} className="px-4 py-2 flex justify-between items-center gap-3">
              <div className="min-w-0">
                <div className="font-medium">{r.title}</div>
                <div className="text-xs text-ink-500">kind: {r.kind} &middot; UX {r.ux_score} &middot; maturity {r.maturity_score}</div>
              </div>
              <div className="flex gap-2 shrink-0">
                {r.session_id ? (
                  <button
                    type="button"
                    className="btn-secondary text-xs"
                    onClick={() => {
                      const sess = data.sessions.find((s) => s.id === r.session_id);
                      setLogSession({ id: r.session_id!, name: sess?.name ?? r.title });
                    }}
                  >
                    View log
                  </button>
                ) : null}
                <button type="button" className="btn-secondary" onClick={() => handleOpenReport(r.id, 'html')}>HTML</button>
                <button type="button" className="btn-secondary" onClick={() => handleOpenReport(r.id, 'json')}>JSON</button>
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

      {logSession && (
        <SessionLogDrawer
          runId={runId}
          sessionId={logSession.id}
          sessionName={logSession.name}
          onClose={() => setLogSession(null)}
        />
      )}
    </div>
  );
}
