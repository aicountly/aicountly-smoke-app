import { Fragment, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatAppDateTime } from '@/lib/datetime';

type AuditRow = {
  id: number;
  action: string;
  entity: string;
  entity_id: string | null;
  ip: string | null;
  created_at: string;
  payload_json: string | Record<string, unknown> | null;
  user_email: string | null;
  user_agent?: string | null;
};

type AuditListResponse = {
  data: AuditRow[];
  page: number;
  size: number;
  total: number;
};

type SourceFilter = 'semantic' | 'http' | 'all';

type FilterState = {
  action: string;
  entity: string;
  user: string;
  date_from: string;
  date_to: string;
  exclude_worker: boolean;
  source: SourceFilter;
  has_user: boolean;
};

const PAGE_SIZE = 50;

const DEFAULT_FILTERS: FilterState = {
  action: '',
  entity: '',
  user: '',
  date_from: '',
  date_to: '',
  exclude_worker: true,
  source: 'semantic',
  has_user: false,
};

function activeFilters(filters: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(filters).filter(([, v]) => v.trim() !== ''));
}

function parsePayload(payload: AuditRow['payload_json']): Record<string, unknown> | null {
  if (payload == null || payload === '') return null;
  if (typeof payload === 'object') return payload as Record<string, unknown>;
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function payloadStatus(payload: AuditRow['payload_json']): string | number | null {
  const parsed = parsePayload(payload);
  if (!parsed || parsed.status == null || parsed.status === '') return null;
  return parsed.status as string | number;
}

function actionBadgeClass(action: string): string {
  const m = action.match(/^(GET|POST|PUT|PATCH|DELETE)\b/i);
  if (!m) return 'badge-brand';
  switch (m[1].toUpperCase()) {
    case 'GET':
      return 'badge-info';
    case 'POST':
      return 'badge-brand';
    case 'PUT':
    case 'PATCH':
      return 'badge-warning';
    case 'DELETE':
      return 'badge-danger';
    default:
      return 'badge-neutral';
  }
}

function prettyPayload(payload: AuditRow['payload_json']): string {
  const parsed = parsePayload(payload);
  if (parsed) return JSON.stringify(parsed, null, 2);
  if (typeof payload === 'string' && payload.trim()) return payload;
  return '—';
}

export function AuditLogsPage() {
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [debouncedText, setDebouncedText] = useState({
    action: '',
    entity: '',
    user: '',
  });
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => {
      setDebouncedText({
        action: filters.action,
        entity: filters.entity,
        user: filters.user,
      });
    }, 300);
    return () => window.clearTimeout(t);
  }, [filters.action, filters.entity, filters.user]);

  useEffect(() => {
    setPage(1);
    setExpandedId(null);
  }, [
    debouncedText.action,
    debouncedText.entity,
    debouncedText.user,
    filters.date_from,
    filters.date_to,
    filters.exclude_worker,
    filters.source,
    filters.has_user,
  ]);

  function setF<K extends keyof FilterState>(k: K, v: FilterState[K]) {
    setFilters((f) => ({ ...f, [k]: v }));
  }

  const queryParams = activeFilters({
    action: debouncedText.action,
    entity: debouncedText.entity,
    user: debouncedText.user,
    date_from: filters.date_from,
    date_to: filters.date_to,
    exclude_worker: filters.exclude_worker ? '1' : '0',
    source: filters.source,
    has_user: filters.has_user ? '1' : '',
    page: String(page),
    size: String(PAGE_SIZE),
  });

  const { data, isLoading, isError, error } = useQuery<AuditListResponse>({
    queryKey: ['audit-logs', queryParams],
    queryFn: async () => (await api.get('/audit-logs', { params: queryParams })).data,
  });

  const rows = data?.data ?? [];
  const total = data?.total ?? 0;
  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, total);
  const canPrev = page > 1;
  const canNext = to < total;

  const hasNarrowingFilters =
    debouncedText.action.trim() !== '' ||
    debouncedText.entity.trim() !== '' ||
    debouncedText.user.trim() !== '' ||
    filters.date_from !== '' ||
    filters.date_to !== '' ||
    filters.exclude_worker ||
    filters.source !== 'all' ||
    filters.has_user;

  const clearFilters = () => {
    setFilters(DEFAULT_FILTERS);
    setDebouncedText({ action: '', entity: '', user: '' });
    setPage(1);
    setExpandedId(null);
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Audit Logs</h1>
        <p className="text-sm text-ink-500">Who changed what in Smoke — redacted payloads included.</p>
      </div>

      <div className="card p-3 flex flex-wrap gap-3 items-end">
        <div>
          <label className="label">Date from</label>
          <input
            type="date"
            className="input"
            value={filters.date_from}
            onChange={(e) => setF('date_from', e.target.value)}
          />
        </div>
        <div>
          <label className="label">Date to</label>
          <input
            type="date"
            className="input"
            value={filters.date_to}
            onChange={(e) => setF('date_to', e.target.value)}
          />
        </div>
        <div>
          <label className="label">Action</label>
          <input
            className="input"
            value={filters.action}
            onChange={(e) => setF('action', e.target.value)}
            placeholder="e.g. users.create"
          />
        </div>
        <div>
          <label className="label">Entity</label>
          <input
            className="input"
            value={filters.entity}
            onChange={(e) => setF('entity', e.target.value)}
            placeholder="e.g. runs"
          />
        </div>
        <div>
          <label className="label">User</label>
          <input
            className="input"
            value={filters.user}
            onChange={(e) => setF('user', e.target.value)}
            placeholder="email"
          />
        </div>
        <div>
          <label className="label">Event type</label>
          <select
            className="input"
            value={filters.source}
            onChange={(e) => setF('source', e.target.value as SourceFilter)}
          >
            <option value="semantic">Semantic</option>
            <option value="http">Raw API</option>
            <option value="all">All</option>
          </select>
        </div>
        <label className="flex items-center gap-2 text-sm text-ink-700 pb-2 cursor-pointer">
          <input
            type="checkbox"
            checked={filters.exclude_worker}
            onChange={(e) => setF('exclude_worker', e.target.checked)}
          />
          Hide worker
        </label>
        <label className="flex items-center gap-2 text-sm text-ink-700 pb-2 cursor-pointer">
          <input
            type="checkbox"
            checked={filters.has_user}
            onChange={(e) => setF('has_user', e.target.checked)}
          />
          Has user
        </label>
        <button type="button" className="btn-secondary" onClick={clearFilters}>
          Clear filters
        </button>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-ink-600 text-left">
            <tr>
              <th className="px-4 py-2">When</th>
              <th>User</th>
              <th>Action</th>
              <th>Entity</th>
              <th>Entity ID</th>
              <th>IP</th>
              <th>Status</th>
              <th className="pr-4 w-8" aria-label="Expand" />
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-ink-500">
                  Loading audit logs…
                </td>
              </tr>
            )}
            {isError && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-red-700">
                  Failed to load audit logs
                  {(error as Error)?.message ? `: ${(error as Error).message}` : '.'}
                </td>
              </tr>
            )}
            {!isLoading &&
              !isError &&
              rows.map((r) => {
                const open = expandedId === r.id;
                const status = payloadStatus(r.payload_json);
                return (
                  <Fragment key={r.id}>
                    <tr
                      className={
                        'border-t border-ink-200 cursor-pointer hover:bg-ink-50 ' +
                        (open ? 'bg-ink-50/60' : '')
                      }
                      onClick={() => setExpandedId(open ? null : r.id)}
                    >
                      <td className="px-4 py-2 text-xs whitespace-nowrap">
                        {formatAppDateTime(r.created_at) || '—'}
                      </td>
                      <td>{r.user_email ?? '—'}</td>
                      <td>
                        <span className={actionBadgeClass(r.action)}>{r.action}</span>
                      </td>
                      <td>{r.entity || '—'}</td>
                      <td className="font-mono text-xs">{r.entity_id ? r.entity_id : '—'}</td>
                      <td className="text-xs">{r.ip ?? '—'}</td>
                      <td className="text-xs font-mono">{status != null ? String(status) : '—'}</td>
                      <td className="pr-4 text-ink-400" aria-hidden>
                        {open ? '▾' : '▸'}
                      </td>
                    </tr>
                    {open && (
                      <tr className="border-t border-ink-100 bg-ink-50/40">
                        <td colSpan={8} className="px-4 py-3">
                          <div className="space-y-2 text-xs">
                            <div className="text-ink-600">
                              <span className="font-medium text-ink-700">Action:</span>{' '}
                              <span className="font-mono">{r.action}</span>
                              {' · '}
                              <span className="font-medium text-ink-700">When:</span>{' '}
                              {formatAppDateTime(r.created_at) || r.created_at}
                            </div>
                            {r.user_agent ? (
                              <div className="text-ink-600 break-all">
                                <span className="font-medium text-ink-700">User agent:</span>{' '}
                                {r.user_agent}
                              </div>
                            ) : null}
                            <div>
                              <div className="font-medium text-ink-700 mb-1">Payload</div>
                              <pre className="rounded-md border border-ink-200 bg-white p-3 overflow-auto max-h-64 text-[11px] font-mono text-ink-800 whitespace-pre-wrap break-all">
                                {prettyPayload(r.payload_json)}
                              </pre>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            {!isLoading && !isError && rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-ink-500 space-y-1">
                  {hasNarrowingFilters ? (
                    <>
                      <div>No audit log entries match these filters.</div>
                      <div className="text-xs">
                        Try switching Event type to All, or turn off Hide worker to include raw API /
                        worker traffic.
                      </div>
                    </>
                  ) : (
                    <div>No audit log entries.</div>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {!isLoading && !isError && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-ink-600">
          <div>
            Page {page} · showing {from}–{to} of {total}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-secondary"
              disabled={!canPrev}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Prev
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={!canNext}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
