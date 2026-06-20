import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuthStore } from '@/store/auth';

type Session = {
  id: number;
  ordinal: number;
  name: string;
  menu_path: string;
  description: string;
  expected_screens: number;
  destructive_allowed: boolean;
  status: string;
};

type Plan = {
  data: { id: number; status: string; rationale: string; session_count: number };
  sessions: Session[];
};

export function SessionPlanPage() {
  const params = useParams();
  const id = Number(params.id);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const canApprove = useAuthStore((s) => s.hasRole('owner', 'product_reviewer'));

  const { data, refetch } = useQuery<Plan>({
    queryKey: ['plan', id],
    queryFn: async () => (await api.get(`/session-plans/${id}`)).data,
  });

  const [order, setOrder] = useState<number[]>([]);
  useEffect(() => {
    if (data?.sessions) setOrder(data.sessions.map((s) => s.id));
  }, [data]);

  const reorderMut = useMutation({
    mutationFn: async (newOrder: number[]) =>
      (await api.put(`/session-plans/${id}/reorder`, { order: newOrder })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plan', id] }),
  });

  const splitMut = useMutation({
    mutationFn: async (sid: number) => (await api.post(`/sessions/${sid}/split`, {})).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plan', id] }),
  });
  const deleteMut = useMutation({
    mutationFn: async (sid: number) => (await api.delete(`/sessions/${sid}`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plan', id] }),
  });

  const approveMut = useMutation({
    mutationFn: async () => (await api.post(`/session-plans/${id}/approve`, {})).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plan', id] }),
  });
  const startMut = useMutation({
    mutationFn: async () => (await api.post(`/session-plans/${id}/run`, {})).data,
    onSuccess: (r: { data: { id: number; run_code: string } }) => navigate(`/runs/${r.data.id}`),
  });

  function moveUp(index: number) {
    if (index <= 0) return;
    const next = [...order];
    [next[index - 1], next[index]] = [next[index], next[index - 1]];
    setOrder(next);
    reorderMut.mutate(next);
  }
  function moveDown(index: number) {
    if (index >= order.length - 1) return;
    const next = [...order];
    [next[index], next[index + 1]] = [next[index + 1], next[index]];
    setOrder(next);
    reorderMut.mutate(next);
  }

  if (!data) return <div className="text-sm text-ink-500">Loading...</div>;
  const sessionsById = new Map(data.sessions.map((s) => [s.id, s]));
  const ordered = order.map((i) => sessionsById.get(i)).filter(Boolean) as Session[];

  return (
    <div className="space-y-4 max-w-5xl">
      <div className="flex justify-between items-start">
        <div>
          <h1 className="text-xl font-semibold">Session Plan #{id}</h1>
          <p className="text-sm text-ink-500">{ordered.length} sessions &middot; status <span className="badge-brand">{data.data.status}</span></p>
        </div>
        <div className="flex gap-2">
          <button className="btn-secondary" onClick={() => refetch()}>Refresh</button>
          {canApprove && data.data.status === 'draft' && (
            <button className="btn-primary" onClick={() => approveMut.mutate()} disabled={approveMut.isPending}>
              {approveMut.isPending ? 'Approving...' : 'Approve plan'}
            </button>
          )}
          {canApprove && data.data.status === 'approved' && (
            <button className="btn-primary" onClick={() => startMut.mutate()} disabled={startMut.isPending}>
              {startMut.isPending ? 'Starting...' : 'Start observation run'}
            </button>
          )}
        </div>
      </div>

      {data.data.rationale && (
        <div className="card p-4 text-sm whitespace-pre-line">
          <div className="font-semibold mb-1">Rationale</div>
          {data.data.rationale}
        </div>
      )}

      <div className="card divide-y divide-ink-200">
        {ordered.map((s, i) => (
          <div key={s.id} className="p-4 flex items-start gap-4">
            <div className="flex flex-col gap-1">
              <button className="btn-secondary px-1 py-0" onClick={() => moveUp(i)} disabled={i === 0}>↑</button>
              <button className="btn-secondary px-1 py-0" onClick={() => moveDown(i)} disabled={i === ordered.length - 1}>↓</button>
            </div>
            <div className="flex-1">
              <div className="flex items-center justify-between">
                <div className="font-medium">{i + 1}. {s.name}</div>
                <div className="flex gap-2">
                  {s.destructive_allowed && <span className="badge-warning">destructive</span>}
                  <span className="badge-neutral">{s.expected_screens} screens</span>
                </div>
              </div>
              {s.menu_path && <div className="text-xs text-ink-500 font-mono">{s.menu_path}</div>}
              {s.description && <div className="text-sm mt-1">{s.description}</div>}
              <div className="flex gap-2 mt-2">
                <button className="btn-secondary" onClick={() => splitMut.mutate(s.id)}>Split</button>
                <button className="btn-danger" onClick={() => { if (confirm('Delete this session?')) deleteMut.mutate(s.id); }}>Delete</button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
