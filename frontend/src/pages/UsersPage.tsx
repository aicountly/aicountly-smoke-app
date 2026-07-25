import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuthStore } from '@/store/auth';

const ROLES = ['owner', 'product_reviewer', 'developer_viewer', 'auditor_viewer'] as const;

type UserRow = {
  id: number;
  email: string;
  full_name: string;
  status: string;
  must_rotate_pw: boolean;
  last_login_at: string | null;
  created_at: string;
  roles: string[];
};

export function UsersPage() {
  const qc = useQueryClient();
  const isOwner = useAuthStore((s) => s.hasRole('owner'));
  const [form, setForm] = useState({ email: '', full_name: '', password: '', role: 'product_reviewer' });

  const { data, isLoading } = useQuery<{ data: UserRow[] }>({
    queryKey: ['users'],
    queryFn: async () => (await api.get('/users')).data,
    enabled: isOwner,
  });

  const createMut = useMutation({
    mutationFn: async () =>
      (await api.post('/users', {
        email: form.email,
        full_name: form.full_name,
        password: form.password,
        roles: [form.role],
      })).data,
    onSuccess: () => {
      setForm({ email: '', full_name: '', password: '', role: 'product_reviewer' });
      qc.invalidateQueries({ queryKey: ['users'] });
    },
  });

  const statusMut = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: string }) =>
      (await api.put(`/users/${id}`, { status })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });

  const roleMut = useMutation({
    mutationFn: async ({ id, role }: { id: number; role: string }) =>
      (await api.post(`/users/${id}/roles`, { role })).data,
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
          Portal accounts and roles. Most operators sign in via Console SSO; local users are for bootstrap and role assignment.
        </p>
      </div>

      <div className="card p-4 space-y-3">
        <div className="font-semibold text-sm">Create user</div>
        <div className="grid gap-2 sm:grid-cols-2">
          <input className="input" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <input className="input" placeholder="Full name" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
          <input className="input" type="password" placeholder="Password (≥12 chars)" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            {ROLES.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </div>
        <button
          className="btn-primary"
          disabled={createMut.isPending || form.password.length < 12 || !form.email || !form.full_name}
          onClick={() => createMut.mutate()}
        >
          {createMut.isPending ? 'Creating…' : 'Create user'}
        </button>
        {createMut.isError && <p className="text-sm text-red-600">Create failed — check email uniqueness and password length.</p>}
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
                  </div>
                  <select
                    className="input mt-1 text-xs py-1"
                    defaultValue=""
                    onChange={(e) => {
                      if (e.target.value) roleMut.mutate({ id: u.id, role: e.target.value });
                      e.target.value = '';
                    }}
                  >
                    <option value="">+ assign role</option>
                    {ROLES.filter((r) => !u.roles.includes(r)).map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
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
