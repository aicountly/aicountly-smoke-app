import type { Locator, Page } from 'playwright';
import type { Job } from '../backend.js';
import { captureScreenshot } from '../scanner/screenshotCapture.js';
import { evaluateClick } from '../utils/safeActionGuard.js';
import { dismissOverlays } from '../utils/dismissOverlays.js';
import type { DecisionChoice } from './askDecision.js';

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

async function createCompany(page: Page, requestedName?: string, screenshotsDir?: string): Promise<void> {
  const name = requestedName?.trim() || process.env.SMOKE_COMPANY_NAME?.trim() || 'Smoke Test Co';

  // Empty-state pages sometimes render the form inline, with no control to click.
  let field = await findCompanyNameField(page, 1_500);
  if (!field) {
    await openCreateCompanyForm(page, screenshotsDir);
    field = await findCompanyNameField(page, 12_000);
  }
  if (!field) {
    throw new Error(await describeFailure(page, screenshotsDir,
      'No company-name field was found after opening create company.'));
  }

  await field.fill(name).catch(() => {});
  if ((await field.inputValue().catch(() => '')).trim() !== name) {
    // Controlled React inputs occasionally ignore fill(); real keystrokes dispatch
    // the input events their state depends on.
    await field.click({ timeout: 5_000 }).catch(() => {});
    await field.press('ControlOrMeta+a').catch(() => {});
    await field.pressSequentially(name, { delay: 25, timeout: 10_000 });
  }

  const scope = await dialogOrPage(page);
  const submit = await firstVisible([
    () => scope.getByRole('button', { name: /^(create|save|continue|submit|add|next|done)\b/i }),
    () => scope.getByRole('button', { name: CREATE_COMPANY_TEXT }),
    () => scope.locator('button[type="submit"], input[type="submit"]'),
  ]);
  if (!submit) {
    throw new Error(await describeFailure(page, screenshotsDir,
      `No create-company submit control was found (name field was filled with "${name}").`));
  }
  await submit.click({ timeout: 8_000 });
  await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {});
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
      ], { editable: true });
      if (field) return field;
    }
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(250);
  }
}

async function firstVisible(
  builders: Array<() => Locator>,
  opts: { editable?: boolean } = {},
): Promise<Locator | null> {
  for (const build of builders) {
    let candidate: Locator;
    try {
      candidate = build().filter({ visible: true }).first();
    } catch {
      continue; // one unsupported strategy must not kill the rest
    }
    if (!await candidate.count().catch(() => 0)) continue;
    if (opts.editable && !await candidate.isEditable({ timeout: 500 }).catch(() => false)) continue;
    return candidate;
  }
  return null;
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
