/**
 * Scoring shared by session and final reports, so a run and its sessions are
 * always graded on the same scale. Mirrors
 * backend/app/Services/Reports/MaturityScore.php; change both together.
 *
 * UX score answers "how clean are the screens we saw"; maturity is that same
 * score minus what the product is still missing against its competitors.
 */

export type SeveritySummary = {
  critical: number;
  high: number;
  medium: number;
  low: number;
  suggestion: number;
};

/** The scorer only needs a gap's weight-bearing fields, not the whole finding. */
export type ScorableGap = {
  observed?: boolean;
  severity?: string;
  mode?: string;
};

const WEIGHTS: Record<string, number> = {
  critical: 5,
  high: 3,
  medium: 1.5,
  low: 0.5,
  suggestion: 0.1,
};

/** A "validate first" gap is an unconfirmed guess, so it cannot cost as much as a confirmed one. */
const VALIDATE_FIRST_FACTOR = 0.25;

/** Missing features alone must not sink an otherwise clean product to zero. */
const MAX_GAP_PENALTY = 40;

/**
 * Severity points a scope may accumulate before it scores zero. Scaling by
 * screens is what keeps a long run from scoring worse than a short one just for
 * having looked at more.
 */
function budget(screens: number): number {
  return Math.max(1, screens) * 5;
}

export function severityPenalty(severity: Partial<SeveritySummary>): number {
  let penalty = 0;
  for (const [name, count] of Object.entries(severity)) {
    penalty += (WEIGHTS[name.toLowerCase()] ?? 0) * (count ?? 0);
  }
  return penalty;
}

export function scoreUx(severity: Partial<SeveritySummary>, screens: number): number {
  return clamp(100 - (severityPenalty(severity) * 100) / budget(screens));
}

/**
 * Null when the scope observed nothing: scoring it 100 (no findings) or 0 (no
 * evidence) would both claim more than the run actually knows.
 */
export function scoreMaturity(
  severity: Partial<SeveritySummary>,
  gaps: ScorableGap[],
  screens: number,
): number | null {
  if (screens < 1) return null;
  const uxPenalty = (severityPenalty(severity) * 100) / budget(screens);
  const gapPenalty = Math.min(MAX_GAP_PENALTY, (weighGaps(gaps) * 100) / budget(screens));
  return clamp(100 - uxPenalty - gapPenalty);
}

/** Reports are read by people, so an unscored scope says so instead of showing a bare zero. */
export function maturityLabel(score: number | null): string {
  return score === null ? 'Not scored (no screens observed)' : `${score}/100`;
}

function weighGaps(gaps: ScorableGap[]): number {
  let weight = 0;
  for (const gap of gaps) {
    if (gap.observed) continue;
    const severity = WEIGHTS[String(gap.severity ?? '').toLowerCase()] ?? WEIGHTS.medium;
    weight += gap.mode === 'validate_first' ? severity * VALIDATE_FIRST_FACTOR : severity;
  }
  return weight;
}

function clamp(score: number): number {
  return Math.round(Math.max(0, Math.min(100, score)) * 100) / 100;
}
