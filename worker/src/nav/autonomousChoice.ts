/**
 * Which option the run may take for itself when no operator is answering.
 *
 * The rule that matters: never choose an action this target is going to refuse.
 * Picking one anyway does not fail early or politely — it fails deep inside the
 * action, after the session has already spent a browser launch and a login, and
 * the job is then re-queued to do it all again.
 */

import { allowsFullAccess } from '../utils/environments.js';
import type { DecisionOption, NavAction } from './askDecision.js';

/**
 * Order to fall back through when the recommended option is not permitted here.
 * Ranked by how likely each is to get the run moving: clear the thing in the
 * way, go around it, and only then give up on this target.
 */
export const AUTONOMOUS_FALLBACK_ORDER: NavAction[] = [
  'dismiss_overlay',
  'navigate_href',
  'open_company',
  'skip_target',
  'rescan_menus',
];

/**
 * Actions that give up on the target rather than get past it. Choosing one is a
 * legitimate answer, but it observes nothing, so it must never be chosen quietly
 * while an operator could have unblocked the screen instead.
 */
const GIVES_UP: NavAction[] = ['skip_target', 'rescan_menus'];

/**
 * True when an operator has options here that the run does not — a create the
 * tier reserves for a human, say. The run can still carry on alone, but it would
 * be carrying on past a screen somebody could have opened for it, so the honest
 * move is to ask and only fall back if nobody answers.
 */
export function humanCouldDoMore(environment: string, options: DecisionOption[]): boolean {
  const ours = options.filter((option) => optionIsAutonomouslyAllowed(environment, option));
  if (ours.length === 0) return true;
  if (ours.some((option) => !GIVES_UP.includes(option.action))) return false;
  return options.some((option) => option.action !== 'abort_session'
    && !optionIsAutonomouslyAllowed(environment, option));
}

/**
 * An option the run cannot supply the input for is not an option the run has. Offering
 * "open the company named in the note" and then taking it alone means opening nothing.
 */
export function optionIsAutonomouslyAllowed(environment: string, option: DecisionOption): boolean {
  if (option.requires_note) return false;
  return isAutonomouslyAllowed(environment, option.action);
}

export function isAutonomouslyAllowed(environment: string, action: NavAction): boolean {
  // Ending a session is a judgement call that stays with a human.
  if (action === 'abort_session') return false;
  // Mirrors assertMayCreateCompany: a human may approve a company anywhere, the
  // run may only decide it where mutations are already permitted.
  if (action === 'create_company') return allowsFullAccess(environment);
  return true;
}

export function autonomousOption(
  environment: string,
  options: DecisionOption[],
  recommended?: string,
): DecisionOption | null {
  const usable = options.filter((option) => optionIsAutonomouslyAllowed(environment, option));
  if (usable.length === 0) return null;

  const preferred = usable.find((option) => option.id === recommended);
  if (preferred) return preferred;

  for (const action of AUTONOMOUS_FALLBACK_ORDER) {
    const match = usable.find((option) => option.action === action);
    if (match) return match;
  }
  return usable[0];
}
