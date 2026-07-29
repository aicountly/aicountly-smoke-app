export type VisitBudgetInput = {
  expectedScreens: number;
  matchedCount: number;
  safetyMax: number;
};

export type VisitBudget = {
  visitLimit: number;
  estimated: number;
  truncated: boolean;
};

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function computeVisitBudget({
  expectedScreens,
  matchedCount,
  safetyMax,
}: VisitBudgetInput): VisitBudget {
  const estimated = nonNegativeInteger(expectedScreens);
  const matched = nonNegativeInteger(matchedCount);
  const maximum = nonNegativeInteger(safetyMax);

  return {
    visitLimit: Math.min(matched, maximum),
    estimated,
    truncated: matched > maximum,
  };
}
