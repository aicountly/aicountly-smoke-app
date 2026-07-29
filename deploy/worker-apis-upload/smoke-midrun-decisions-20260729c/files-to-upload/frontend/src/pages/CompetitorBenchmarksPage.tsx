import { Fragment, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { asBool } from '@/lib/bool';
import { useAuthStore } from '@/store/auth';
import { SAAS_PRODUCTS, SAAS_PRODUCT_SLUGS, saasProductLabel, type SaasProductOption } from '@/lib/products';

type Competitor = {
  id: number;
  product_name: string;
  competitor_name: string;
  feature_list_json: string | string[];
  source_url: string | null;
  enabled: boolean | number | string;
  notes?: string | null;
};

type EditForm = {
  id?: number;
  product_name: string;
  competitor_name: string;
  source_url: string;
  features: string[];
  enabled: boolean;
  notes: string;
};

const EMPTY_FORM: EditForm = {
  product_name: '',
  competitor_name: '',
  source_url: '',
  features: [],
  enabled: true,
  notes: '',
};

function parseFeatures(raw: string | string[] | null | undefined): string[] {
  if (Array.isArray(raw)) return raw.map((f) => String(f).trim()).filter(Boolean);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((f) => String(f).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function isEnabled(value: Competitor['enabled']): boolean {
  return asBool(value);
}

function toForm(c: Competitor): EditForm {
  return {
    id: c.id,
    product_name: c.product_name,
    competitor_name: c.competitor_name,
    source_url: c.source_url ?? '',
    features: parseFeatures(c.feature_list_json),
    enabled: isEnabled(c.enabled),
    notes: c.notes ?? '',
  };
}

export function CompetitorBenchmarksPage() {
  const qc = useQueryClient();
  const canEdit = useAuthStore((s) => s.hasRole('owner', 'product_reviewer'));
  const canDelete = useAuthStore((s) => s.hasRole('owner'));

  const [filter, setFilter] = useState('');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [edit, setEdit] = useState<EditForm>(EMPTY_FORM);

  const { data, isLoading, isError } = useQuery<{ data: Competitor[] }>({
    queryKey: ['competitors', filter],
    queryFn: async () => (await api.get('/competitors', { params: filter ? { product_name: filter } : {} })).data,
  });

  const rows = data?.data ?? [];

  const save = useMutation({
    mutationFn: async (form: EditForm) => {
      const body = {
        product_name: form.product_name.trim(),
        competitor_name: form.competitor_name.trim(),
        source_url: form.source_url.trim(),
        enabled: form.enabled,
        notes: form.notes.trim(),
        features: form.features.map((f) => f.trim()).filter(Boolean),
      };
      if (form.id) return (await api.put(`/competitors/${form.id}`, body)).data;
      return (await api.post('/competitors', body)).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['competitors'] });
      setDrawerOpen(false);
      setEdit(EMPTY_FORM);
    },
  });

  const remove = useMutation({
    mutationFn: async (id: number) => (await api.delete(`/competitors/${id}`)).data,
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ['competitors'] });
      if (expandedId === id) setExpandedId(null);
      if (edit.id === id) {
        setDrawerOpen(false);
        setEdit(EMPTY_FORM);
      }
    },
  });

  function openCreate() {
    setEdit(EMPTY_FORM);
    setDrawerOpen(true);
  }

  function openEdit(c: Competitor) {
    setEdit(toForm(c));
    setDrawerOpen(true);
  }

  function toggleExpanded(id: number) {
    setExpandedId((prev) => (prev === id ? null : id));
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold">Competitor Benchmarks</h1>
          <p className="text-sm text-ink-500">
            Configurable per-product feature lists used by the Feature Gap engine.
          </p>
        </div>
        <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
          <div>
            <label className="label">Filter by product</label>
            <input
              className="input sm:w-56"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="books, hrms, ..."
              list="competitor-product-filter"
            />
            <datalist id="competitor-product-filter">
              {SAAS_PRODUCTS.map((p) => (
                <option key={p.slug} value={p.slug} />
              ))}
            </datalist>
          </div>
          {canEdit && (
            <button className="btn-primary whitespace-nowrap" onClick={openCreate}>
              + Add competitor
            </button>
          )}
        </div>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-ink-600 text-left">
            <tr>
              <th className="px-4 py-2">Product</th>
              <th>Competitor</th>
              <th>Features</th>
              <th>Source</th>
              <th>Enabled</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-ink-500">
                  Loading competitor benchmarks...
                </td>
              </tr>
            )}
            {isError && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-red-700">
                  Failed to load competitor benchmarks.
                </td>
              </tr>
            )}
            {!isLoading && !isError && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-ink-500">
                  {filter
                    ? `No competitors for “${filter}”. Clear the filter or add one.`
                    : 'No competitor benchmarks yet. Add a competitor to seed the Feature Gap engine.'}
                </td>
              </tr>
            )}
            {!isLoading &&
              !isError &&
              rows.map((c) => {
                const list = parseFeatures(c.feature_list_json);
                const open = expandedId === c.id;
                const enabled = isEnabled(c.enabled);
                return (
                  <Fragment key={c.id}>
                    <tr className={'border-t border-ink-200 ' + (open ? 'bg-ink-50/60' : '')}>
                      <td className="px-4 py-2">
                        <span className="font-medium">{saasProductLabel(c.product_name)}</span>
                        <div className="text-xs text-ink-500 font-mono">{c.product_name}</div>
                      </td>
                      <td className="font-medium">{c.competitor_name}</td>
                      <td>
                        <button
                          type="button"
                          className={
                            'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition ' +
                            (open
                              ? 'border-brand-300 bg-brand-50 text-brand-800'
                              : 'border-ink-200 bg-white text-ink-700 hover:bg-ink-50')
                          }
                          onClick={() => toggleExpanded(c.id)}
                          aria-expanded={open}
                          title={open ? 'Hide features' : 'View features'}
                        >
                          <span className="tabular-nums">{list.length}</span>
                          <span>{list.length === 1 ? 'feature' : 'features'}</span>
                          <span className="text-ink-400" aria-hidden>
                            {open ? '▾' : '▸'}
                          </span>
                        </button>
                      </td>
                      <td className="pr-2">
                        {c.source_url ? (
                          <a
                            href={c.source_url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs text-brand-700 hover:underline break-all"
                          >
                            Link
                          </a>
                        ) : (
                          <span className="text-xs text-ink-400">—</span>
                        )}
                      </td>
                      <td>
                        <span className={enabled ? 'badge-brand' : 'badge-neutral'}>
                          {enabled ? 'Enabled' : 'Disabled'}
                        </span>
                      </td>
                      <td className="text-right pr-4">
                        <div className="flex justify-end gap-2">
                          {canEdit && (
                            <button className="btn-secondary" onClick={() => openEdit(c)}>
                              Edit
                            </button>
                          )}
                          {canDelete && (
                            <button
                              className="btn-danger"
                              disabled={remove.isPending}
                              onClick={() => {
                                if (
                                  confirm(
                                    `Delete competitor “${c.competitor_name}” for ${c.product_name}?\n\nThis removes its benchmark feature list from the Feature Gap engine.`,
                                  )
                                ) {
                                  remove.mutate(c.id);
                                }
                              }}
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {open && (
                      <tr className="border-t border-ink-100 bg-ink-50/40">
                        <td colSpan={6} className="px-4 py-3">
                          <FeatureListPanel
                            competitorName={c.competitor_name}
                            features={list}
                            onEdit={canEdit ? () => openEdit(c) : undefined}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
          </tbody>
        </table>
      </div>

      {drawerOpen && (
        <div className="fixed inset-0 bg-ink-900/30 z-40 flex justify-end">
          <div className="w-full max-w-lg bg-white shadow-2xl border-l border-ink-200 p-6 overflow-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">{edit.id ? 'Edit competitor' : 'Add competitor'}</h2>
              <button
                className="btn-secondary"
                onClick={() => {
                  setDrawerOpen(false);
                  setEdit(EMPTY_FORM);
                }}
              >
                Close
              </button>
            </div>
            <CompetitorForm
              value={edit}
              onChange={setEdit}
              onSubmit={() => save.mutate(edit)}
              loading={save.isPending}
              error={save.isError ? 'Save failed. Check required fields and try again.' : null}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function FeatureListPanel({
  competitorName,
  features,
  onEdit,
}: {
  competitorName: string;
  features: string[];
  onEdit?: () => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs font-medium text-ink-600">
          Features for <span className="text-ink-900">{competitorName}</span>
          <span className="text-ink-400 font-normal"> · {features.length}</span>
        </div>
        {onEdit && (
          <button type="button" className="btn-secondary text-xs py-1" onClick={onEdit}>
            Edit list
          </button>
        )}
      </div>
      {features.length === 0 ? (
        <p className="text-sm text-ink-500">No features stored for this competitor.</p>
      ) : (
        <ul className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
          {features.map((f, i) => (
            <li
              key={`${i}-${f}`}
              className="flex items-start gap-2 rounded-md border border-ink-200 bg-white px-2.5 py-2 text-sm"
            >
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />
              <span className="leading-snug">{f}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CompetitorForm({
  value,
  onChange,
  onSubmit,
  loading,
  error,
}: {
  value: EditForm;
  onChange: (v: EditForm) => void;
  onSubmit: () => void;
  loading: boolean;
  error: string | null;
}) {
  const [draftFeature, setDraftFeature] = useState('');
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState('');

  const productOptions: SaasProductOption[] = useMemo(() => {
    const options: SaasProductOption[] = [...SAAS_PRODUCTS];
    if (value.product_name && !SAAS_PRODUCT_SLUGS.includes(value.product_name as (typeof SAAS_PRODUCT_SLUGS)[number])) {
      options.unshift({ slug: value.product_name, label: `${value.product_name} (legacy)` });
    }
    return options;
  }, [value.product_name]);

  function addFeature(raw: string) {
    const next = raw.trim();
    if (!next) return;
    if (value.features.some((f) => f.toLowerCase() === next.toLowerCase())) return;
    onChange({ ...value, features: [...value.features, next] });
  }

  function removeFeature(index: number) {
    onChange({ ...value, features: value.features.filter((_, i) => i !== index) });
  }

  function applyBulk() {
    const incoming = bulkText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (incoming.length === 0) return;
    const seen = new Set(value.features.map((f) => f.toLowerCase()));
    const merged = [...value.features];
    for (const f of incoming) {
      const key = f.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(f);
    }
    onChange({ ...value, features: merged });
    setBulkText('');
    setBulkOpen(false);
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="space-y-3"
    >
      <div>
        <label className="label">Product</label>
        <select
          className="input"
          required
          value={value.product_name}
          onChange={(e) => onChange({ ...value, product_name: e.target.value })}
        >
          <option value="">Select...</option>
          {productOptions.map((p) => (
            <option key={p.slug} value={p.slug}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="label">Competitor name</label>
        <input
          className="input"
          required
          placeholder="e.g. QuickBooks Online"
          value={value.competitor_name}
          onChange={(e) => onChange({ ...value, competitor_name: e.target.value })}
        />
      </div>

      <div>
        <label className="label">Source URL</label>
        <input
          className="input"
          type="url"
          placeholder="https://... (optional)"
          value={value.source_url}
          onChange={(e) => onChange({ ...value, source_url: e.target.value })}
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <label className="label mb-0">Features</label>
          <span className="text-xs text-ink-500 tabular-nums">{value.features.length} listed</span>
        </div>

        {value.features.length > 0 ? (
          <ul className="max-h-56 overflow-auto space-y-1.5 rounded-md border border-ink-200 bg-ink-50/50 p-2">
            {value.features.map((f, i) => (
              <li
                key={`${i}-${f}`}
                className="flex items-center gap-2 rounded-md border border-ink-200 bg-white px-2 py-1.5 text-sm"
              >
                <span className="flex-1 leading-snug">{f}</span>
                <button
                  type="button"
                  className="text-xs text-ink-500 hover:text-red-700"
                  onClick={() => removeFeature(i)}
                  aria-label={`Remove ${f}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="rounded-md border border-dashed border-ink-300 bg-ink-50/40 px-3 py-4 text-center text-sm text-ink-500">
            No features yet. Add them one at a time or paste a list.
          </div>
        )}

        <div className="flex gap-2">
          <input
            className="input"
            placeholder="Add a feature..."
            value={draftFeature}
            onChange={(e) => setDraftFeature(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addFeature(draftFeature);
                setDraftFeature('');
              }
            }}
          />
          <button
            type="button"
            className="btn-secondary whitespace-nowrap"
            onClick={() => {
              addFeature(draftFeature);
              setDraftFeature('');
            }}
          >
            Add
          </button>
        </div>

        <div>
          <button
            type="button"
            className="text-xs text-brand-700 hover:underline"
            onClick={() => {
              setBulkOpen((v) => !v);
              if (!bulkOpen) setBulkText(value.features.join('\n'));
            }}
          >
            {bulkOpen ? 'Hide bulk editor' : 'Paste / edit as list'}
          </button>
          {bulkOpen && (
            <div className="mt-2 space-y-2">
              <textarea
                className="input min-h-[140px] font-mono text-xs"
                placeholder="One feature per line..."
                value={bulkText}
                onChange={(e) => setBulkText(e.target.value)}
              />
              <div className="flex gap-2">
                <button type="button" className="btn-secondary" onClick={applyBulk}>
                  Apply lines
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    onChange({
                      ...value,
                      features: bulkText
                        .split('\n')
                        .map((s) => s.trim())
                        .filter(Boolean),
                    });
                    setBulkOpen(false);
                  }}
                >
                  Replace all
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(e) => onChange({ ...value, enabled: e.target.checked })}
        />
        Enabled for Feature Gap engine
      </label>

      {error && <p className="text-sm text-red-700">{error}</p>}

      <button className="btn-primary w-full" type="submit" disabled={loading || !value.product_name || !value.competitor_name}>
        {loading ? 'Saving...' : value.id ? 'Update competitor' : 'Save competitor'}
      </button>
    </form>
  );
}
