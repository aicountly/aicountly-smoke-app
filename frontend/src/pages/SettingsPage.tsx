import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuthStore } from '@/store/auth';

type Setting = { id: number; key: string; value_json: string; description: string; is_secret: boolean };

export function SettingsPage() {
  const qc = useQueryClient();
  const isOwner = useAuthStore((s) => s.hasRole('owner'));
  const { data } = useQuery<{ data: Setting[] }>({
    queryKey: ['settings'],
    queryFn: async () => (await api.get('/settings')).data,
  });

  const update = useMutation({
    mutationFn: async ({ key, value }: { key: string; value: unknown }) =>
      (await api.put(`/settings/${encodeURIComponent(key)}`, { value })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  });

  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm text-ink-500">Brain providers, search provider, run-counter and theme. Owner can edit; reviewers can view.</p>
      </div>

      <div className="card divide-y divide-ink-200">
        {(data?.data ?? []).map((s) => {
          let parsed: unknown;
          try { parsed = JSON.parse(s.value_json); } catch { parsed = s.value_json; }
          return (
            <div key={s.id} className="p-4">
              <div className="flex items-baseline justify-between">
                <div>
                  <div className="font-mono text-sm">{s.key}</div>
                  <div className="text-xs text-ink-500">{s.description}</div>
                </div>
                {s.is_secret && <span className="badge-warning">secret</span>}
              </div>
              <div className="mt-2">
                <textarea
                  className="input font-mono text-xs"
                  defaultValue={typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2)}
                  disabled={!isOwner}
                  onBlur={(e) => {
                    if (!isOwner) return;
                    let v: unknown = e.target.value;
                    try { v = JSON.parse(e.target.value); } catch { /* leave as raw string */ }
                    update.mutate({ key: s.key, value: v });
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
