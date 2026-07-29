import type { Page } from 'playwright';
import type { Job } from '../backend.js';
import { evaluateClick } from '../utils/safeActionGuard.js';
import { dismissOverlays } from '../utils/dismissOverlays.js';
import type { DecisionChoice } from './askDecision.js';

export type NavActionContext = {
  href?: string;
  companyName?: string;
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
    await createCompany(page, option.company_name || context.companyName || choice.freeText);
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

async function createCompany(page: Page, requestedName?: string): Promise<void> {
  const name = requestedName?.trim() || process.env.SMOKE_COMPANY_NAME?.trim() || 'Smoke Test Co';
  const create = page.getByRole('button', { name: /create|add|new/i }).filter({ visible: true }).first();
  if (!await create.count()) throw new Error('No create-company control was found.');
  await create.click({ timeout: 8_000 });

  const input = page.getByRole('textbox', { name: /company|organisation|organization|business.*name|name/i })
    .filter({ visible: true })
    .first();
  if (!await input.count()) throw new Error('No company-name field was found after opening create company.');
  await input.fill(name);

  const submit = page.getByRole('button', { name: /create|continue|add company|save/i })
    .filter({ visible: true })
    .first();
  if (!await submit.count()) throw new Error('No create-company submit control was found.');
  await submit.click({ timeout: 8_000 });
  await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {});
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
