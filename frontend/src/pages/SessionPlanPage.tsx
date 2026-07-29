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
  allowed_actions_json: string | string[];
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
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState({ name: '', menu_path: '', description: '', expected_screens: 1, destructive_allowed: false });
  const [adding, setAdding] = useState(false);
  const [addForm, setAddForm] = useState({ name: '', menu_path: '', description: '', expected_screens: 4 });
  const [rejectReason, setRejectReason] = useState('');

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
  const mergeMut = useMutation({
    mutationFn: async ({ sid, mergeWith }: { sid: number; mergeWith: number }) =>
      (await api.post(`/sessions/${sid}/merge`, { merge_with: mergeWith })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plan', id] }),
  });
  const updateSessionMut = useMutation({
    mutationFn: async ({ sid, body }: { sid: number; body: typeof editForm }) =>
      (await api.put(`/sessions/${sid}`, body)).data,
    onSuccess: () => {
      setEditingId(null);
      qc.invalidateQueries({ queryKey: ['plan', id] });
    },
  });
  const addSessionMut = useMutation({
    mutationFn: async (body: typeof addForm) =>
      (await api.post(`/session-plans/${id}/sessions`, body)).data,
    onSuccess: () => {
      setAdding(false);
      setAddForm({ name: '', menu_path: '', description: '', expected_screens: 4 });
      qc.invalidateQueries({ queryKey: ['plan', id] });
    },
  });

  const approveMut = useMutation({
    mutationFn: async () => (await api.post(`/session-plans/${id}/approve`, {})).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plan', id] }),
  });
  const rejectMut = useMutation({
    mutationFn: async (reason: string) =>
      (await api.post(`/session-plans/${id}/reject`, { reason })).data,
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

  function beginEdit(s: Session) {
    setEditingId(s.id);
    setEditForm({
      name: s.name,
      menu_path: s.menu_path ?? '',
      description: s.description ?? '',
      expected_screens: s.expected_screens || 1,
      destructive_allowed: s.destructive_allowed,
    });
  }

  if (!data) return <div className="text-sm text-ink-500">Loading...</div>;
  const sessionsById = new Map(data.sessions.map((s) => [s.id, s]));
  const ordered = order.map((i) => sessionsById.get(i)).filter(Boolean) as Session[];
  const editable = canApprove && data.data.status === 'draft';

  return (
    <div className="space-y-4 max-w-5xl">
      <div className="flex justify-between items-start">
        <div>
          <h1 className="text-xl font-semibold">Session Plan #{id}</h1>
          <p className="text-sm text-ink-500">{ordered.length} sessions &middot; status <span className="badge-brand">{data.data.status}</span></p>
        </div>
        <div className="flex gap-2 flex-wrap justify-end">
          <button className="btn-secondary" onClick={() => refetch()}>Refresh</button>
          {editable && (
            <>
              <button className="btn-secondary" onClick={() => setAdding((v) => !v)}>
                {adding ? 'Cancel add' : '+ Add session'}
              </button>
              <button
                className="btn-danger"
                onClick={() => {
                  const reason = rejectReason || window.prompt('Reject reason (optional):') || '';
                  setRejectReason(reason);
                  if (confirm('Reject this session plan?')) rejectMut.mutate(reason);
                }}
                disabled={rejectMut.isPending}
              >
                Reject
              </button>
              <button className="btn-primary" onClick={() => approveMut.mutate()} disabled={approveMut.isPending}>
                {approveMut.isPending ? 'Approving...' : 'Approve plan'}
              </button>
            </>
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

      {adding && editable && (
        <div className="card p-4 space-y-2">
          <div className="font-semibold text-sm">New session</div>
          <input className="input" placeholder="Name" value={addForm.name} onChange={(e) => setAddForm({ ...addForm, name: e.target.value })} />
          <input className="input font-mono text-xs" placeholder="Menu path" value={addForm.menu_path} onChange={(e) => setAddForm({ ...addForm, menu_path: e.target.value })} />
          <textarea className="input" placeholder="Description" rows={2} value={addForm.description} onChange={(e) => setAddForm({ ...addForm, description: e.target.value })} />
          <label className="block text-sm">
            <span className="font-medium">Est. screens</span>
            <input
              className="input w-32 mt-1"
              type="number"
              min={1}
              value={addForm.expected_screens}
              onChange={(e) => setAddForm({ ...addForm, expected_screens: Number(e.target.value) || 1 })}
            />
          </label>
          <div className="text-xs text-ink-500">Planning estimate only — the worker visits discovered menus up to a safety max.</div>
          <button
            className="btn-primary"
            disabled={!addForm.name.trim() || addSessionMut.isPending}
            onClick={() => addSessionMut.mutate(addForm)}
          >
            Save session
          </button>
        </div>
      )}

      <div className="card divide-y divide-ink-200">
        {ordered.map((s, i) => (
          <div key={s.id} className="p-4 flex items-start gap-4">
            <div className="flex flex-col gap-1">
              <button className="btn-secondary px-1 py-0" onClick={() => moveUp(i)} disabled={!editable || i === 0}>↑</button>
              <button className="btn-secondary px-1 py-0" onClick={() => moveDown(i)} disabled={!editable || i === ordered.length - 1}>↓</button>
            </div>
            <div className="flex-1">
              {editingId === s.id ? (
                <div className="space-y-2">
                  <input className="input" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
                  <input className="input font-mono text-xs" value={editForm.menu_path} onChange={(e) => setEditForm({ ...editForm, menu_path: e.target.value })} />
                  <textarea className="input" rows={2} value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} />
                  <label className="block text-sm">
                    <span className="font-medium">Est. screens</span>
                    <input
                      className="input w-32 mt-1"
                      type="number"
                      min={1}
                      value={editForm.expected_screens}
                      onChange={(e) => setEditForm({ ...editForm, expected_screens: Number(e.target.value) || 1 })}
                    />
                  </label>
                  <div className="text-xs text-ink-500">Planning estimate only — the worker visits discovered menus up to a safety max.</div>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={editForm.destructive_allowed}
                      onChange={(e) => setEditForm({ ...editForm, destructive_allowed: e.target.checked })}
                    />
                    Allow destructive actions
                  </label>
                  {editForm.destructive_allowed && (
                    <div className="text-xs text-amber-700">Only sandbox, GH / staging or production full-access profiles with safe demo enabled can run uploads or imports.</div>
                  )}
                  <div className="flex gap-2">
                    <button className="btn-primary" onClick={() => updateSessionMut.mutate({ sid: s.id, body: editForm })} disabled={updateSessionMut.isPending}>Save</button>
                    <button className="btn-secondary" onClick={() => setEditingId(null)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between">
                    <div className="font-medium">{i + 1}. {s.name}</div>
                    <div className="flex gap-2">
                      {s.destructive_allowed && <span className="badge-warning">destructive</span>}
                      {sessionActions(s).some((action) => ['upload_file', 'import_file'].includes(action)) && (
                        <span className="badge-warning">File I/O requires safe demo</span>
                      )}
                      <span className="badge-neutral">Est. screens: {s.expected_screens}</span>
                    </div>
                  </div>
                  {s.menu_path && <div className="text-xs text-ink-500 font-mono">{s.menu_path}</div>}
                  {s.description && <div className="text-sm mt-1">{s.description}</div>}
                  {editable && (
                    <div className="flex gap-2 mt-2 flex-wrap">
                      <button className="btn-secondary" onClick={() => beginEdit(s)}>Edit</button>
                      <button className="btn-secondary" onClick={() => splitMut.mutate(s.id)}>Split</button>
                      {i < ordered.length - 1 && (
                        <button
                          className="btn-secondary"
                          onClick={() => {
                            if (confirm(`Merge "${s.name}" with next session "${ordered[i + 1].name}"?`)) {
                              mergeMut.mutate({ sid: s.id, mergeWith: ordered[i + 1].id });
                            }
                          }}
                        >
                          Merge with next
                        </button>
                      )}
                      <button className="btn-danger" onClick={() => { if (confirm('Delete this session?')) deleteMut.mutate(s.id); }}>Delete</button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        ))}
        {ordered.length === 0 && (
          <div className="p-4 text-sm text-ink-500">No sessions in this plan yet.</div>
        )}
      </div>
    </div>
  );
}

function sessionActions(session: Session): string[] {
  if (Array.isArray(session.allowed_actions_json)) return session.allowed_actions_json;
  try {
    const parsed = JSON.parse(session.allowed_actions_json || '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
