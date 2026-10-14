import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuthStore } from '@/store/auth';

const CONSOLE_URL = 'https://console.aicountly.org';

type UserRow = {
  id: number;
  email: string;
  full_name: string;
  status: string;
  must_rotate_pw: boolean;
  last_login_at: string | null;
  created_at: string;
  roles: string[];
  console_user_id?: number | null;
  roles_synced_at?: string | null;
};

export function UsersPage() {
  const qc = useQueryClient();
  const isOwner = useAuthStore((s) => s.hasRole('owner'));

  const { data, isLoading } = useQuery<{ data: UserRow[] }>({
    queryKey: ['users'],
    queryFn: async () => (await api.get('/users')).data,
    enabled: isOwner,
  });

  const statusMut = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: string }) =>
      (await api.put(`/users/${id}`, { status })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });

  const disableMut = useMutation({
    mutationFn: async (id: number) => (await api.delete(`/users/${id}`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });

  if (!isOwner) {
    return <div className="text-sm text-ink-500">Owner access required.</div>;
  }

  return (
    <div className="space-y-4 max-w-5xl">
      <div>
        <h1 className="text-xl font-semibold">Users</h1>
        <p className="text-sm text-ink-500">
          People who have signed in to Smoke via Console SSO. Accounts are created on first sign-in.
        </p>
      </div>

      <div className="card p-4 text-sm">
        <div className="font-semibold">Roles are read-only here</div>
        <p className="text-ink-500 mt-1">
          Roles are assigned in Console → Roles &amp; Access (
          <a className="underline" href={CONSOLE_URL} target="_blank" rel="noreferrer">
            console.aicountly.org
          </a>
          ). Smoke picks up changes at the user&apos;s next sign-in or token refresh (within 15 minutes).
          You can still disable a user locally.
        </p>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-ink-600 text-left text-xs">
            <tr>
              <th className="px-4 py-2">Name</th>
              <th>Email</th>
              <th>Roles</th>
              <th>Status</th>
              <th>Last login</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td className="px-4 py-3 text-ink-500" colSpan={6}>Loading…</td></tr>
            )}
            {(data?.data ?? []).map((u) => (
              <tr key={u.id} className="border-t border-ink-200">
                <td className="px-4 py-2 font-medium">{u.full_name}</td>
                <td>{u.email}</td>
                <td>
                  <div className="flex flex-wrap gap-1">
                    {u.roles.map((r) => (
                      <span key={r} className="badge-neutral">{r}</span>
                    ))}
                    {u.roles.length === 0 && <span className="text-xs text-ink-500">none</span>}
                  </div>
                  <div className="text-[11px] text-ink-500 mt-1">
                    {u.roles_synced_at ? `Synced from Console ${u.roles_synced_at}` : 'Not yet synced from Console'}
                  </div>
                </td>
                <td>
                  <select
                    className="input text-xs py-1"
                    value={u.status}
                    onChange={(e) => statusMut.mutate({ id: u.id, status: e.target.value })}
                  >
                    <option value="active">active</option>
                    <option value="disabled">disabled</option>
                  </select>
                </td>
                <td className="text-xs text-ink-500">{u.last_login_at ?? '—'}</td>
                <td className="px-4 py-2 text-right">
                  {u.status !== 'disabled' && (
                    <button
                      className="btn-danger"
                      onClick={() => { if (confirm(`Disable ${u.email}?`)) disableMut.mutate(u.id); }}
                    >
                      Disable
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!isLoading && (data?.data?.length ?? 0) === 0 && (
              <tr><td className="px-4 py-3 text-ink-500" colSpan={6}>No users yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
