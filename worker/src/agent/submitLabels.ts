/**
 * One vocabulary for "did this click commit a form", shared by the created-record
 * ledger, the premature-blocked refutation and the finding detectors, so those
 * three can never disagree about what a submit looks like.
 */

import { isConstructiveLabel } from '../utils/safeActionGuard.js';

/**
 * Commit verbs the safety guard's constructive vocabulary leaves out on purpose,
 * so that an observer session may still open a create form. Bare "add" stays out
 * here too, because "Add Employee" opens the form rather than saving it.
 */
const COMMITS_FORM = /\b(create|update|register|generate|insert|post)\b/i;

/**
 * Create vocabulary in the service of opening a form: "Create New Company",
 * "+ Add New Branch", "New Employee". These write nothing, so reading one as a
 * commit is expensive in both directions — it tells the model it has already
 * created the record and it must stop, and it credits the run with a create that
 * never happened. "Create employee master" on a filled form is a commit and must
 * stay one, which is why only the "new" phrasing is excluded rather than the
 * whole create/add vocabulary.
 */
const OPENS_FORM = /^\s*\+?\s*new\b|\b(?:create|add|open)\s+(?:a\s+|an\s+|another\s+)?new\b/i;

export function looksLikeFormOpener(label: string | null | undefined): boolean {
  return Boolean(label) && OPENS_FORM.test(String(label));
}

export function looksLikeSubmitLabel(label: string | null | undefined): boolean {
  if (!label) return false;
  if (looksLikeFormOpener(label)) return false;
  return isConstructiveLabel(label).matched || COMMITS_FORM.test(label);
}
