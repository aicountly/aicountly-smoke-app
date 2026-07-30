import type { FindingFacetCounts, FindingMode, FindingsFilter } from '@/lib/reportFindings';

type FindingFilterChipsProps = {
  counts: FindingFacetCounts;
  filter: FindingsFilter;
  onToggleSeverity: (severity: string) => void;
  onToggleMode: (mode: FindingMode) => void;
  onClear: () => void;
  /** Fires after any chip click, so a page can jump to the Findings tab. */
  onChipActivated?: () => void;
  kind?: string | null;
};

const SEVERITY_CHIPS: Array<{ key: 'critical' | 'high' | 'medium' | 'low' | 'suggestion'; label: string; className: string }> = [
  { key: 'critical', label: 'Critical', className: 'badge-danger' },
  { key: 'high', label: 'High', className: 'badge-warning' },
  { key: 'medium', label: 'Medium', className: 'badge-info' },
  { key: 'low', label: 'Low', className: 'badge-neutral' },
  { key: 'suggestion', label: 'Suggestion', className: 'badge-neutral' },
];

const MODE_CHIPS: Array<{ key: 'validateFirst' | 'implement'; mode: FindingMode; label: string; className: string }> = [
  { key: 'validateFirst', mode: 'validate_first', label: 'Validate first', className: 'badge-neutral' },
  { key: 'implement', mode: 'implement', label: 'Implement', className: 'badge-brand' },
];

function chipClass(base: string, active: boolean): string {
  return base + ' cursor-pointer transition' + (active ? ' ring-2 ring-offset-1 ring-brand-600' : '');
}

/**
 * Replaces the static severity/mode badge row in both report pages with
 * clickable filter chips. Counts come from the rows actually rendered, so a
 * chip labelled 4 always opens exactly 4 rows.
 */
export function FindingFilterChips({
  counts,
  filter,
  onToggleSeverity,
  onToggleMode,
  onClear,
  onChipActivated,
  kind,
}: FindingFilterChipsProps) {
  const hasFilter = filter.severities.size > 0 || filter.modes.size > 0;

  function activate(action: () => void) {
    action();
    onChipActivated?.();
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px]">
      {kind ? <span className="badge-neutral">{kind}</span> : null}
      <button
        type="button"
        className={chipClass('badge-neutral', !hasFilter)}
        aria-pressed={!hasFilter}
        onClick={() => activate(onClear)}
      >
        All {counts.total}
      </button>
      {SEVERITY_CHIPS.filter((chip) => counts[chip.key] > 0).map((chip) => {
        const active = filter.severities.has(chip.key);
        return (
          <button
            key={chip.key}
            type="button"
            className={chipClass(chip.className, active)}
            aria-pressed={active}
            onClick={() => activate(() => onToggleSeverity(chip.key))}
          >
            {chip.label} {counts[chip.key]}
          </button>
        );
      })}
      {MODE_CHIPS.filter((chip) => counts[chip.key] > 0).map((chip) => {
        const active = filter.modes.has(chip.mode);
        return (
          <button
            key={chip.key}
            type="button"
            className={chipClass(chip.className, active)}
            aria-pressed={active}
            onClick={() => activate(() => onToggleMode(chip.mode))}
          >
            {chip.label} {counts[chip.key]}
          </button>
        );
      })}
    </div>
  );
}
