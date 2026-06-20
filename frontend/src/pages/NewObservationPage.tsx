import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { useProductionContext } from '@/store/productionContext';

type Profile = { id: number; profile_name: string; product_name: string; environment: string };

export function NewObservationPage() {
  const navigate = useNavigate();
  const setActiveEnv = useProductionContext((s) => s.setActiveEnvironment);

  const { data: profiles } = useQuery<{ data: Profile[] }>({
    queryKey: ['target-profiles'],
    queryFn: async () => (await api.get('/target-profiles')).data,
  });

  const [profileId, setProfileId] = useState<number | null>(null);
  const [title, setTitle] = useState('Observation - ' + new Date().toISOString().slice(0, 10));
  const [environment, setEnvironment] = useState('sandbox');
  const [prompt, setPrompt] = useState('');

  const profile = profiles?.data?.find((p) => p.id === profileId) ?? null;

  useEffect(() => {
    if (profile) setEnvironment(profile.environment);
  }, [profile]);

  useEffect(() => {
    setActiveEnv(environment);
    return () => setActiveEnv(null);
  }, [environment, setActiveEnv]);

  const submit = useMutation({
    mutationFn: async () =>
      (await api.post('/master-prompts', {
        target_profile_id: profileId,
        environment,
        title,
        prompt_text: prompt,
      })).data,
    onSuccess: (r: { plan_id: number }) => navigate(`/session-plans/${r.plan_id}`),
  });

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold">New Observation</h1>
        <p className="text-sm text-ink-500">
          Submit a master prompt &mdash; the AI council will return a proposed module-wise session plan
          for you to review and approve.
        </p>
      </div>

      <div className="card p-6 space-y-4">
        <div>
          <label className="label">Title</label>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Target App Profile</label>
            <select className="input" value={profileId ?? ''} onChange={(e) => setProfileId(Number(e.target.value) || null)}>
              <option value="">Select...</option>
              {(profiles?.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>{p.profile_name} ({p.product_name})</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Environment</label>
            <select className="input" value={environment} onChange={(e) => setEnvironment(e.target.value)}>
              <option value="sandbox">Sandbox</option>
              <option value="gh_staging">GH / Staging</option>
              <option value="production_readonly">Production Read-Only</option>
              <option value="production_restricted">Production Restricted</option>
            </select>
          </div>
        </div>

        <div>
          <label className="label">Master Prompt</label>
          <textarea
            className="input min-h-[160px] font-mono"
            placeholder="e.g. Walk every menu of books.aicountly.com, observe UI/UX, list missing features vs Tally + Zoho Books, flag old-theme pages, suggest improvements."
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </div>

        <div className="flex justify-end">
          <button className="btn-primary" disabled={!profileId || !prompt.trim() || submit.isPending} onClick={() => submit.mutate()}>
            {submit.isPending ? 'Generating plan...' : 'Generate session plan'}
          </button>
        </div>
      </div>
    </div>
  );
}
