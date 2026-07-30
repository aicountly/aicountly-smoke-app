import { useState } from 'react';
import { CopyButton } from '@/components/CopyButton';
import {
  filterFindings,
  passedCheckRows,
  type FindingRow,
  type FindingsFilter,
} from '@/lib/reportFindings';
import type { FindingsViewMode } from '@/lib/useFindingsView';

type ReportFindingsProps = {
  rows: FindingRow[];
  loading?: boolean;
  filter: FindingsFilter;
  view: FindingsViewMode;
  onViewChange: (view: FindingsViewMode) => void;
  onClearFilter: () => void;
  /** Sum of `severity_summary`, to flag when the final report's capped arrays under-report it. */
  severitySummaryTotal?: number;
};

const SEVERITY_BADGE: Record<string, string> = {
  critical: 'badge-danger',
  high: 'badge-warning',
  medium: 'badge-info',
  low: 'badge-neutral',
  suggestion: 'badge-neutral',
};

function severityBadgeClass(severity: string): string {
  return SEVERITY_BADGE[severity] ?? 'badge-neutral';
}

/**
 * Renders report findings as a native list -- the HTML report tab is a
 * sandboxed, scriptless document, so filtering and collapsing has to happen
 * here instead. `Collapsed` fits ~50 findings in a couple of screens;
 * `Detailed` expands every row for a full read-through.
 */
export function ReportFindings({
  rows,
  loading,
  filter,
  view,
  onViewChange,
  onClearFilter,
  severitySummaryTotal,
}: ReportFindingsProps) {
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());

  if (loading) {
    return <p className="text-sm text-ink-500 p-4">Loading findings…</p>;
  }

  if (rows.length === 0) {
    return (
      <div className="p-6 text-center text-sm text-ink-500 space-y-1">
        <p>This report has no findings.</p>
        <p>Nothing was flagged during this session, or the report predates this view.</p>
      </div>
    );
  }

  function toggleExpanded(key: string) {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const visible = filterFindings(rows, filter);
  const active = rows.filter((row) => !row.passedCheck);
  const passed = passedCheckRows(rows);
  const hasFilter = filter.severities.size > 0 || filter.modes.size > 0;
  const truncated = typeof severitySummaryTotal === 'number' && severitySummaryTotal > active.length;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-b border-ink-100 shrink-0">
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-500">
          <span>
            Showing {visible.length} of {active.length} finding{active.length === 1 ? '' : 's'}
          </span>
          {hasFilter && (
            <button type="button" className="btn-secondary text-xs py-0.5 px-2" onClick={onClearFilter}>
              Clear filters
            </button>
          )}
        </div>
        <div className="segmented">
          <button
            type="button"
            className={'segmented-option' + (view === 'collapsed' ? ' segmented-option-active' : '')}
            aria-pressed={view === 'collapsed'}
            onClick={() => onViewChange('collapsed')}
          >
            Collapsed
          </button>
          <button
            type="button"
            className={'segmented-option' + (view === 'detailed' ? ' segmented-option-active' : '')}
            aria-pressed={view === 'detailed'}
            onClick={() => onViewChange('detailed')}
          >
            Detailed
          </button>
        </div>
      </div>

      {truncated && (
        <p className="px-3 py-1.5 text-[11px] text-amber-800 bg-amber-50 border-b border-amber-100">
          This report's severity counts include more findings than the {active.length} shown here -- the
          underlying lists are capped in the final report.
        </p>
      )}

      <div className="flex-1 min-h-0 overflow-auto">
        {visible.length === 0 ? (
          <p className="p-6 text-center text-sm text-ink-500">
            {hasFilter ? (
              <>
                No findings match the active filter.{' '}
                <button type="button" className="text-brand-700 underline" onClick={onClearFilter}>
                  Clear filters
                </button>{' '}
                to see everything.
              </>
            ) : (
              'Every finding in this report is a passed check -- see below.'
            )}
          </p>
        ) : (
          <ul className="divide-y divide-ink-100">
            {visible.map((row) => (
              <FindingListItem
                key={row.key}
                row={row}
                expanded={view === 'detailed' || expandedKeys.has(row.key)}
                onToggle={() => toggleExpanded(row.key)}
              />
            ))}
          </ul>
        )}

        {passed.length > 0 && (
          <div className="border-t border-ink-100">
            <div className="px-3 py-2 text-xs font-medium text-ink-500 bg-ink-50">
              Checks that passed ({passed.length})
            </div>
            <ul className="divide-y divide-ink-100">
              {passed.map((row) => (
                <FindingListItem
                  key={row.key}
                  row={row}
                  expanded={view === 'detailed' || expandedKeys.has(row.key)}
                  onToggle={() => toggleExpanded(row.key)}
                />
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function FindingListItem({
  row,
  expanded,
  onToggle,
}: {
  row: FindingRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="px-3 py-2">
      <button type="button" className="w-full flex items-center gap-2 text-left" aria-expanded={expanded} onClick={onToggle}>
        {row.severity && <span className={severityBadgeClass(row.severity) + ' shrink-0'}>{row.severity}</span>}
        <span className="text-sm font-medium truncate flex-1">{row.title}</span>
        {row.meta && <span className="text-xs text-ink-500 shrink-0 max-w-[40%] truncate">{row.meta}</span>}
      </button>
      {expanded && <FindingDetail row={row} />}
    </li>
  );
}

function FindingDetail({ row }: { row: FindingRow }) {
  const hasEvidence = Boolean(row.imageDataUri || row.screen || row.selector || row.expectation);
  return (
    <div className="mt-2 pl-1 space-y-2">
      {row.summary && <p className="text-sm text-ink-800 whitespace-pre-wrap">{row.summary}</p>}
      {row.technical && (
        <details>
          <summary className="cursor-pointer text-xs text-ink-500 hover:text-ink-800 select-none">
            Technical recommendation
          </summary>
          <p className="mt-1 text-xs text-ink-700 whitespace-pre-wrap">{row.technical}</p>
        </details>
      )}
      {hasEvidence && (
        <div className="flex flex-wrap gap-3 rounded border border-brand-100 bg-brand-50/40 p-2">
          {row.imageDataUri && (
            <img src={row.imageDataUri} alt={row.title} className="max-w-[220px] rounded border border-ink-200" />
          )}
          <div className="text-xs text-ink-700 space-y-0.5 min-w-0">
            {row.screen && (
              <div>
                <span className="font-medium">Screen:</span> {row.screen}
              </div>
            )}
            {row.selector && (
              <div>
                <span className="font-medium">Selector:</span> <code>{row.selector}</code>
              </div>
            )}
            {row.expectation && (
              <div>
                <span className="font-medium">Expected:</span> {row.expectation}
              </div>
            )}
          </div>
        </div>
      )}
      {row.prompt && (
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-medium text-ink-500">Developer prompt</span>
            <CopyButton text={row.prompt} label="Copy for Cursor" title="Copy this prompt for Cursor" />
          </div>
          <pre className="max-h-56 overflow-auto rounded bg-ink-50 border border-ink-100 p-2 text-xs font-mono text-ink-800 whitespace-pre-wrap break-words">
            {row.prompt}
          </pre>
        </div>
      )}
    </div>
  );
}
