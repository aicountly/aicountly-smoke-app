import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DeveloperPromptBlock } from '@/components/DeveloperPromptBlock';
import { PendingDecisionCard, type RunDecision } from '@/components/PendingDecisionCard';
import { api } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import { formatAppDateTime } from '@/lib/datetime';
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
  error_message: string | null;
  leased_by: string | null;
};

type RunReport = {
  id: number;
  kind: string;
  title?: string | null;
  session_id?: number | null;
};

type FileIoTest = {
  id: number;
  scenario_key: string;
  direction: string;
  compare_status: string;
  source_sha256?: string | null;
  result_sha256?: string | null;
  ai_scores?: { overall?: number; [key: string]: number | undefined };
  ai_verdict?: string | null;
  artifacts?: Array<{ key: string; name: string; url: string }>;
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
  reports?: RunReport[];
  file_io_tests?: FileIoTest[];
  worker: { online: boolean; queued_jobs: number; active_leases: number; last_seen_at: string | null; message: string };
};

type UxIssueRow = {
  id?: number;
  severity?: string;
  title?: string;
  description?: string;
  recommendation?: string | null;
  human_summary?: string | null;
  developer_prompt?: string | null;
  [key: string]: unknown;
};

type FeatureGapRow = {
  id?: number;
  severity?: string;
  expected_feature?: string;
  recommendation?: string;
  human_summary?: string | null;
  developer_prompt?: string | null;
  mode?: 'implement' | 'validate_first' | string | null;
  confidence?: 'high' | 'medium' | 'low' | string | null;
  [key: string]: unknown;
};

function primaryRecommendation(row: {
  human_summary?: string | null;
  recommendation?: string | null;
  description?: string | null;
}): string {
  return String(row.human_summary ?? '').trim()
    || String(row.recommendation ?? '').trim()
    || String(row.description ?? '').trim();
}

function logLevelClass(level: string): string {
  if (level === 'error') return 'text-red-400';
  if (level === 'warn') return 'text-amber-300';
  return 'text-emerald-200';
}

function promptText(row: { developer_prompt?: string | null }): string {
  return String(row.developer_prompt ?? '').trim();
}

/** UX prompts + implement-mode gaps (excludes validate_first backlog). */
function buildAllCursorPrompts(uxRows: UxIssueRow[], gapRows: FeatureGapRow[]): string {
  const parts: string[] = [];
  for (const row of uxRows) {
    const text = promptText(row);
    if (text) parts.push(text);
  }
  for (const row of gapRows) {
    if (String(row.mode ?? '') === 'validate_first') continue;
    const text = promptText(row);
    if (text) parts.push(text);
  }
  return parts.join('\n\n---\n\n');
}

function gapModeBadgeClass(mode: string): string {
  return mode === 'implement' ? 'badge-brand' : 'badge-neutral';
}

function gapModeLabel(mode: string): string {
  if (mode === 'validate_first') return 'validate first';
  if (mode === 'implement') return 'implement';
  return mode;
}

function runStatusBadgeClass(status: string): string {
  if (status === 'failed') return 'badge-danger';
  if (status === 'blocked' || status === 'cancelled') return 'badge-warning';
  if (status === 'running' || status === 'queued') return 'badge-info';
  return 'badge-brand';
}

/** A session that observed nothing in scope must not read like one that passed. */
function sessionStatusBadgeClass(status: string): string {
  if (status === 'failed') return 'badge-danger';
  if (status === 'blocked') return 'badge-warning';
  if (status === 'done') return 'badge-brand';
  return 'badge-neutral';
}

function jobStatusBadgeClass(status: string | null): string {
  if (status === 'awaiting_decision') return 'badge-warning';
  if (status === 'leased') return 'badge-info';
  if (status === 'failed') return 'badge-danger';
  if (status === 'succeeded' || status === 'done') return 'badge-brand';
  return 'badge-neutral';
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
  const [detailTab, setDetailTab] = useState<'inventory' | 'ux' | 'gaps' | 'file-io'>('inventory');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data } = useQuery<RunDetail>({
    queryKey: ['run', runId],
    queryFn: async () => (await api.get(`/runs/${runId}`)).data,
    refetchInterval: 3000,
  });

  const runActive = !!data && ['queued', 'running'].includes(data.data.status);
  const awaitingDecision =
    !!data && data.sessions.some((s) => s.job_status === 'awaiting_decision');
  const decisionsQ = useQuery<{ data: RunDecision[] }>({
    queryKey: ['run-decisions', runId, 'pending'],
    queryFn: async () =>
      (await api.get(`/runs/${runId}/decisions`, { params: { status: 'pending' } })).data,
    refetchInterval: 2500,
    enabled: runId > 0 && canOperate && (!data || runActive || awaitingDecision),
  });

  const cancelMut = useMutation({
    mutationFn: async () => (await api.post(`/runs/${runId}/cancel`, {})).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['run', runId] });
      qc.invalidateQueries({ queryKey: ['run-decisions', runId] });
    },
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
      qc.invalidateQueries({ queryKey: ['run-decisions', runId] });
    },
  });

  const detailFindingsEnabled = runId > 0 && (detailTab === 'ux' || detailTab === 'gaps');

  const inventoryQ = useQuery<{ data: Array<Record<string, unknown>> }>({
    queryKey: ['run-inventory', runId],
    queryFn: async () => (await api.get(`/runs/${runId}/inventory`)).data,
    enabled: runId > 0 && detailTab === 'inventory',
  });
  const uxQ = useQuery<{ data: UxIssueRow[] }>({
    queryKey: ['run-ux', runId],
    queryFn: async () => (await api.get(`/runs/${runId}/ux-issues`)).data,
    enabled: detailFindingsEnabled,
  });
  const gapsQ = useQuery<{ data: FeatureGapRow[] }>({
    queryKey: ['run-gaps', runId],
    queryFn: async () => (await api.get(`/runs/${runId}/feature-gaps`)).data,
    enabled: detailFindingsEnabled,
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

  useEffect(() => {
    return () => {
      if (copyResetRef.current) clearTimeout(copyResetRef.current);
    };
  }, []);

  async function handleCopy(key: string, text: string) {
    const ok = await copyText(text);
    if (!ok) return;
    setCopiedKey(key);
    if (copyResetRef.current) clearTimeout(copyResetRef.current);
    copyResetRef.current = setTimeout(() => setCopiedKey(null), 2000);
  }

  async function handleCopyAll() {
    const blob = buildAllCursorPrompts(uxQ.data?.data ?? [], gapsQ.data?.data ?? []);
    if (!blob) return;
    await handleCopy('all', blob);
  }

  async function handleArtifactDownload(artifact: { name: string; url: string }) {
    const response = await api.get(artifact.url, { responseType: 'blob' });
    const objectUrl = URL.createObjectURL(response.data);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = artifact.name;
    anchor.click();
    URL.revokeObjectURL(objectUrl);
  }

  if (!data) return <div className="text-sm text-ink-500">Loading...</div>;

  const showWorkerAlert = !data.worker.online && ['queued', 'running'].includes(data.data.status);
  const cancellable = canOperate && ['queued', 'running'].includes(data.data.status);
  const uxRows = uxQ.data?.data ?? [];
  const gapRows = gapsQ.data?.data ?? [];
  const copyAllCount =
    uxRows.filter((r) => promptText(r)).length +
    gapRows.filter((r) => String(r.mode ?? '') !== 'validate_first' && promptText(r)).length;
  const showCopyAll = detailTab === 'ux' || detailTab === 'gaps';

  const pendingDecisions = decisionsQ.data?.data ?? [];
  const sessionById = new Map(data.sessions.map((s) => [s.id, s]));
  const runReports = data.reports ?? [];
  const sessionReports = runReports.filter((r) => String(r.kind) === 'session');
  const finalReport = runReports.find((r) => String(r.kind) === 'final') ?? null;
  const primarySession = data.sessions[0] ?? null;

  function canRerun(s: SessionRow): boolean {
    if (!canOperate) return false;
    if (!s.job_id) return false;
    if (s.job_status === 'leased' || s.job_status === 'awaiting_decision') return false;
    return true;
  }

  function rerunBlockedLabel(status: string | null): string {
    if (status === 'awaiting_decision') return 'Awaiting decision…';
    if (status === 'leased') return 'Running…';
    return '';
  }

  return (
    <div className="space-y-4 max-w-5xl">
      <div className="flex justify-between items-start gap-4">
        <div>
          <h1 className="text-xl font-semibold font-mono">{data.data.run_code}</h1>
          <p className="text-sm text-ink-500">
            {data.data.product_name} &middot; {data.data.environment} &middot;{' '}
            <span className={runStatusBadgeClass(data.data.status)}>{data.data.status}</span>
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

      {(sessionReports.length > 0 || finalReport || primarySession) && (
        <div className="flex flex-wrap gap-2 text-sm">
          {sessionReports.map((r) => (
            <Link
              key={r.id}
              to={`/reports?id=${r.id}`}
              className="btn-secondary text-xs py-1 px-2"
            >
              {sessionReports.length > 1
                ? `View session report${r.session_id ? ` #${r.session_id}` : ''}`
                : 'View session report'}
            </Link>
          ))}
          {finalReport && (
            <Link
              to={`/reports?id=${finalReport.id}`}
              className="btn-secondary text-xs py-1 px-2"
            >
              View final report
            </Link>
          )}
          {primarySession && (
            <Link
              to={`/runs/${runId}/sessions/${primarySession.id}`}
              className="btn-secondary text-xs py-1 px-2"
              title={
                data.sessions.length > 1
                  ? 'Opens the first session log; use View log on each session row for others'
                  : 'View session logs and screenshots'
              }
            >
              View session log
            </Link>
          )}
        </div>
      )}

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
pm2 startOrRestart ecosystem.config.cjs --update-env && pm2 save
pm2 logs aicountly-smoke-worker --lines 40`}
          </pre>
          <p className="mt-2 text-xs text-amber-800">
            Deploys restart <code>aicountly-smoke-worker</code> automatically. Always use the
            ecosystem file — starting a second, differently named process would double-lease the
            job queue.
          </p>
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

      {pendingDecisions.map((d) => (
        <PendingDecisionCard
          key={d.id}
          runId={runId}
          decision={d}
          sessionName={sessionById.get(d.session_id)?.name}
          canAnswer={canOperate}
          onAnswered={() => {
            qc.invalidateQueries({ queryKey: ['run-decisions', runId] });
            qc.invalidateQueries({ queryKey: ['run', runId] });
            qc.invalidateQueries({ queryKey: ['run-logs', runId] });
          }}
        />
      ))}

      <div className="card overflow-hidden">
        <div className="px-4 py-2 bg-ink-50 text-ink-600 text-sm font-semibold flex justify-between items-center">
          <span>Live log</span>
          <span className="text-xs font-normal text-ink-500">{logs.length} line(s)</span>
        </div>
        <div className="bg-ink-900 text-ink-100 font-mono text-xs max-h-72 overflow-y-auto p-3 space-y-1">
          {logs.length === 0 && (
            <div className="text-ink-400">
              {data.data.status === 'queued'
                ? 'Waiting for worker… No log lines yet. Check that aicountly-smoke-worker is online on the server.'
                : 'No log lines yet.'}
            </div>
          )}
          {logs.map((l) => (
            <div key={l.id} className="whitespace-pre-wrap break-words">
              <span className="text-ink-500">{formatAppDateTime(l.created_at)}</span>{' '}
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
                <td>
                  <span className={sessionStatusBadgeClass(s.status)} title={s.error_message ?? undefined}>
                    {s.status}
                  </span>
                </td>
                <td>
                  <span className={jobStatusBadgeClass(s.job_status)}>
                    {s.job_status ?? '—'}
                  </span>
                </td>
                <td>{s.attempts}</td>
                <td className="text-xs text-ink-500">{s.leased_by ?? '—'}</td>
                <td className="text-xs text-red-700 truncate max-w-xs">
                  {s.last_error ?? (s.status === 'blocked' ? s.error_message ?? '' : '')}
                </td>
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
                    <span
                      className="text-xs text-ink-400"
                      title={
                        s.job_status === 'awaiting_decision'
                          ? 'Answer the pending decision before re-running'
                          : s.job_status === 'leased'
                            ? 'Wait until the worker finishes'
                            : undefined
                      }
                    >
                      {rerunBlockedLabel(s.job_status)}
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
        <div className="px-4 py-2 bg-ink-50 text-ink-600 text-sm font-semibold flex flex-wrap gap-3 items-center justify-between">
          <div className="flex gap-3">
            {([
              ['inventory', 'UI inventory'],
              ['ux', 'UX issues'],
              ['gaps', 'Feature gaps'],
              ['file-io', 'File I/O'],
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
          {showCopyAll && (
            <button
              type="button"
              className="btn-secondary text-xs py-1 px-2 font-normal"
              disabled={copyAllCount === 0 || uxQ.isLoading || gapsQ.isLoading}
              title="Copies all UX prompts plus implement-mode feature-gap prompts (skips validate-first)"
              onClick={() => void handleCopyAll()}
            >
              {copiedKey === 'all' ? 'Copied all' : 'Copy all Cursor prompts'}
            </button>
          )}
        </div>
        <div className="p-4 text-sm max-h-96 overflow-y-auto">
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
              {uxRows.map((row, i) => {
                const prompt = promptText(row);
                const copyKey = `ux-${row.id ?? i}`;
                const summary = primaryRecommendation(row);
                const technical = String(row.recommendation ?? '').trim();
                const description = String(row.description ?? '').trim();
                return (
                  <li key={copyKey} className="border-b border-ink-100 pb-2">
                    <div className="flex gap-2 items-center flex-wrap">
                      <span className="badge-warning">{String(row.severity ?? '')}</span>
                      <span className="font-medium">{String(row.title ?? '')}</span>
                    </div>
                    {summary ? (
                      <p className="text-ink-800 mt-1 whitespace-pre-wrap">{summary}</p>
                    ) : null}
                    {technical && technical !== summary ? (
                      <details className="mt-1">
                        <summary className="text-xs text-ink-500 cursor-pointer">Technical recommendation</summary>
                        <p className="text-xs text-ink-600 mt-1">{technical}</p>
                      </details>
                    ) : null}
                    {description && description !== summary && description !== technical ? (
                      <p className="text-xs text-ink-500 mt-1">{description}</p>
                    ) : null}
                    <DeveloperPromptBlock prompt={prompt} />
                  </li>
                );
              })}
              {!uxQ.isLoading && uxRows.length === 0 && (
                <li className="text-ink-500">No UX issues recorded yet.</li>
              )}
            </ul>
          )}
          {detailTab === 'gaps' && (
            <ul className="space-y-2">
              {gapRows.map((row, i) => {
                const prompt = promptText(row);
                const copyKey = `gap-${row.id ?? i}`;
                const mode = String(row.mode ?? '').trim();
                const confidence = String(row.confidence ?? '').trim();
                return (
                  <li key={copyKey} className="border-b border-ink-100 pb-2">
                    <div className="flex gap-2 items-center flex-wrap">
                      <span className="badge-neutral">{String(row.severity ?? '')}</span>
                      {mode ? (
                        <span
                          className={gapModeBadgeClass(mode)}
                          title={
                            mode === 'validate_first'
                              ? 'Validate in product before treating as sprint work'
                              : 'Ready to implement in the product repo'
                          }
                        >
                          {gapModeLabel(mode)}
                        </span>
                      ) : null}
                      {confidence ? (
                        <span className="badge-neutral" title="Detection confidence">
                          {confidence}
                        </span>
                      ) : null}
                      <span className="font-medium">{String(row.expected_feature ?? '')}</span>
                    </div>
                    {(() => {
                      const summary = primaryRecommendation(row);
                      const technical = String(row.recommendation ?? '').trim();
                      return (
                        <>
                          {summary ? (
                            <p className="text-ink-800 mt-1 whitespace-pre-wrap">{summary}</p>
                          ) : null}
                          {technical && technical !== summary ? (
                            <details className="mt-1">
                              <summary className="text-xs text-ink-500 cursor-pointer">Technical recommendation</summary>
                              <p className="text-xs text-ink-600 mt-1">{technical}</p>
                            </details>
                          ) : null}
                        </>
                      );
                    })()}
                    <DeveloperPromptBlock prompt={prompt} />
                  </li>
                );
              })}
              {!gapsQ.isLoading && gapRows.length === 0 && (
                <li className="text-ink-500">No feature gaps recorded yet.</li>
              )}
            </ul>
          )}
          {detailTab === 'file-io' && (
            <ul className="space-y-3">
              {(data.file_io_tests ?? []).map((row) => (
                <li key={row.id} className="border-b border-ink-100 pb-3">
                  <div className="flex gap-2 items-center flex-wrap">
                    <span className={row.compare_status === 'pass' ? 'badge-brand' : row.compare_status === 'not_applicable' ? 'badge-neutral' : 'badge-warning'}>
                      {row.compare_status === 'not_applicable' ? 'workflow passed (not comparable)' : row.compare_status}
                    </span>
                    <span className="font-medium">{row.scenario_key}</span>
                    <span className="badge-neutral">{row.direction}</span>
                    {row.ai_scores?.overall !== undefined && <span className="badge-neutral">AI {row.ai_scores.overall}/100</span>}
                  </div>
                  {row.ai_verdict && <p className="mt-1">{row.ai_verdict}</p>}
                  <div className="text-xs font-mono text-ink-500 break-all mt-1">
                    <div>source: {row.source_sha256 || '—'}</div><div>result: {row.result_sha256 || '—'}</div>
                  </div>
                  <div className="flex gap-2 mt-2">
                    {(row.artifacts ?? []).map((artifact) => (
                      <button key={artifact.key} type="button" className="text-brand-700 underline text-xs" onClick={() => void handleArtifactDownload(artifact)}>{artifact.name}</button>
                    ))}
                  </div>
                </li>
              ))}
              {(data.file_io_tests?.length ?? 0) === 0 && <li className="text-ink-500">No File I/O tests recorded yet.</li>}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
