import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { useProductionContext } from '@/store/productionContext';

type Profile = { id: number; profile_name: string; product_name: string; environment: string };

type MasterPromptSample = {
  id: string;
  label: string;
  description: string;
  product?: string;
  prompt: string;
};

type SamplesResponse = {
  recommended: MasterPromptSample[];
  other: MasterPromptSample[];
};

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
  const [sampleId, setSampleId] = useState('');

  const profile = profiles?.data?.find((p) => p.id === profileId) ?? null;

  const { data: samples } = useQuery<SamplesResponse>({
    queryKey: ['master-prompt-samples', profile?.product_name ?? ''],
    queryFn: async () =>
      (await api.get('/master-prompt-samples', {
        params: profile?.product_name ? { product_name: profile.product_name } : undefined,
      })).data,
  });

  const recommended = samples?.recommended ?? [];
  const other = samples?.other ?? [];
  const allSamples = useMemo(() => [...recommended, ...other], [recommended, other]);
  const selectedSample = allSamples.find((s) => s.id === sampleId);

  const applySample = (id: string) => {
    setSampleId(id);
    if (!id) return;
    const sample = allSamples.find((s) => s.id === id);
    if (!sample) return;
    setPrompt(sample.prompt);
    if (sample.product) {
      setTitle(`${sample.label} - ${new Date().toISOString().slice(0, 10)}`);
    }
  };

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
          <div className="flex flex-wrap items-end justify-between gap-3 mb-1">
            <label className="label mb-0">Master Prompt</label>
            <div className="min-w-[min(100%,280px)] flex-1 sm:flex-none">
              <label className="sr-only" htmlFor="prompt-sample">Sample prompt</label>
              <select
                id="prompt-sample"
                className="input text-ink-600"
                value={sampleId}
                onChange={(e) => applySample(e.target.value)}
                disabled={allSamples.length === 0}
              >
                <option value="">
                  {allSamples.length === 0 ? 'Loading samples...' : 'Choose a sample prompt...'}
                </option>
                {recommended.length > 0 && (
                  <optgroup label={`Recommended for ${profile?.profile_name ?? 'this profile'}`}>
                    {recommended.map((s) => (
                      <option key={s.id} value={s.id}>{s.label}</option>
                    ))}
                  </optgroup>
                )}
                <optgroup label={recommended.length > 0 ? 'Other samples' : 'Sample prompts'}>
                  {other.map((s) => (
                    <option key={s.id} value={s.id}>{s.label}</option>
                  ))}
                </optgroup>
              </select>
            </div>
          </div>
          {selectedSample?.description && (
            <p className="text-xs text-ink-500 mb-2">{selectedSample.description}</p>
          )}
          <textarea
            className="input min-h-[160px] font-mono"
            placeholder="e.g. Walk every menu of books.aicountly.com, observe UI/UX, list missing features vs Tally + Zoho Books, flag old-theme pages, suggest improvements."
            value={prompt}
            onChange={(e) => {
              setPrompt(e.target.value);
              if (sampleId) setSampleId('');
            }}
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
