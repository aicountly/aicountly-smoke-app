import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type DecisionOption = {
  id: string;
  label?: string;
  action?: string;
  [key: string]: unknown;
};

export type RunDecision = {
  id: number;
  run_id: number;
  session_id: number;
  job_id: number;
  situation_key: string;
  question: string;
  options: DecisionOption[];
  context: Record<string, unknown>;
  screenshot_path?: string | null;
  has_screenshot?: boolean;
  status: string;
  selected_option?: string | null;
  free_text?: string | null;
  remember?: boolean;
  source?: string;
};

type AnswerBody = {
  selected_option: string;
  free_text?: string;
  remember?: boolean;
};

const SITUATION_LABELS: Record<string, string> = {
  company_picker_empty: 'No companies found',
  company_picker_ambiguous: 'Company not identified on picker',
  company_picker_unreadable: 'Companies listed but not identifiable',
  company_picker_click_blocked: 'Company picker blocked',
};

function situationLabel(key: string): string {
  if (!key) return 'Decision needed';
  if (SITUATION_LABELS[key]) return SITUATION_LABELS[key];
  if (key.startsWith('click_intercepted:')) {
    const label = key.slice('click_intercepted:'.length).trim();
    return label ? `Click blocked: ${label}` : 'Click blocked';
  }
  return key.replace(/_/g, ' ');
}

function contextSnippet(ctx: Record<string, unknown>): string {
  const parts: string[] = [];
  const url = String(ctx.url ?? ctx.page_url ?? '').trim();
  const title = String(ctx.title ?? ctx.page_title ?? '').trim();
  const error = String(ctx.error ?? ctx.message ?? '').trim();
  const labels = ctx.labels;
  if (title) parts.push(title);
  if (url) parts.push(url);
  if (error) parts.push(error);
  if (Array.isArray(labels) && labels.length > 0) {
    parts.push(labels.map(String).filter(Boolean).slice(0, 4).join(', '));
  }
  if (parts.length === 0) {
    const keys = Object.keys(ctx).filter((k) => !['source', 'recommended'].includes(k)).slice(0, 3);
    for (const k of keys) {
      const v = ctx[k];
      if (v == null || typeof v === 'object') continue;
      parts.push(`${k}: ${String(v)}`);
    }
  }
  return parts.join(' · ');
}

function useDecisionScreenshot(runId: number, decisionId: number, enabled: boolean) {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setSrc(null);
      setErr(false);
      setLoading(false);
      return;
    }
    let objectUrl: string | null = null;
    let cancelled = false;
    setLoading(true);
    setErr(false);
    setSrc(null);
    (async () => {
      try {
        const res = await api.get(`/runs/${runId}/decisions/${decisionId}/screenshot`, {
          responseType: 'blob',
        });
        if (cancelled) return;
        objectUrl = URL.createObjectURL(res.data as Blob);
        setSrc(objectUrl);
      } catch {
        if (!cancelled) setErr(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [runId, decisionId, enabled]);

  return { src, err, loading };
}

export function PendingDecisionCard({
  runId,
  decision,
  sessionName,
  canAnswer,
  onAnswered,
}: {
  runId: number;
  decision: RunDecision;
  sessionName?: string | null;
  canAnswer: boolean;
  onAnswered: () => void;
}) {
  const recommended = String(decision.context?.recommended ?? '').trim();
  const [selected, setSelected] = useState(recommended);
  const [note, setNote] = useState('');
  const [remember, setRemember] = useState(true);
  const hasScreenshot = Boolean(decision.has_screenshot || decision.screenshot_path);
  const shot = useDecisionScreenshot(runId, decision.id, hasScreenshot);

  useEffect(() => {
    setSelected(String(decision.context?.recommended ?? '').trim());
    setNote('');
    setRemember(true);
  }, [decision.id, decision.context?.recommended]);

  const answerMut = useMutation({
    mutationFn: async (body: AnswerBody) =>
      (await api.post(`/runs/${runId}/decisions/${decision.id}/answer`, body)).data,
    onSuccess: () => onAnswered(),
  });

  const options = Array.isArray(decision.options) ? decision.options : [];
  const snippet = contextSnippet(decision.context ?? {});
  // Some options only mean something with a value the worker cannot know, such as the
  // exact company name to open. Submitting one without a note answers nothing.
  const noteRequired = options.some((opt) => String(opt.id ?? '') === selected && opt.requires_note === true);
  const errorMsg =
    (answerMut.error as { response?: { data?: { message?: string } } } | null)?.response?.data
      ?.message ?? 'Could not submit decision. Try again.';

  return (
    <div className="card sticky top-2 z-20 border-amber-300 bg-amber-50/90 shadow-md overflow-hidden">
      <div className="px-4 py-2 bg-amber-100/80 text-amber-950 text-sm font-semibold flex flex-wrap gap-2 items-center justify-between">
        <span>Worker needs a decision</span>
        <span className="text-xs font-normal text-amber-800">
          {sessionName ? `Session: ${sessionName}` : `Session #${decision.session_id}`}
          {decision.situation_key ? ` · ${situationLabel(decision.situation_key)}` : ''}
        </span>
      </div>
      <div className="p-4 space-y-3">
        <p className="text-sm font-medium text-ink-900">{decision.question}</p>
        {snippet ? <p className="text-xs text-ink-600 break-words">{snippet}</p> : null}
        {hasScreenshot ? (
          <div className="rounded-md border border-amber-200 bg-white/80 overflow-hidden">
            {shot.loading && (
              <div className="px-3 py-8 text-center text-xs text-ink-500">Loading screenshot…</div>
            )}
            {shot.src ? (
              <img
                src={shot.src}
                alt="Screen that needs a decision"
                className="w-full max-h-64 object-contain bg-ink-50"
              />
            ) : null}
            {!shot.loading && shot.err ? (
              <div className="px-3 py-2 text-xs text-ink-500">Screenshot could not be loaded.</div>
            ) : null}
          </div>
        ) : null}

        {!canAnswer ? (
          <p className="text-xs text-ink-500">You need owner or product_reviewer access to answer.</p>
        ) : (
          <fieldset className="space-y-2" disabled={answerMut.isPending}>
            <legend className="sr-only">Choose an option</legend>
            {options.map((opt) => {
              const id = String(opt.id ?? '');
              if (!id) return null;
              const label = String(opt.label ?? id);
              const isRecommended = recommended !== '' && recommended === id;
              return (
                <label
                  key={id}
                  className={`flex items-start gap-2 rounded-md border bg-white px-3 py-2 text-sm cursor-pointer ${
                    isRecommended
                      ? 'border-emerald-400 ring-1 ring-emerald-200'
                      : 'border-amber-200 hover:border-amber-400'
                  }`}
                >
                  <input
                    type="radio"
                    className="mt-0.5"
                    name={`decision-${decision.id}`}
                    value={id}
                    checked={selected === id}
                    onChange={() => setSelected(id)}
                  />
                  <span>
                    <span className="font-medium text-ink-800">{label}</span>
                    {isRecommended ? (
                      <span className="ml-2 text-xs font-medium text-emerald-700">Recommended</span>
                    ) : null}
                  </span>
                </label>
              );
            })}
            {options.length === 0 && (
              <p className="text-xs text-red-700">No options were provided for this decision.</p>
            )}

            <div>
              <label className="label" htmlFor={`decision-note-${decision.id}`}>
                {noteRequired ? 'Note (required for this option)' : 'Optional note'}
              </label>
              <textarea
                id={`decision-note-${decision.id}`}
                className="input min-h-[4rem]"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={
                  noteRequired
                    ? 'The exact company name to open, as it appears on screen'
                    : 'Extra context for the worker (optional)'
                }
              />
            </div>

            <label className="flex items-center gap-2 text-sm text-ink-700">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              Remember for future runs
            </label>

            {answerMut.isError && (
              <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                {errorMsg}
              </div>
            )}

            <div className="flex justify-end">
              <button
                type="button"
                className="btn-primary"
                disabled={
                  !selected
                  || answerMut.isPending
                  || options.length === 0
                  || (noteRequired && note.trim() === '')
                }
                onClick={() => {
                  const body: AnswerBody = {
                    selected_option: selected,
                    remember,
                  };
                  const trimmed = note.trim();
                  if (trimmed) body.free_text = trimmed;
                  answerMut.mutate(body);
                }}
              >
                {answerMut.isPending ? 'Submitting…' : 'Submit'}
              </button>
            </div>
          </fieldset>
        )}
      </div>
    </div>
  );
}
