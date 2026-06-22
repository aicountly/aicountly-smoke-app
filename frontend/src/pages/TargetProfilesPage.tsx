import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { SAAS_PRODUCTS, SAAS_PRODUCT_SLUGS, type SaasProductOption } from '@/lib/products';

type TargetProfile = {
  id: number;
  profile_name: string;
  product_name: string;
  environment: string;
  base_url: string;
  login_url: string;
  username: string;
  observer_mode: boolean;
  read_only: boolean;
  production_restriction: boolean;
  allow_safe_demo: boolean;
  status: string;
};


const ENVIRONMENTS = [
  { v: 'sandbox',                label: 'Sandbox' },
  { v: 'gh_staging',             label: 'GH / Staging' },
  { v: 'production_readonly',    label: 'Production Read-Only' },
  { v: 'production_restricted',  label: 'Production Restricted' },
];

export function TargetProfilesPage() {
  const qc = useQueryClient();
  const canEdit = useAuthStore((s) => s.hasRole('owner', 'product_reviewer'));
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [edit, setEdit] = useState<Partial<TargetProfile> & { password?: string }>({});

  const { data } = useQuery<{ data: TargetProfile[] }>({
    queryKey: ['target-profiles'],
    queryFn: async () => (await api.get('/target-profiles')).data,
  });

  const createMut = useMutation({
    mutationFn: async (body: Partial<TargetProfile> & { password?: string }) =>
      (await api.post('/target-profiles', body)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['target-profiles'] });
      setDrawerOpen(false);
      setEdit({});
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Target App Profiles</h1>
          <p className="text-sm text-ink-500">Approved AICOUNTLY apps the bot may log into in observer mode.</p>
        </div>
        {canEdit && (
          <button className="btn-primary" onClick={() => { setEdit({}); setDrawerOpen(true); }}>+ New profile</button>
        )}
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-ink-600 text-left">
            <tr>
              <th className="px-4 py-2">Profile</th>
              <th>Product</th>
              <th>Environment</th>
              <th>Base URL</th>
              <th>Username</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(data?.data ?? []).map((p) => (
              <tr key={p.id} className="border-t border-ink-200">
                <td className="px-4 py-2 font-medium">{p.profile_name}</td>
                <td>{SAAS_PRODUCTS.find((x) => x.slug === p.product_name)?.label ?? p.product_name}</td>
                <td>
                  <span className={'badge-' + (p.environment.startsWith('production') ? 'danger' : 'brand')}>
                    {p.environment}
                  </span>
                </td>
                <td className="font-mono text-xs">{p.base_url}</td>
                <td>{p.username}</td>
                <td><span className="badge-neutral">{p.status}</span></td>
                <td className="text-right pr-4">
                  {canEdit && (
                    <button className="btn-secondary" onClick={() => { setEdit(p); setDrawerOpen(true); }}>Edit</button>
                  )}
                </td>
              </tr>
            ))}
            {(data?.data?.length ?? 0) === 0 && (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-ink-500">No target profiles yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {drawerOpen && (
        <div className="fixed inset-0 bg-ink-900/30 z-40 flex justify-end">
          <div className="w-full max-w-lg bg-white shadow-2xl border-l border-ink-200 p-6 overflow-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">{edit.id ? 'Edit profile' : 'New target profile'}</h2>
              <button className="btn-secondary" onClick={() => setDrawerOpen(false)}>Close</button>
            </div>
            <ProfileForm
              value={edit}
              onChange={setEdit}
              onSubmit={() => createMut.mutate(edit)}
              loading={createMut.isPending}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function ProfileForm({ value, onChange, onSubmit, loading }: {
  value: Partial<TargetProfile> & { password?: string };
  onChange: (v: Partial<TargetProfile> & { password?: string }) => void;
  onSubmit: () => void;
  loading: boolean;
}) {
  const productOptions: SaasProductOption[] = [...SAAS_PRODUCTS];
  if (value.product_name && !SAAS_PRODUCT_SLUGS.includes(value.product_name as typeof SAAS_PRODUCT_SLUGS[number])) {
    productOptions.unshift({ slug: value.product_name, label: `${value.product_name} (legacy)` });
  }

  function bind<K extends keyof typeof value>(k: K) {
    return {
      value: (value[k] ?? '') as string,
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
        onChange({ ...value, [k]: e.target.value as never }),
    };
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(); }} className="space-y-3">
      <div><label className="label">Profile name</label><input className="input" required {...bind('profile_name')} /></div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Product</label>
          <select className="input" required {...bind('product_name')}>
            <option value="">Select...</option>
            {productOptions.map((p) => <option key={p.slug} value={p.slug}>{p.label}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Environment</label>
          <select className="input" required {...bind('environment')}>
            <option value="">Select...</option>
            {ENVIRONMENTS.map((e) => <option key={e.v} value={e.v}>{e.label}</option>)}
          </select>
        </div>
      </div>
      <div><label className="label">Base URL</label><input className="input" required {...bind('base_url')} /></div>
      <div><label className="label">Login URL</label><input className="input" required {...bind('login_url')} /></div>
      <div className="grid grid-cols-2 gap-3">
        <div><label className="label">Username</label><input className="input" required {...bind('username')} /></div>
        <div><label className="label">Password</label><input className="input" type="password" placeholder={value.id ? 'leave blank to keep' : ''} {...bind('password')} /></div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!value.observer_mode} onChange={(e) => onChange({ ...value, observer_mode: e.target.checked })} /> Observer mode</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!value.read_only} onChange={(e) => onChange({ ...value, read_only: e.target.checked })} /> Read-only</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!value.production_restriction} onChange={(e) => onChange({ ...value, production_restriction: e.target.checked })} /> Production restriction</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!value.allow_safe_demo} onChange={(e) => onChange({ ...value, allow_safe_demo: e.target.checked })} /> Allow safe demo</label>
      </div>

      <button className="btn-primary" type="submit" disabled={loading}>{loading ? 'Saving...' : 'Save profile'}</button>
    </form>
  );
}
