import type { Locator, Page } from 'playwright';
import { appendLog, type Job } from '../backend.js';
import { captureScreenshot } from '../scanner/screenshotCapture.js';
import { evaluateClick } from '../utils/safeActionGuard.js';
import { allowsFullAccess } from '../utils/environments.js';
import { dismissOverlays } from '../utils/dismissOverlays.js';
import type { DecisionChoice } from './askDecision.js';
import { findCompanyCards, pickCompany } from './companyCards.js';
import {
  bodyMentionsCompany,
  hasEmptyCompanyCopy,
  isDuplicateCompanyError,
  isEmptyCompanyWorkspace,
} from './companyPicker.js';
import { lastResortValue, synthesizeFieldValue } from '../forms/fieldSynthesis.js';
import {
  collectFormErrors,
  describeField,
  describeVisibleControls,
  DIALOG_SELECTOR,
  dialogOrPage,
  fillTextField,
  firstRealOption,
  firstVisible,
  formScope,
  isWritableType,
  scopeText,
  type FormScope,
} from '../forms/formDom.js';

export type NavActionContext = {
  href?: string;
  companyName?: string;
  screenshotsDir?: string;
};

export type NavActionResult = {
  navigated: boolean;
  rescan: boolean;
  skipped: boolean;
};

export class NavAbortError extends Error {
  constructor(message = 'The smoke session was aborted by decision.') {
    super(message);
    this.name = 'NavAbortError';
  }
}

export async function performNavAction(
  page: Page,
  job: Job,
  choice: DecisionChoice,
  context: NavActionContext = {},
): Promise<NavActionResult> {
  const { option } = choice;
  if (option.action === 'abort_session') throw new NavAbortError(choice.freeText || option.label);
  if (option.action === 'skip_target') return { navigated: false, rescan: false, skipped: true };
  if (option.action === 'rescan_menus') return { navigated: false, rescan: true, skipped: false };
  if (option.action === 'dismiss_overlay') {
    await dismissOverlays(page);
    return { navigated: false, rescan: true, skipped: false };
  }

  assertActionAllowed(job, choice);

  if (option.action === 'navigate_href') {
    const href = option.href || context.href || choice.freeText;
    if (!href) throw new Error('navigate_href decision did not include a destination.');
    const destination = new URL(href, page.url());
    assertAllowedDestination(destination, job);
    await page.goto(destination.toString(), { waitUntil: 'domcontentloaded', timeout: 20_000 });
    return { navigated: true, rescan: true, skipped: false };
  }

  if (option.action === 'open_company') {
    await openCompany(page, option.company_name || context.companyName || choice.freeText);
    return { navigated: true, rescan: true, skipped: false };
  }

  if (option.action === 'create_company') {
    assertMayCreateCompany(job, choice);
    const requested = option.company_name || context.companyName || choice.freeText;
    const outcome = await createCompany(page, requested, context.screenshotsDir);
    if (outcome.status === 'already_exists') {
      await appendLog({
        run_id: job.run_id,
        session_id: job.session.id,
        job_id: job.job_id,
        level: 'info',
        message: `Company "${outcome.name}" already exists (${outcome.evidence}); `
          + 'treating create as satisfied instead of creating a duplicate.',
      }).catch(() => {});
    }
    return { navigated: true, rescan: true, skipped: false };
  }

  return { navigated: false, rescan: false, skipped: false };
}

/**
 * "Create a company" reads as a harmless label, so the restricted-token guard
 * lets it through; approval is what actually gates it. A human or a remembered
 * human choice may create anywhere, but the run may only decide this for itself
 * on a tier that already permits mutations.
 */
function assertMayCreateCompany(job: Job, choice: DecisionChoice): void {
  if (!choice.explicitApproval) {
    throw new Error('Creating a company requires an explicit decision.');
  }
  if (choice.source === 'user' || choice.source === 'memory') return;
  if (!allowsFullAccess(job.profile.environment)) {
    throw new Error(
      `Autonomous company creation needs sandbox, gh_staging or production_full_access, not ${job.profile.environment}.`,
    );
  }
}

function assertActionAllowed(job: Job, choice: DecisionChoice): void {
  const decision = evaluateClick(choice.option.label || choice.option.action, {
    destructiveAllowed: !!job.session.destructive_allowed,
    environment: job.profile.environment,
    allowSafeDemo: !!job.profile.allow_safe_demo,
  });
  if (decision.allowed) return;
  if (choice.option.action === 'create_company' && choice.explicitApproval) return;
  throw new Error(`Navigation action "${choice.option.label}" was blocked: ${decision.reason}`);
}

function assertAllowedDestination(destination: URL, job: Job): void {
  const base = new URL(job.profile.base_url);
  const configured = parseList(job.profile.allowed_domains);
  const allowedHosts = new Set([base.hostname, ...configured.map(normalizeHost).filter(Boolean)]);
  if (!allowedHosts.has(destination.hostname)) {
    throw new Error(`Navigation to unapproved host "${destination.hostname}" was blocked.`);
  }
}

async function openCompany(page: Page, preferred?: string): Promise<void> {
  if (preferred) {
    const exact = page.getByText(preferred, { exact: false }).filter({ visible: true }).first();
    if (await exact.count() && await exact.isVisible().catch(() => false)) {
      await exact.click({ timeout: 8_000 });
      await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
      return;
    }
  }
  const cards = await findCompanyCards(page);
  if (cards.length === 0) {
    throw new Error(preferred
      ? `No company matching "${preferred}" could be opened, and no company row could be identified.`
      : 'No visible company could be opened.');
  }
  const card = pickCompany(cards, preferred);
  await card.locator.click({ timeout: 8_000 });
  await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
}

const NAME_FIELD_TEXT = /compan|organi[sz]ation|business|firm|entity|name/i;
const CREATE_COMPANY_TEXT = /(create|add|new|register|setup|set up)[^a-z]*(compan|organi[sz]ation|business|firm|entity)/i;

/**
 * The create control can hand off to a sibling app that boots on its own
 * dashboard before routing to the create screen. These are the routes to try
 * directly, on the origin we were handed off to, when that routing never lands.
 */
const CREATE_COMPANY_ROUTES = ['#/company/new', '#/company/create', '/company/new'];

export type CreateCompanyOutcome = {
  status: 'created' | 'already_exists';
  name: string;
  evidence: string;
};

/**
 * Creating the smoke company has to be repeatable: a retried session replays the
 * same remembered choice, and the target rejects a second company with the same
 * name. "It is already there" is the state this action wants, so both the
 * pre-flight check and a duplicate-name rejection count as success.
 */
async function createCompany(
  page: Page,
  requestedName?: string,
  screenshotsDir?: string,
): Promise<CreateCompanyOutcome> {
  const name = requestedName?.trim() || process.env.SMOKE_COMPANY_NAME?.trim() || 'Smoke Test Co';

  const body = (await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '')).slice(0, 30_000);
  if (!isEmptyCompanyWorkspace(body) && bodyMentionsCompany(body, name)) {
    return { status: 'already_exists', name, evidence: 'already listed on the picker' };
  }

  // Empty-state pages sometimes render the form inline, with no control to click.
  // Never treat the picker search box ("Search companies...") as the name field —
  // its placeholder matches /compan/ and used to make create "succeed" without creating.
  let field = await findCompanyNameField(page, 1_500);
  if (!field) {
    await openCreateCompanyForm(page, screenshotsDir);
    field = await waitForCompanyNameField(page);
  }
  if (!field) {
    throw new Error(await describeFailure(page, screenshotsDir,
      'No company-name field was found after opening create company.'));
  }
  // A generic "Add"/"New" control can open some other entity's form that also has
  // a name field. Filling that on a live target would create the wrong record.
  if (!await looksLikeCompanyForm(page)) {
    throw new Error(await describeFailure(page, screenshotsDir,
      'A name field was found but the surrounding form does not look like company creation; '
      + 'refusing to submit it.'));
  }

  await fillTextField(field, name);

  // Manage creates a company through a whole setup screen, so a name alone leaves
  // the form failing its own validation and sitting exactly where it started.
  const filled = await fillCompanyForm(page, name);

  const scope = await dialogOrPage(page);
  // Prefer real form submit labels. Do NOT match "+ Add Company" — that opens the
  // create form (and is what we already clicked), it does not submit it.
  const submit = await firstVisible([
    () => scope.getByRole('button', { name: /^(create|save|continue|submit|next|done)\b/i }),
    () => scope.locator('button[type="submit"], input[type="submit"]'),
  ]);
  if (!submit) {
    throw new Error(await describeFailure(page, screenshotsDir,
      `No create-company submit control was found (name field was filled with "${name}").`));
  }
  const submitLabel = ((await submit.innerText().catch(() => '')) || '').trim().replace(/\s+/g, ' ');
  await submit.click({ timeout: 8_000 });
  await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {});
  return assertCompanyCreateLanded(page, name, screenshotsDir, submitLabel, filled);
}

/**
 * Waits out a cross-app handoff. The sibling app may boot on its own dashboard
 * first, so poll for the field and only then try the create routes directly.
 */
async function waitForCompanyNameField(page: Page): Promise<Locator | null> {
  const field = await findCompanyNameField(page, 12_000);
  if (field) return field;

  const origin = originOf(page.url());
  if (!origin) return null;
  for (const route of CREATE_COMPANY_ROUTES) {
    const target = `${origin}/${route.replace(/^\//, '')}`;
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
    // A hash-only change is a same-document navigation; give the router a tick.
    await page.waitForTimeout(750);
    const retried = await findCompanyNameField(page, 8_000);
    if (retried) return retried;
  }
  return null;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Fills every mappable field on the create-company form and returns
 * "label=value" pairs so a failed submit can say what was actually entered.
 */
async function fillCompanyForm(page: Page, companyName: string): Promise<string[]> {
  const scope = await formScope(page);
  const controls = scope === page
    ? page.locator('input, select, textarea')
    : (scope as Locator).locator('input, select, textarea');
  const total = Math.min(await controls.count().catch(() => 0), 80);
  const email = process.env.SMOKE_COMPANY_EMAIL?.trim() || undefined;
  const filled: string[] = [];

  for (let index = 0; index < total; index++) {
    const control = controls.nth(index);
    if (!await control.isVisible().catch(() => false)) continue;
    if (!await control.isEnabled().catch(() => false)) continue;

    const info = await describeField(control);
    if (!info) continue;
    if (!isWritableType(info.type)) continue;
    if (info.value.trim() !== '') continue;

    if (info.tag === 'select') {
      const option = await firstRealOption(control);
      if (!option) continue;
      await control.selectOption(option.value).catch(() => {});
      filled.push(`${info.name || info.label || 'select'}=${option.text}`);
      continue;
    }

    const value = synthesizeFieldValue(info, { entityName: companyName, email })
      ?? (info.required ? lastResortValue(info) : null);
    if (value === null) continue;
    await fillTextField(control, value);
    filled.push(`${info.name || info.label || info.placeholder || 'field'}=${value}`);
  }
  return filled;
}

/** Confirms the open form is company creation and not another entity's "Add" form. */
async function looksLikeCompanyForm(page: Page): Promise<boolean> {
  if (/compan/i.test(page.url())) return true;
  const haystack = await scopeText(page, await formScope(page));
  if (/\b(branch|employee|department|designation|invoice|voucher|user)\b/i.test(haystack)
    && !/compan|organi[sz]ation/i.test(haystack)) {
    return false;
  }
  return /compan|organi[sz]ation|firm|entity/i.test(haystack);
}

async function openCreateCompanyForm(page: Page, screenshotsDir?: string): Promise<void> {
  // Company-specific wording first: a bare /create|add|new/ match happily picks up
  // an unrelated toolbar or menu control and leaves the page where it was.
  const create = await firstVisible([
    () => page.getByRole('button', { name: CREATE_COMPANY_TEXT }),
    () => page.getByRole('link', { name: CREATE_COMPANY_TEXT }),
    () => page.locator('[role="button"]').filter({ hasText: CREATE_COMPANY_TEXT }),
    () => page.getByRole('button', { name: /^(create|add|new)\b/i }),
    () => page.getByRole('link', { name: /^(create|add|new)\b/i }),
  ]);
  if (!create) {
    throw new Error(await describeFailure(page, screenshotsDir, 'No create-company control was found.'));
  }
  await create.click({ timeout: 8_000 });
  await page.waitForSelector(`${DIALOG_SELECTOR}, form`, { state: 'visible', timeout: 10_000 }).catch(() => {});
}

async function findCompanyNameField(page: Page, timeoutMs: number): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const scoped = await dialogOrPage(page);
    // Search the dialog first, then the whole page in case the form is inline.
    const scopes: FormScope[] = scoped === page ? [page] : [scoped, page];
    for (const scope of scopes) {
      const field = await firstVisible([
        () => scope.getByRole('textbox', { name: NAME_FIELD_TEXT }),
        () => scope.getByLabel(NAME_FIELD_TEXT),
        () => scope.getByPlaceholder(NAME_FIELD_TEXT),
        () => scope.locator(
          'input[name*="compan" i], input[id*="compan" i], input[formcontrolname*="compan" i],'
          + 'input[name*="organi" i], input[id*="organi" i]',
        ),
        () => scope.locator('input[name*="name" i], input[id*="name" i], input[formcontrolname*="name" i]'),
        // Last resort: the first plain text box that is clearly not a search field.
        () => scope.locator(
          'input[type="text"]:not([name*="search" i]):not([id*="search" i]):not([placeholder*="search" i]),'
          + 'input:not([type]):not([name*="search" i]):not([id*="search" i])',
        ),
      ], { editable: true, rejectSearch: true });
      if (field) return field;
    }
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(250);
  }
}

async function assertCompanyCreateLanded(
  page: Page,
  name: string,
  screenshotsDir?: string,
  submitLabel = '',
  filled: string[] = [],
): Promise<CreateCompanyOutcome> {
  const deadline = Date.now() + 20_000;
  let formStillOpen = false;
  let stillEmpty = false;
  while (Date.now() < deadline) {
    const bodyText = (await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '')).slice(0, 30_000);
    stillEmpty = hasEmptyCompanyCopy(bodyText);
    // Name sitting only in the still-open create form is not proof of create.
    formStillOpen = !!(await findCompanyNameField(page, 250));
    const nameVisible = bodyMentionsCompany(bodyText, name);
    if (!stillEmpty && !formStillOpen && nameVisible) return { status: 'created', name, evidence: 'listed after submit' };
    if (!stillEmpty && !formStillOpen && !/create\s+(new\s+)?compan/i.test(bodyText)) {
      return { status: 'created', name, evidence: 'create form closed without error' };
    }
    if (formStillOpen && isDuplicateCompanyError(await collectFormErrors(page))) {
      return { status: 'already_exists', name, evidence: 'the target rejected the name as a duplicate' };
    }
    await page.waitForTimeout(400);
  }

  const blocker = formStillOpen
    ? 'the create form is still open, so it rejected the submit'
    : stillEmpty
      ? 'the empty company picker is still showing'
      : 'the new company never became visible';
  const errors = formStillOpen ? await collectFormErrors(page) : [];
  const detail = [
    `Company create for "${name}" did not complete: ${blocker}`
    + (submitLabel ? ` (clicked "${submitLabel}")` : '') + '.',
    errors.length ? `form_errors=[${errors.join(' | ')}]` : 'form_errors=none',
    filled.length ? `filled=[${filled.join(' | ')}]` : 'filled=[name only]',
  ].join(' ');
  throw new Error(await describeFailure(page, screenshotsDir, detail));
}

/**
 * The worker cannot see the tenant's DOM, so a bare "not found" costs another
 * whole run to diagnose. Attach what was actually on screen instead.
 */
async function describeFailure(page: Page, screenshotsDir: string | undefined, message: string): Promise<string> {
  const parts = [message, `url=${page.url()}`];
  const inventory = await describeVisibleControls(page);

  parts.push(`visible_dialogs=${inventory.dialogs}`);
  parts.push(inventory.fields.length
    ? `visible_fields=[${inventory.fields.join(' | ')}]`
    : 'visible_fields=none');
  parts.push(`visible_controls=[${inventory.buttons.join(' | ')}]`);

  if (screenshotsDir) {
    const shot = await captureScreenshot(page, screenshotsDir, 'create-company-failed').catch(() => undefined);
    if (shot) parts.push(`screenshot=${shot}`);
  }
  return parts.join(' ');
}

function parseList(value: string | string[]): string[] {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // Accept comma-separated profile values too.
  }
  return value.split(',').map((part) => part.trim()).filter(Boolean);
}

function normalizeHost(value: string): string {
  try {
    return new URL(value.includes('://') ? value : `https://${value}`).hostname;
  } catch {
    return '';
  }
}
