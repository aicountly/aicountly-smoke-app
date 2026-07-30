import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { FindingMode, FindingsFilter } from '@/lib/reportFindings';

export type FindingsViewMode = 'collapsed' | 'detailed';

export type UseFindingsViewOptions = {
  /**
   * Full report page: filter state lives in the URL (`?sev=critical,high`)
   * so a filtered view is linkable. The Reports list pane passes `false` and
   * keeps the filter local, since its URL already carries `?id=`.
   */
  syncUrl?: boolean;
};

export type UseFindingsViewResult = {
  filter: FindingsFilter;
  view: FindingsViewMode;
  hasActiveFilter: boolean;
  setView: (mode: FindingsViewMode) => void;
  toggleSeverity: (severity: string) => void;
  toggleMode: (mode: FindingMode) => void;
  clearFilter: () => void;
};

const VIEW_STORAGE_KEY = 'smoke.report.view';
const SEVERITY_PARAM = 'sev';
const VIEW_PARAM = 'view';

function isFindingsViewMode(value: string | null | undefined): value is FindingsViewMode {
  return value === 'collapsed' || value === 'detailed';
}

function readStoredView(): FindingsViewMode {
  if (typeof window === 'undefined') return 'collapsed';
  try {
    const stored = window.localStorage.getItem(VIEW_STORAGE_KEY);
    return isFindingsViewMode(stored) ? stored : 'collapsed';
  } catch {
    return 'collapsed';
  }
}

function writeStoredView(mode: FindingsViewMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, mode);
  } catch {
    // Storage may be unavailable (private mode, quota) -- the in-memory state still works.
  }
}

function parseSeverities(value: string | null): Set<string> {
  if (!value) return new Set();
  return new Set(value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

/**
 * One hook so the page header chips and the findings list body cannot
 * disagree about which filter or view mode is active. `view` always falls
 * back to the reviewer's remembered preference in `localStorage`; `filter`
 * is either URL-backed (full report page) or held in local state (Reports
 * list preview pane).
 */
export function useFindingsView(options: UseFindingsViewOptions = {}): UseFindingsViewResult {
  const { syncUrl = true } = options;
  const [searchParams, setSearchParams] = useSearchParams();

  const [localSeverities, setLocalSeverities] = useState<Set<string>>(() => new Set());
  const [modes, setModes] = useState<Set<FindingMode>>(() => new Set());
  const [view, setViewState] = useState<FindingsViewMode>(() => {
    const fromUrl = syncUrl ? searchParams.get(VIEW_PARAM) : null;
    return isFindingsViewMode(fromUrl) ? fromUrl : readStoredView();
  });

  const severities = syncUrl ? parseSeverities(searchParams.get(SEVERITY_PARAM)) : localSeverities;

  const setSeverities = useCallback(
    (next: Set<string>) => {
      if (syncUrl) {
        setSearchParams(
          (prev) => {
            const params = new URLSearchParams(prev);
            if (next.size === 0) params.delete(SEVERITY_PARAM);
            else params.set(SEVERITY_PARAM, [...next].join(','));
            return params;
          },
          { replace: true },
        );
      } else {
        setLocalSeverities(next);
      }
    },
    [syncUrl, setSearchParams],
  );

  const setView = useCallback(
    (mode: FindingsViewMode) => {
      setViewState(mode);
      writeStoredView(mode);
      if (syncUrl) {
        setSearchParams(
          (prev) => {
            const params = new URLSearchParams(prev);
            params.set(VIEW_PARAM, mode);
            return params;
          },
          { replace: true },
        );
      }
    },
    [syncUrl, setSearchParams],
  );

  const toggleSeverity = useCallback(
    (severity: string) => {
      const next = new Set(severities);
      if (next.has(severity)) next.delete(severity);
      else next.add(severity);
      setSeverities(next);
    },
    [severities, setSeverities],
  );

  const toggleMode = useCallback((mode: FindingMode) => {
    setModes((prev) => {
      const next = new Set(prev);
      if (next.has(mode)) next.delete(mode);
      else next.add(mode);
      return next;
    });
  }, []);

  const clearFilter = useCallback(() => {
    setSeverities(new Set());
    setModes(new Set());
  }, [setSeverities]);

  const filter = useMemo<FindingsFilter>(() => ({ severities, modes }), [severities, modes]);
  const hasActiveFilter = severities.size > 0 || modes.size > 0;

  return { filter, view, hasActiveFilter, setView, toggleSeverity, toggleMode, clearFilter };
}
