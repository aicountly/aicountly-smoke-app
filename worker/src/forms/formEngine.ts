/**
 * Gets the run past any form it did not expect.
 *
 * A smoke run opens screens nobody wrote a rule for, so sooner or later a modal
 * or a required-field page stands between it and the next screen. Blocking on a
 * human there costs the whole run; so does abandoning the screen. This engine
 * fills what it can, submits only where the safety guard already permits a
 * destructive click, and otherwise dismisses the form and moves on.
 *
 * The one hard promise: it never throws. Every caller treats a form as an
 * obstacle to report, not a reason to fail a session.
 */

import type { Locator, Page } from 'playwright';
import { appendLog, type Job } from '../backend.js';
import { evaluateClick } from '../utils/safeActionGuard.js';
import { dismissOverlays } from '../utils/dismissOverlays.js';
import { captureScreenshot } from '../scanner/screenshotCapture.js';
import type { FormFieldDescriptor } from './fieldSynthesis.js';
import {
  collectFormErrors,
  describeField,
  DIALOG_SELECTOR,
  fillTextField,
  firstRealOption,
  formScope,
  isWritableType,
  looksLikeSearchField,
  type FormScope,
} from './formDom.js';
import {
  applyLastResort,
  describePlan,
  fieldsNeedingBrain,
  mergeBrainValues,
  planFromHeuristics,
  type PlannedField,
} from './formFillPlan.js';
import { proposeFormValues } from './formFillBrain.js';

export type FormAttemptStatus =
  /** No editable form was on screen. */
  | 'absent'
  /** Filled and accepted. */
  | 'submitted'
  /** Filled, but submitting is not permitted here, so the form was left as-is. */
  | 'filled'
  /** Closed without submitting so the run could continue. */
  | 'dismissed'
  /** Filled and submitted, but the form rejected it. */
  | 'rejected'
  /** Something went wrong while handling the form. */
  | 'failed';

export type FormAttempt = {
  status: FormAttemptStatus;
  detail: string;
  filled: string[];
  formErrors: string[];
  brainAssisted: boolean;
  /** True when the run may carry on from here without the form in the way. */
  cleared: boolean;
};

export type ResolveFormOptions = {
  /** Where the run met this form, for logs. */
  label: string;
  screenshotsDir?: string;
  /** Name to use for the record the form creates. */
  entityName?: string;
};

const SUBMIT_LABEL = /^(save|create|submit|continue|next|done|ok|okay|apply|confirm|update|proceed|finish|add)\b/i;
const MAX_FIELDS = 80;

/**
 * Is a modal with editable fields standing in the way? Scoped to dialogs on
 * purpose: a list screen's own filter boxes are not an obstacle.
 */
export async function hasBlockingForm(page: Page): Promise<boolean> {
  const dialog = page.locator(DIALOG_SELECTOR).filter({ visible: true }).first();
  if (!await dialog.count().catch(() => 0)) return false;
  return (await collectFields(page, dialog)).length > 0;
}

export async function resolveBlockingForm(
  page: Page,
  job: Job,
  options: ResolveFormOptions,
): Promise<FormAttempt> {
  try {
    return await attempt(page, job, options);
  } catch (error) {
    const detail = `Form handling failed on "${options.label}": ${errorMessage(error)}`;
    await log(job, detail, 'warn');
    return {
      status: 'failed', detail, filled: [], formErrors: [], brainAssisted: false, cleared: false,
    };
  }
}

async function attempt(page: Page, job: Job, options: ResolveFormOptions): Promise<FormAttempt> {
  const scope = await formScope(page);
  const fields = await collectFields(page, scope);
  if (fields.length === 0) {
    return {
      status: 'absent',
      detail: 'No editable form field was on screen.',
      filled: [],
      formErrors: [],
      brainAssisted: false,
      cleared: true,
    };
  }

  const { plan, brainAssisted } = await planValues(page, job, fields.map((entry) => entry.field), options);
  const fingerprint = fingerprintOf(plan);
  const filled = await applyPlan(fields, plan);
  await log(
    job,
    `Filled ${filled.length} of ${fields.length} field(s) on "${options.label}" with synthetic values.`,
    'info',
    { form: options.label, url: page.url(), filled, brain_assisted: brainAssisted },
  );

  const submit = await findSubmit(page, scope);
  if (!submit) {
    return await giveUp(page, job, options, filled, brainAssisted, fingerprint,
      'The form has no recognisable submit control.');
  }

  const submitLabel = await controlLabel(submit);
  const guard = evaluateClick(submitLabel || 'submit', {
    destructiveAllowed: !!job.session.destructive_allowed,
    environment: job.profile.environment,
    allowSafeDemo: !!job.profile.allow_safe_demo,
  });
  if (!guard.allowed) {
    return await giveUp(page, job, options, filled, brainAssisted, fingerprint,
      `Submitting "${submitLabel}" is not permitted here: ${guard.reason}.`);
  }

  const first = await submitAndVerify(page, submit, submitLabel, fingerprint);
  if (first.accepted) {
    const detail = `Submitted "${options.label}" with synthetic values (clicked "${submitLabel}").`;
    await log(job, detail, 'info', { form: options.label, filled });
    return { status: 'submitted', detail, filled, formErrors: [], brainAssisted, cleared: true };
  }

  // The validation text names exactly what is still wrong, which is far better
  // input than the field labels alone. Worth one corrective pass.
  const retry = await retryWithErrors(page, job, options, first.errors, brainAssisted);
  if (retry) return retry;

  const detail = `"${options.label}" rejected the synthetic values (clicked "${submitLabel}").`;
  await log(job, `${detail} form_errors=[${first.errors.join(' | ')}]`, 'warn', {
    form: options.label, url: page.url(), filled, form_errors: first.errors,
  });
  const shot = options.screenshotsDir
    ? await captureScreenshot(page, options.screenshotsDir, `form-rejected-${slug(options.label)}`).catch(() => undefined)
    : undefined;
  const dismissed = await dismissForm(page, fingerprint);
  return {
    status: 'rejected',
    detail: shot ? `${detail} screenshot=${shot}` : detail,
    filled,
    formErrors: first.errors,
    brainAssisted,
    cleared: dismissed,
  };
}

async function retryWithErrors(
  page: Page,
  job: Job,
  options: ResolveFormOptions,
  errors: string[],
  brainAssisted: boolean,
): Promise<FormAttempt | null> {
  if (errors.length === 0) return null;
  const scope = await formScope(page);
  const fields = await collectFields(page, scope);
  if (fields.length === 0) return null;

  const { plan } = await planValues(page, job, fields.map((entry) => entry.field), options, errors);
  const refilled = await applyPlan(fields, plan);
  if (refilled.length === 0) return null;

  const submit = await findSubmit(page, scope);
  if (!submit) return null;
  const submitLabel = await controlLabel(submit);
  const second = await submitAndVerify(page, submit, submitLabel, fingerprintOf(plan));
  if (!second.accepted) return null;

  const detail = `Submitted "${options.label}" after correcting ${errors.length} validation error(s).`;
  await log(job, detail, 'info', { form: options.label, filled: refilled, corrected: errors });
  return {
    status: 'submitted', detail, filled: refilled, formErrors: [], brainAssisted, cleared: true,
  };
}

/** Cannot submit: fill stays as evidence, then close the form so the run continues. */
async function giveUp(
  page: Page,
  job: Job,
  options: ResolveFormOptions,
  filled: string[],
  brainAssisted: boolean,
  fingerprint: string,
  why: string,
): Promise<FormAttempt> {
  await log(job, `${why} Leaving "${options.label}" without submitting.`, 'info', {
    form: options.label, url: page.url(), filled,
  });
  const dismissed = await dismissForm(page, fingerprint);
  return {
    status: dismissed ? 'dismissed' : 'filled',
    detail: dismissed ? `${why} The form was closed so the run could continue.` : why,
    filled,
    formErrors: [],
    brainAssisted,
    cleared: dismissed,
  };
}

async function planValues(
  page: Page,
  job: Job,
  fields: FormFieldDescriptor[],
  options: ResolveFormOptions,
  formErrors?: string[],
): Promise<{ plan: PlannedField[]; brainAssisted: boolean }> {
  const plan = planFromHeuristics(fields, {
    entityName: options.entityName,
    email: process.env.SMOKE_COMPANY_EMAIL?.trim() || undefined,
  });
  const needing = fieldsNeedingBrain(plan);
  if (needing.length === 0 && !formErrors?.length) {
    return { plan: applyLastResort(plan), brainAssisted: false };
  }

  // On a retry, let the model see every field the form is still complaining about.
  const ask = needing.length > 0 ? needing : plan.filter((entry) => entry.source !== 'unresolved');
  try {
    const proposed = await proposeFormValues({
      entries: ask,
      product: job.run.product_name,
      environment: job.profile.environment,
      url: page.url(),
      formLabel: options.label,
      formErrors,
    });
    const merged = mergeBrainValues(plan, proposed);
    const fromBrain = merged.filter((entry) => entry.source === 'brain');
    if (fromBrain.length > 0) {
      await log(
        job,
        `Brain supplied values for ${fromBrain.length} unmapped field(s) on "${options.label}".`,
        'info',
        { form: options.label, brain_values: describePlan(fromBrain) },
      );
    }
    return { plan: applyLastResort(merged), brainAssisted: fromBrain.length > 0 };
  } catch (error) {
    await log(job, `Brain form-fill proposal failed; keeping heuristic values: ${errorMessage(error)}`, 'warn');
    return { plan: applyLastResort(plan), brainAssisted: false };
  }
}

type FieldHandle = { control: Locator; field: FormFieldDescriptor & { value: string } };

async function collectFields(page: Page, scope: FormScope): Promise<FieldHandle[]> {
  const controls = scope === page
    ? page.locator('input, select, textarea')
    : (scope as Locator).locator('input, select, textarea');
  const total = Math.min(await controls.count().catch(() => 0), MAX_FIELDS);
  const handles: FieldHandle[] = [];
  for (let index = 0; index < total; index++) {
    const control = controls.nth(index);
    if (!await control.isVisible().catch(() => false)) continue;
    if (!await control.isEnabled().catch(() => false)) continue;
    const info = await describeField(control);
    if (!info) continue;
    if (!isWritableType(info.type)) continue;
    if (await looksLikeSearchField(control)) continue;
    handles.push({ control, field: info });
  }
  return handles;
}

/** Values already on the form are the tenant's, or a default worth keeping. */
async function applyPlan(fields: FieldHandle[], plan: PlannedField[]): Promise<string[]> {
  const filled: string[] = [];
  for (let index = 0; index < fields.length; index++) {
    const { control, field } = fields[index];
    const planned = plan[index];
    if (!planned) continue;
    if (field.value.trim() !== '') continue;

    if (field.tag === 'select') {
      // Selects take the first real option rather than a synthesised string: the
      // value has to be one the control actually offers.
      const option = await firstRealOption(control);
      if (!option) continue;
      await control.selectOption(option.value).catch(() => {});
      filled.push(`${planned.key}=${option.text}`);
      continue;
    }
    if (planned.value === null) continue;
    await fillTextField(control, planned.value);
    filled.push(`${planned.key}=${planned.value}`);
  }
  return filled;
}

async function findSubmit(page: Page, scope: FormScope): Promise<Locator | null> {
  const within = scope === page ? page : (scope as Locator);
  const candidates = [
    () => within.getByRole('button', { name: SUBMIT_LABEL }),
    () => within.locator('button[type="submit"], input[type="submit"]'),
  ];
  for (const build of candidates) {
    let matches: Locator;
    try {
      matches = build().filter({ visible: true });
    } catch {
      continue;
    }
    const count = Math.min(await matches.count().catch(() => 0), 5);
    for (let index = 0; index < count; index++) {
      const candidate = matches.nth(index);
      if (await candidate.isEnabled().catch(() => false)) return candidate;
    }
  }
  return null;
}

async function submitAndVerify(
  page: Page,
  submit: Locator,
  submitLabel: string,
  fingerprint: string,
): Promise<{ accepted: boolean; errors: string[] }> {
  await submit.click({ timeout: 8_000 }).catch(() => {});
  await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {});

  const deadline = Date.now() + 10_000;
  let errors: string[] = [];
  while (Date.now() < deadline) {
    errors = await collectFormErrors(page);
    if (errors.length > 0) return { accepted: false, errors };
    // This form going away is the clearest signal it was accepted. Comparing the
    // field set rather than "is any form left" keeps a landing page's own filters
    // from reading as a rejected submit.
    if (await currentFingerprint(page) !== fingerprint) return { accepted: true, errors: [] };
    await page.waitForTimeout(500);
  }
  return {
    accepted: false,
    errors: errors.length ? errors : [`form still open after clicking "${submitLabel}"`],
  };
}

/** Identity of the form on screen: which fields it is asking for. */
function fingerprintOf(plan: PlannedField[]): string {
  return plan.map((entry) => entry.key).join('|');
}

async function currentFingerprint(page: Page): Promise<string> {
  const scope = await formScope(page);
  const fields = await collectFields(page, scope);
  return fingerprintOf(planFromHeuristics(fields.map((entry) => entry.field)));
}

/** Escape, then any close/cancel control, so a modal cannot hold the run hostage. */
async function dismissForm(page: Page, fingerprint: string): Promise<boolean> {
  const gone = async (): Promise<boolean> => await currentFingerprint(page) !== fingerprint;
  await dismissOverlays(page);
  if (await gone()) return true;

  const closers = [
    () => page.getByRole('button', { name: /^(cancel|close|discard|back|not now|skip)\b/i }),
    () => page.locator('[aria-label*="close" i], [class*="close" i][role="button"], button.close'),
  ];
  for (const build of closers) {
    let matches: Locator;
    try {
      matches = build().filter({ visible: true });
    } catch {
      continue;
    }
    const count = Math.min(await matches.count().catch(() => 0), 4);
    for (let index = 0; index < count; index++) {
      await matches.nth(index).click({ timeout: 4_000 }).catch(() => {});
      await page.waitForTimeout(400);
      if (await gone()) return true;
    }
  }
  return false;
}

async function controlLabel(control: Locator): Promise<string> {
  const text = (await control.innerText().catch(() => '')) || '';
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed) return trimmed;
  return (await control.getAttribute('value').catch(() => '')) || '';
}

async function log(
  job: Job,
  message: string,
  level: 'info' | 'warn' = 'info',
  context?: Record<string, unknown>,
): Promise<void> {
  await appendLog({
    run_id: job.run_id,
    session_id: job.session.id,
    job_id: job.job_id,
    level,
    message,
    ...(context ? { context } : {}),
  }).catch(() => {});
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'form';
}
