import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';

type AuditRow = { id: number; action: string; entity: string; entity_id: string; ip: string; user_email: string; created_at: string; payload_json: string };

export function AuditLogsPage() {
  const [filters, setFilters] = useState<Record<string, string>>({});
  const { data } = useQuery<{ data: AuditRow[] }>({
    queryKey: ['audit-logs', filters],
    queryFn: async () => (await api.get('/audit-logs', { params: filters })).data,
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Audit Logs</h1>
        <p className="text-sm text-ink-500">Authenticated actions with redacted payloads.</p>
      </div>

      <div className="card p-3 flex flex-wrap gap-3 items-end">
        <div><label className="label">Action</label><input className="input" value={filters.action ?? ''} onChange={(e) => setFilters({ ...filters, action: e.target.value })} /></div>
        <div><label className="label">Entity</label><input className="input" value={filters.entity ?? ''} onChange={(e) => setFilters({ ...filters, entity: e.target.value })} /></div>
        <div><label className="label">User</label><input className="input" value={filters.user ?? ''} onChange={(e) => setFilters({ ...filters, user: e.target.value })} /></div>
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
            </tr>
          </thead>
          <tbody>
            {(data?.data ?? []).map((r) => (
              <tr key={r.id} className="border-t border-ink-200">
                <td className="px-4 py-2 text-xs">{r.created_at}</td>
                <td>{r.user_email ?? '—'}</td>
                <td className="font-mono text-xs">{r.action}</td>
                <td>{r.entity}</td>
                <td className="font-mono text-xs">{r.entity_id}</td>
                <td>{r.ip}</td>
              </tr>
            ))}
            {(data?.data?.length ?? 0) === 0 && (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-ink-500">No audit log entries.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
