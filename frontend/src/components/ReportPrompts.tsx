import { CopyButton } from '@/components/CopyButton';
import { extractPromptPack, promptRows, type PromptRow, type ReportJson } from '@/lib/reports';
import type { FindingsFilter } from '@/lib/reportFindings';

type ReportPromptsProps = {
  report: ReportJson | null;
  loading?: boolean;
  /** Active severity/mode filter from the findings view, so this tab shows the matching prompts only. */
  filter?: FindingsFilter;
};

function matchesFilter(row: PromptRow, filter: FindingsFilter | undefined): boolean {
  if (!filter) return true;
  const severityOk = filter.severities.size === 0 || filter.severities.has(row.severity);
  const modeOk = filter.modes.size === 0 || (row.mode != null && filter.modes.has(row.mode));
  return severityOk && modeOk;
}

/**
 * The report's Cursor prompts, one copy button each. The HTML preview shows the
 * same prompts, but it is a sandboxed document with no scripting, so nothing in
 * there can copy anything.
 */
export function ReportPrompts({ report, loading, filter }: ReportPromptsProps) {
  const allRows = promptRows(report);
  const hasFilter = Boolean(filter && (filter.severities.size > 0 || filter.modes.size > 0));
  const rows = hasFilter ? allRows.filter((row) => matchesFilter(row, filter)) : allRows;
  const pack = hasFilter ? rows.map((row) => row.prompt).join('\n\n---\n\n') : extractPromptPack(report);

  if (loading) {
    return <p className="text-sm text-ink-500 p-4">Loading prompts…</p>;
  }
  if (allRows.length === 0 && extractPromptPack(report) === '') {
    return (
      <p className="text-sm text-ink-500 p-4">
        This report has no Cursor prompts. They are generated for UX issues and feature gaps, so a
        report that found neither has none.
      </p>
    );
  }
  if (hasFilter && rows.length === 0) {
    return <p className="text-sm text-ink-500 p-4">No prompts match the active filter.</p>;
  }

  return (
    <div className="p-4 space-y-4">
      {pack !== '' && (
        <div className="flex flex-wrap items-center gap-2 pb-3 border-b border-ink-100">
          <span className="text-xs text-ink-500">
            {rows.length > 0
              ? `${rows.length} prompt(s)${hasFilter ? ' matching the active filter' : ' in this report'}`
              : 'Full prompt pack'}
          </span>
          <CopyButton
            text={pack}
            label="Copy all for Cursor"
            copiedLabel="Copied all"
            className="btn-secondary text-xs py-1 px-2"
            title={hasFilter ? 'Copy every prompt matching the active filter' : 'Copy every prompt in this report as one pack'}
          />
        </div>
      )}

      <ul className="space-y-3">
        {rows.map((row) => (
          <li key={row.key} className="border border-ink-100 rounded p-3">
            <div className="flex items-start justify-between gap-2 flex-wrap">
              <div className="min-w-0">
                <div className="text-sm font-medium break-words">{row.title}</div>
                <div className="text-xs text-ink-500">
                  {row.group}
                  {row.meta ? ` · ${row.meta}` : ''}
                </div>
              </div>
              <CopyButton text={row.prompt} label="Copy for Cursor" title="Copy this prompt for Cursor" />
            </div>
            <pre className="mt-2 max-h-56 overflow-auto rounded bg-ink-50 border border-ink-100 p-2 text-xs font-mono text-ink-800 whitespace-pre-wrap break-words">
              {row.prompt}
            </pre>
          </li>
        ))}
      </ul>
    </div>
  );
}
