import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatAppDateTime } from '@/lib/datetime';

type RunLog = {
  id: number;
  source: string;
  level: string;
  message: string;
  created_at: string;
};

type ScreenResult = {
  id: number;
  screen_url: string;
  screen_title: string;
  module_name: string;
  has_screenshot: boolean;
  screenshot_url: string | null;
  captured_at?: string;
  created_at?: string;
};

type SessionDetail = {
  session: {
    id: number;
    name: string;
    status: string;
    job_status: string | null;
    attempts: number;
    last_error: string | null;
    error_message: string | null;
  };
  logs: RunLog[];
  results: ScreenResult[];
};

function logLevelClass(level: string): string {
  if (level === 'error') return 'text-red-400';
  if (level === 'warn') return 'text-amber-300';
  return 'text-emerald-200';
}

function useScreenshotBlob(runId: number, resultId: number | null, enabled: boolean) {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || resultId == null) {
      setSrc(null);
      setErr(false);
      setLoading(false);
      return;
    }
    let objectUrl: string | null = null;
    let cancelled = false;
    setLoading(true);
    setErr(false);
    setSrc(null);
    (async () => {
      try {
        const res = await api.get(`/runs/${runId}/results/${resultId}/screenshot`, { responseType: 'blob' });
        if (cancelled) return;
        objectUrl = URL.createObjectURL(res.data as Blob);
        setSrc(objectUrl);
      } catch {
        if (!cancelled) setErr(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [runId, resultId, enabled]);

  return { src, err, loading };
}

function FullImageViewer({
  src,
  title,
  onClose,
}: {
  src: string;
  title: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[60] bg-ink-900/90 flex flex-col"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Full screenshot view"
    >
      <div className="flex items-center justify-between px-4 py-3 text-white border-b border-white/10">
        <div className="text-sm font-medium truncate pr-4">{title}</div>
        <div className="flex gap-2 shrink-0">
          <a
            href={src}
            target="_blank"
            rel="noreferrer"
            className="btn-secondary text-xs"
            onClick={(e) => e.stopPropagation()}
          >
            Open in new tab
          </a>
          <button type="button" className="btn-secondary text-xs" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-auto p-4 flex items-start justify-center" onClick={(e) => e.stopPropagation()}>
        <img src={src} alt={title} className="max-w-none w-auto h-auto shadow-2xl rounded bg-white" />
      </div>
    </div>
  );
}

export function SessionLogPage() {
  const { id, sessionId } = useParams();
  const runId = Number(id);
  const sid = Number(sessionId);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [fullView, setFullView] = useState(false);

  const { data, isLoading, refetch, isFetching, isError, error } = useQuery<SessionDetail>({
    queryKey: ['session-detail', runId, sid],
    queryFn: async () => (await api.get(`/runs/${runId}/sessions/${sid}`)).data,
    refetchInterval: 3000,
    enabled: runId > 0 && sid > 0,
  });

  const screens = useMemo(
    () => (data?.results ?? []).filter((r) => r.has_screenshot),
    [data?.results],
  );

  useEffect(() => {
    if (screens.length === 0) {
      setSelectedId(null);
      return;
    }
    if (selectedId == null || !screens.some((s) => s.id === selectedId)) {
      setSelectedId(screens[0].id);
    }
  }, [screens, selectedId]);

  const selected = screens.find((s) => s.id === selectedId) ?? null;
  const { src, err, loading } = useScreenshotBlob(runId, selectedId, selectedId != null);

  const sessionName = data?.session.name ?? `Session #${sid}`;
  const shotTitle = selected
    ? selected.screen_title || selected.module_name || `Screen #${selected.id}`
    : 'Screenshot';

  return (
    <div className="flex flex-col h-[calc(100vh-7rem)] min-h-[32rem] -mx-1">
      <div className="flex items-start justify-between gap-3 mb-3 shrink-0">
        <div className="min-w-0">
          <Link to={`/runs/${runId}`} className="text-xs text-brand-700 hover:underline">
            ← Back to run
          </Link>
          <h1 className="text-xl font-semibold mt-1 truncate">{sessionName}</h1>
          {data?.session && (
            <p className="text-xs text-ink-500 mt-0.5">
              status{' '}
              <span className={data.session.status === 'blocked' ? 'badge-warning' : 'badge-neutral'}>
                {data.session.status}
              </span>
              {' '}&middot; job <span className="badge-neutral">{data.session.job_status ?? '—'}</span>
              {' '}&middot; attempts {data.session.attempts}
              {' '}&middot; {data.logs.length} log(s)
              {' '}&middot; {screens.length} screenshot(s)
            </p>
          )}
        </div>
        <button type="button" className="btn-secondary shrink-0" onClick={() => refetch()} disabled={isFetching}>
          Refresh
        </button>
      </div>

      {data?.session.status === 'blocked' && data.session.error_message && (
        <div className="mb-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 shrink-0">
          This session finished without testing its scope: {data.session.error_message}
        </div>
      )}

      {data?.session.last_error && (
        <div className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 shrink-0">
          {data.session.last_error}
        </div>
      )}
      {isError && (
        <div className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 shrink-0">
          Failed to load session log. {(error as Error)?.message ?? 'Try again.'}
        </div>
      )}

      <div className="card flex-1 min-h-0 overflow-hidden grid grid-cols-1 lg:grid-cols-2">
        {/* Left: logs */}
        <section className="flex flex-col min-h-0 border-b lg:border-b-0 lg:border-r border-ink-200">
          <div className="px-4 py-2 bg-ink-50 text-ink-600 text-sm font-semibold flex justify-between">
            <span>Logs</span>
            <span className="text-xs font-normal text-ink-500">{data?.logs.length ?? 0} line(s)</span>
          </div>
          <div className="flex-1 overflow-y-auto bg-ink-900 text-ink-100 font-mono text-xs p-3 space-y-1">
            {isLoading && <div className="text-ink-400">Loading logs…</div>}
            {!isLoading && (data?.logs.length ?? 0) === 0 && (
              <div className="text-ink-400">No log lines for this session yet.</div>
            )}
            {(data?.logs ?? []).map((l) => (
              <div key={l.id} className="whitespace-pre-wrap break-words">
                <span className="text-ink-500">{formatAppDateTime(l.created_at)}</span>{' '}
                <span className="text-ink-400">[{l.source}/{l.level}]</span>{' '}
                <span className={logLevelClass(l.level)}>{l.message}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Right: screenshots */}
        <section className="flex flex-col min-h-0">
          <div className="px-4 py-2 bg-ink-50 text-ink-600 text-sm font-semibold flex justify-between">
            <span>Screenshots</span>
            <span className="text-xs font-normal text-ink-500">{screens.length} image(s)</span>
          </div>

          <div className="flex flex-1 min-h-0">
            <ul className="w-44 shrink-0 border-r border-ink-200 overflow-y-auto bg-white">
              {screens.length === 0 && !isLoading && (
                <li className="p-3 text-xs text-ink-500">No screenshots captured for this session.</li>
              )}
              {screens.map((r, idx) => {
                const label = r.screen_title || r.module_name || `Screen #${r.id}`;
                const active = r.id === selectedId;
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      className={
                        'w-full text-left px-3 py-2 text-xs border-b border-ink-100 hover:bg-ink-50 ' +
                        (active ? 'bg-brand-50 text-brand-800' : 'text-ink-700')
                      }
                      onClick={() => {
                        setSelectedId(r.id);
                        setFullView(false);
                      }}
                    >
                      <div className="font-medium truncate">{idx + 1}. {label}</div>
                      <div className="text-[10px] text-ink-500 truncate mt-0.5">
                        {formatAppDateTime(r.captured_at ?? r.created_at)}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>

            <div className="flex-1 min-w-0 flex flex-col bg-ink-50">
              {!selected && (
                <div className="flex-1 grid place-items-center text-sm text-ink-500 p-6">
                  Select a screenshot from the list.
                </div>
              )}
              {selected && (
                <>
                  <div className="px-3 py-2 border-b border-ink-200 bg-white flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{shotTitle}</div>
                      {selected.screen_url && (
                        <div className="text-[11px] text-ink-500 font-mono truncate">{selected.screen_url}</div>
                      )}
                    </div>
                    <button
                      type="button"
                      className="btn-secondary text-xs shrink-0"
                      disabled={!src}
                      onClick={() => setFullView(true)}
                    >
                      Full view
                    </button>
                  </div>
                  <div className="flex-1 overflow-auto p-3">
                    {loading && <div className="h-64 bg-ink-100 animate-pulse rounded" />}
                    {err && <div className="text-sm text-ink-500">Screenshot unavailable</div>}
                    {src && !loading && (
                      <button
                        type="button"
                        className="block w-full text-left"
                        onClick={() => setFullView(true)}
                        title="Click for full view"
                      >
                        <img
                          src={src}
                          alt={shotTitle}
                          className="w-full h-auto rounded border border-ink-200 bg-white shadow-sm cursor-zoom-in"
                        />
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </section>
      </div>

      {fullView && src && (
        <FullImageViewer src={src} title={shotTitle} onClose={() => setFullView(false)} />
      )}
    </div>
  );
}
