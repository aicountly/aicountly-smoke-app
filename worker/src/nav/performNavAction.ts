import type { Locator, Page } from 'playwright';
import type { Job } from '../backend.js';
import { captureScreenshot } from '../scanner/screenshotCapture.js';
import { evaluateClick } from '../utils/safeActionGuard.js';
import { dismissOverlays } from '../utils/dismissOverlays.js';
import type { DecisionChoice } from './askDecision.js';
import { bodyMentionsCompany, hasEmptyCompanyCopy } from './companyPicker.js';
import {
  isPlaceholderOption,
  synthesizeCompanyFieldValue,
  type CompanyFormField,
} from './companyFormFields.js';

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
    if (!choice.explicitApproval || (choice.source !== 'user' && choice.source !== 'memory')) {
      throw new Error('Creating a company requires an explicit user or remembered decision.');
    }
    await createCompany(
      page,
      option.company_name || context.companyName || choice.freeText,
      context.screenshotsDir,
    );
    return { navigated: true, rescan: true, skipped: false };
  }

  return { navigated: false, rescan: false, skipped: false };
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
  const cardSelectors = [
    '[data-company-id]',
    '[data-testid*="company" i]',
    '[class*="company-card" i]',
    '[class*="organisation-card" i]',
    '[class*="organization-card" i]',
  ].join(', ');
  if (preferred) {
    const exact = page.getByText(preferred, { exact: false }).filter({ visible: true }).first();
    if (await exact.count() && await exact.isVisible().catch(() => false)) {
      await exact.click({ timeout: 8_000 });
      await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
      return;
    }
  }
  const cards = page.locator(cardSelectors);
  const count = await cards.count();
  for (let index = 0; index < count; index++) {
    const card = cards.nth(index);
    if (!await card.isVisible().catch(() => false)) continue;
    await card.click({ timeout: 8_000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
    return;
  }
  throw new Error('No visible company could be opened.');
}

const NAME_FIELD_TEXT = /compan|organi[sz]ation|business|firm|entity|name/i;
const CREATE_COMPANY_TEXT = /(create|add|new|register|setup|set up)[^a-z]*(compan|organi[sz]ation|business|firm|entity)/i;
const DIALOG_SELECTOR = '[role="dialog"], dialog, [class*="modal" i], [class*="drawer" i], [class*="dialog" i]';

/**
 * The create control can hand off to a sibling app that boots on its own
 * dashboard before routing to the create screen. These are the routes to try
 * directly, on the origin we were handed off to, when that routing never lands.
 */
const CREATE_COMPANY_ROUTES = ['#/company/new', '#/company/create', '/company/new'];

async function createCompany(page: Page, requestedName?: string, screenshotsDir?: string): Promise<void> {
  const name = requestedName?.trim() || process.env.SMOKE_COMPANY_NAME?.trim() || 'Smoke Test Co';

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
  await assertCompanyCreateLanded(page, name, screenshotsDir, submitLabel, filled);
}

async function fillTextField(field: Locator, value: string): Promise<void> {
  await field.fill(value).catch(() => {});
  if ((await field.inputValue().catch(() => '')).trim() === value) return;
  // Controlled React inputs occasionally ignore fill(); real keystrokes dispatch
  // the input events their state depends on.
  await field.click({ timeout: 5_000 }).catch(() => {});
  await field.press('ControlOrMeta+a').catch(() => {});
  await field.pressSequentially(value, { delay: 25, timeout: 10_000 }).catch(() => {});
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
  const scope = await companyFormScope(page);
  const controls = scope.locator('input, select, textarea');
  const total = Math.min(await controls.count().catch(() => 0), 80);
  const email = process.env.SMOKE_COMPANY_EMAIL?.trim() || undefined;
  const filled: string[] = [];

  for (let index = 0; index < total; index++) {
    const control = controls.nth(index);
    if (!await control.isVisible().catch(() => false)) continue;
    if (!await control.isEnabled().catch(() => false)) continue;

    const info = await describeField(control);
    if (!info) continue;
    if (['hidden', 'submit', 'button', 'reset', 'file', 'checkbox', 'radio', 'image'].includes(info.type)) continue;
    if (info.value.trim() !== '') continue;

    if (info.tag === 'select') {
      const option = await firstRealOption(control);
      if (!option) continue;
      await control.selectOption(option.value).catch(() => {});
      filled.push(`${info.name || info.label || 'select'}=${option.text}`);
      continue;
    }

    const value = synthesizeCompanyFieldValue(info, companyName, { email });
    if (value === null) continue;
    await fillTextField(control, value);
    filled.push(`${info.name || info.label || info.placeholder || 'field'}=${value}`);
  }
  return filled;
}

/** Confirms the open form is company creation and not another entity's "Add" form. */
async function looksLikeCompanyForm(page: Page): Promise<boolean> {
  if (/compan/i.test(page.url())) return true;
  const scope = await companyFormScope(page);
  const text = scope === page
    ? await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '')
    : await (scope as Locator).innerText({ timeout: 5_000 }).catch(() => '');
  const haystack = text.slice(0, 10_000);
  if (/\b(branch|employee|department|designation|invoice|voucher|user)\b/i.test(haystack)
    && !/compan|organi[sz]ation/i.test(haystack)) {
    return false;
  }
  return /compan|organi[sz]ation|firm|entity/i.test(haystack);
}

/** Prefer the form holding the company-name field so a page search box is never in scope. */
async function companyFormScope(page: Page): Promise<Page | Locator> {
  const dialog = page.locator(DIALOG_SELECTOR).filter({ visible: true }).first();
  if (await dialog.count().catch(() => 0)) return dialog;
  const form = page.locator('form').filter({ visible: true }).first();
  if (await form.count().catch(() => 0)) return form;
  return page;
}

async function describeField(control: Locator): Promise<(CompanyFormField & { value: string }) | null> {
  return control.evaluate((node) => {
    const el = node as HTMLInputElement;
    const labels = 'labels' in el && el.labels
      ? Array.from(el.labels).map((label) => label.textContent ?? '').join(' ')
      : '';
    return {
      tag: el.tagName.toLowerCase() as 'input' | 'select' | 'textarea',
      type: (el.getAttribute('type') || el.type || 'text').toLowerCase(),
      name: el.getAttribute('name') || '',
      id: el.getAttribute('id') || '',
      placeholder: el.getAttribute('placeholder') || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      label: labels.replace(/\s+/g, ' ').trim().slice(0, 80),
      required: el.required || el.getAttribute('aria-required') === 'true',
      value: String(el.value ?? ''),
    };
  }).catch(() => null);
}

async function firstRealOption(select: Locator): Promise<{ value: string; text: string } | null> {
  const options = await select.evaluate((node) => Array.from((node as HTMLSelectElement).options)
    .filter((option) => !option.disabled)
    .map((option) => ({ value: option.value, text: (option.textContent ?? '').trim() }))).catch(() => []);
  return options.find((option) => !isPlaceholderOption(option.value, option.text)) ?? null;
}

/**
 * The form's own validation text is the fastest route to a fix, so surface it
 * verbatim instead of only reporting that the company never appeared.
 */
async function collectFormErrors(page: Page): Promise<string[]> {
  const messages = await page.evaluate(`(() => {
    const selector = [
      '[role="alert"]', '.invalid-feedback', '.field-error', '.error-message',
      '.error', '.text-danger', '.help-block', '[class*="errorText" i]',
      '[class*="text-red" i]', '[class*="Mui-error" i]',
    ].join(', ');
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const texts = [...document.querySelectorAll(selector)]
      .filter(visible)
      .map((el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim())
      .filter((text) => text.length > 0 && text.length < 200);
    const invalid = [...document.querySelectorAll('[aria-invalid="true"]')]
      .filter(visible)
      .map((el) => 'invalid:' + (el.getAttribute('name') || el.getAttribute('id') || 'field'));
    return [...new Set([...texts, ...invalid])].slice(0, 10);
  })()`).catch(() => [] as string[]);
  return messages as string[];
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

/** Prefer a visible dialog so a search box behind the modal is never a candidate. */
async function dialogOrPage(page: Page): Promise<Page | Locator> {
  const dialog = page.locator(DIALOG_SELECTOR).filter({ visible: true }).first();
  return await dialog.count().catch(() => 0) ? dialog : page;
}

async function findCompanyNameField(page: Page, timeoutMs: number): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const scoped = await dialogOrPage(page);
    // Search the dialog first, then the whole page in case the form is inline.
    const scopes: Array<Page | Locator> = scoped === page ? [page] : [scoped, page];
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
): Promise<void> {
  const deadline = Date.now() + 20_000;
  let formStillOpen = false;
  let stillEmpty = false;
  while (Date.now() < deadline) {
    const bodyText = (await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '')).slice(0, 30_000);
    stillEmpty = hasEmptyCompanyCopy(bodyText);
    // Name sitting only in the still-open create form is not proof of create.
    formStillOpen = !!(await findCompanyNameField(page, 250));
    const nameVisible = bodyMentionsCompany(bodyText, name);
    if (!stillEmpty && !formStillOpen && nameVisible) return;
    if (!stillEmpty && !formStillOpen && !/create\s+(new\s+)?compan/i.test(bodyText)) return;
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

async function firstVisible(
  builders: Array<() => Locator>,
  opts: { editable?: boolean; rejectSearch?: boolean } = {},
): Promise<Locator | null> {
  for (const build of builders) {
    let matches: Locator;
    try {
      matches = build().filter({ visible: true });
    } catch {
      continue; // one unsupported strategy must not kill the rest
    }
    const count = Math.min(await matches.count().catch(() => 0), 8);
    for (let index = 0; index < count; index++) {
      const candidate = matches.nth(index);
      if (opts.editable && !await candidate.isEditable({ timeout: 500 }).catch(() => false)) continue;
      if (opts.rejectSearch && await looksLikeSearchField(candidate)) continue;
      return candidate;
    }
  }
  return null;
}

/** Picker search ("Search companies...") must never be treated as the company name input. */
async function looksLikeSearchField(locator: Locator): Promise<boolean> {
  const attrs = await locator.evaluate((el) => {
    const input = el as HTMLInputElement;
    return {
      name: input.getAttribute('name') || '',
      id: input.getAttribute('id') || '',
      type: (input.getAttribute('type') || input.type || '').toLowerCase(),
      placeholder: input.getAttribute('placeholder') || '',
      ariaLabel: input.getAttribute('aria-label') || '',
      role: input.getAttribute('role') || '',
    };
  }).catch(() => null);
  if (!attrs) return false;
  if (attrs.type === 'search') return true;
  const blob = [attrs.name, attrs.id, attrs.placeholder, attrs.ariaLabel, attrs.role].join(' ');
  return /\bsearch\b/i.test(blob);
}

/**
 * The worker cannot see the tenant's DOM, so a bare "not found" costs another
 * whole run to diagnose. Attach what was actually on screen instead.
 */
async function describeFailure(page: Page, screenshotsDir: string | undefined, message: string): Promise<string> {
  const parts = [message, `url=${page.url()}`];
  const inventory = await page.evaluate(`(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const attr = (el, n) => (el.getAttribute(n) || '').slice(0, 40);
    const fields = [...document.querySelectorAll('input, textarea')]
      .filter(visible)
      .slice(0, 12)
      .map((el) => [
        el.tagName.toLowerCase(),
        'type=' + (attr(el, 'type') || 'text'),
        attr(el, 'name') && 'name=' + attr(el, 'name'),
        attr(el, 'id') && 'id=' + attr(el, 'id'),
        attr(el, 'placeholder') && 'placeholder=' + attr(el, 'placeholder'),
        attr(el, 'aria-label') && 'aria-label=' + attr(el, 'aria-label'),
      ].filter(Boolean).join(' '));
    const buttons = [...document.querySelectorAll('button, [role="button"], a')]
      .filter(visible)
      .map((el) => (el.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 40))
      .filter(Boolean)
      .slice(0, 15);
    const dialogs = [...document.querySelectorAll('[role="dialog"], dialog')].filter(visible).length;
    return { fields, buttons, dialogs };
  })()`) as { fields: string[]; buttons: string[]; dialogs: number };

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
