/**
 * Did the session actually observe the thing it was queued to observe?
 *
 * Every session captures a login form and a landing page before it does any work
 * of its own, so those two screens are not evidence of anything. A session that
 * finishes with nothing beyond them has tested none of its scope, and reporting
 * it as a success is worse than reporting nothing: it is a green tick over an
 * untested screen, which is the one thing a smoke run must never produce.
 */
export type CoverageStatus = 'covered' | 'blocked' | 'partial';

export type SessionCoverage = {
  status: CoverageStatus;
  reason: string;
};

export type CoverageInput = {
  /** Screens observed past login and landing — menu visits and direct navigation. */
  scopeScreens: number;
  /** The session's declared scope, when it named one. */
  menuPath: string | null;
  /** Company-scoped navigation was skipped because no workspace could be opened. */
  workspaceSkipped: boolean;
  /** Records this session created and confirmed appeared afterwards. 0 when not tracked yet. */
  creates_verified: number;
  /** The vision agent loop's terminal status: 'done' | 'blocked' | 'budget' | 'operator'. */
  loop_status: string;
};

export function evaluateSessionCoverage(input: CoverageInput): SessionCoverage {
  if (input.scopeScreens > 0) {
    // Saw in-scope screens but never reached a clean conclusion — it ran out of
    // budget instead of finishing or being honestly blocked, and never verified
    // a create either. Reporting this as a plain "covered" pass hides that the
    // session did not actually finish its job.
    if (input.workspaceSkipped === false && input.loop_status === 'budget' && input.creates_verified === 0) {
      return {
        status: 'partial',
        reason: `${input.scopeScreens} screen(s) observed in scope, but the session exhausted its step budget `
          + 'without a clean finish and without verifying any created record',
      };
    }
    return { status: 'covered', reason: `${input.scopeScreens} screen(s) observed in scope` };
  }

  const scope = (input.menuPath ?? '').trim();
  if (input.workspaceSkipped) {
    return {
      status: 'blocked',
      reason: scope
        ? `no company workspace was open, so "${scope}" was never reached`
        : 'no company workspace was open, so no company-scoped screen was reached',
    };
  }
  if (scope) {
    return { status: 'blocked', reason: `scope "${scope}" was never reached` };
  }
  return { status: 'blocked', reason: 'nothing beyond the login and landing pages was observed' };
}
