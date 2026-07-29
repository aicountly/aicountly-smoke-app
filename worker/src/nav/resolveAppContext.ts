import type { Page } from 'playwright';
import { appendLog, backend, type Job } from '../backend.js';
import { captureScreenshot } from '../scanner/screenshotCapture.js';
import { askOrRecallDecision, forgetDecisionMemory, type DecisionOption } from './askDecision.js';
import { hasEmptyCompanyCopy, looksLikeCompanyPicker } from './companyPicker.js';
import { performNavAction, type NavActionResult } from './performNavAction.js';

export type ResolveAppContextOptions = {
  screenshotsDir?: string;
};

export type ResolveAppContextResult = NavActionResult & {
  detected: boolean;
};

const COMPANY_CARD_SELECTOR = [
  '[data-company-id]',
  '[data-testid*="company" i]',
  '[class*="company-card" i]',
  '[class*="organisation-card" i]',
  '[class*="organization-card" i]',
].join(', ');

export async function resolveAppContext(
  page: Page,
  job: Job,
  options: ResolveAppContextOptions = {},
): Promise<ResolveAppContextResult> {
  const url = page.url();
  const bodyText = (await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '')).slice(0, 30_000);
  if (!looksLikeCompanyPicker(url, bodyText)) {
    return { detected: false, navigated: false, rescan: false, skipped: false };
  }

  const cards = await visibleCompanyCards(page);
  const empty = hasEmptyCompanyCopy(bodyText);
  const companyName = process.env.SMOKE_COMPANY_NAME?.trim() || 'Smoke Test Co';

  if (cards.length > 0) {
    const preferred = process.env.SMOKE_COMPANY_NAME?.trim();
    const card = pickCompany(cards, preferred);
    try {
      await card.locator.click({ timeout: 8_000 });
      await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
      await log(job, `Opened company context "${card.label || preferred || 'first available'}"`);
      return { detected: true, navigated: true, rescan: true, skipped: false };
    } catch (error) {
      return decide(
        page,
        job,
        options,
        'company_picker_click_blocked',
        'The company picker is visible, but the preferred company could not be opened. How should the smoke run proceed?',
        [
          { id: 'dismiss_and_retry', label: 'Dismiss the overlay and rescan companies', action: 'dismiss_overlay' },
          {
            id: 'open_company',
            label: `Open ${card.label || preferred || 'the first company'}`,
            action: 'open_company',
            company_name: card.label || preferred,
          },
          { id: 'skip_company_scoped_menus', label: 'Skip company-scoped navigation', action: 'skip_target' },
          { id: 'abort_session', label: 'Abort this session', action: 'abort_session' },
        ],
        { error: errorMessage(error), labels: cards.map((item) => item.label) },
      );
    }
  }

  if (empty || cards.length === 0) {
    // Earlier sessions in this run may have "created" a company that never landed.
    // Surface that as a hard validation failure instead of silently replaying memory.
    const priorCreate = await priorCreateCompanyInRun(job).catch(() => null);
    if (priorCreate) {
      await forgetDecisionMemory(job, 'company_picker_empty').catch(() => {});
      await log(
        job,
        `Validation failed: session/job previously chose Create but picker is still empty `
        + `(prior_session_id=${priorCreate.session_id}, prior_option=${priorCreate.selected_option}, url=${url}).`,
        'error',
      );
      throw new Error(
        `Company "${companyName}" is still missing after an earlier create decision in this run `
        + `(session_id=${priorCreate.session_id}). The company was never created successfully — `
        + 'refusing to continue with an empty workspace.',
      );
    }

    return decide(
      page,
      job,
      options,
      empty ? 'company_picker_empty' : 'company_picker_ambiguous',
      empty
        ? 'No companies were found. How should the smoke run proceed?'
        : 'A company picker was detected, but no company card could be identified. How should the smoke run proceed?',
      [
        {
          id: 'create_company',
          label: `Create "${companyName}"`,
          action: 'create_company',
          company_name: companyName,
        },
        { id: 'rescan_menus', label: 'Rescan the company picker', action: 'rescan_menus' },
        { id: 'skip_company_scoped_menus', label: 'Skip company-scoped navigation', action: 'skip_target' },
        { id: 'abort_session', label: 'Abort this session', action: 'abort_session' },
      ],
      { labels: [], empty_state_detected: empty, company_name: companyName },
    );
  }

  return { detected: true, navigated: false, rescan: false, skipped: false };
}

async function decide(
  page: Page,
  job: Job,
  resolveOptions: ResolveAppContextOptions,
  situationKey: string,
  question: string,
  options: DecisionOption[],
  context: Record<string, unknown>,
): Promise<ResolveAppContextResult> {
  const screenshotPath = resolveOptions.screenshotsDir
    ? await captureScreenshot(page, resolveOptions.screenshotsDir, `decision-${situationKey}`).catch(() => undefined)
    : undefined;
  const ask = (ignoreMemory: boolean) => askOrRecallDecision({
    job,
    page,
    situationKey,
    question,
    options,
    context,
    screenshotPath,
    ignoreMemory,
  });
  const act = (choice: Awaited<ReturnType<typeof askOrRecallDecision>>) => performNavAction(page, job, choice, {
    companyName: choice.option.company_name,
    screenshotsDir: resolveOptions.screenshotsDir,
  });

  const choice = await ask(false);
  try {
    return await finishDecision(page, job, choice, act);
  } catch (error) {
    // A remembered choice that no longer works would otherwise replay and fail
    // identically on every retry, burning the run without ever asking anyone.
    if (choice.source !== 'memory') throw error;
    await log(
      job,
      `Remembered choice "${choice.option.label}" failed: ${errorMessage(error)} — forgetting it and asking again.`,
      'warn',
    );
    await forgetDecisionMemory(job, situationKey).catch(async (forgetError: unknown) => {
      await log(job, `Could not forget bad decision memory: ${errorMessage(forgetError)}`, 'warn');
    });
    return finishDecision(page, job, await ask(true), act);
  }
}

async function finishDecision(
  page: Page,
  job: Job,
  choice: Awaited<ReturnType<typeof askOrRecallDecision>>,
  act: (choice: Awaited<ReturnType<typeof askOrRecallDecision>>) => Promise<NavActionResult>,
): Promise<ResolveAppContextResult> {
  const pickerUrl = page.url();
  if (choice.option.action === 'create_company') {
    await log(job, `Creating company "${choice.option.company_name || 'Smoke Test Co'}" (source=${choice.source})`);
  }
  const result = { detected: true as const, ...await act(choice) };
  if (choice.option.action === 'create_company') {
    await returnToPicker(page, job, pickerUrl);
    await openCreatedCompanyIfListed(page, job, choice.option.company_name);
  }
  await assertWorkspaceReady(page, job, choice.option.action);
  return result;
}

/**
 * Creating a company can hand off to a sibling app on another host. The session
 * belongs to the product we logged into, so come back before opening the company.
 */
async function returnToPicker(page: Page, job: Job, pickerUrl: string): Promise<void> {
  const current = hostOf(page.url());
  const picker = hostOf(pickerUrl);
  if (!current || !picker || current === picker) return;
  await log(job, `Returning to ${picker} after creating the company on ${current}`);
  await page.goto(pickerUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(1_000);
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

async function openCreatedCompanyIfListed(page: Page, job: Job, preferred?: string): Promise<void> {
  const name = preferred || process.env.SMOKE_COMPANY_NAME?.trim() || 'Smoke Test Co';
  const cards = await visibleCompanyCards(page);
  if (cards.length > 0) {
    const card = pickCompany(cards, name);
    try {
      await card.locator.click({ timeout: 8_000 });
      await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
      await log(job, `Opened company context after create "${card.label || name}"`);
      return;
    } catch (error) {
      throw new Error(`Created a company but could not open it: ${errorMessage(error)}`);
    }
  }

  // HRMS may list companies as plain rows/links without card selectors.
  const byName = page.getByText(name, { exact: false }).filter({ visible: true }).first();
  if (await byName.count().catch(() => 0)) {
    await byName.click({ timeout: 8_000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
    await log(job, `Opened company context after create via name match "${name}"`);
  }
}

/** After create/open, refuse to pretend success while the empty picker is still up. */
async function assertWorkspaceReady(page: Page, job: Job, action: string): Promise<void> {
  if (action !== 'create_company' && action !== 'open_company') return;
  if (!(await isEmptyCompanyPicker(page))) {
    await log(job, `Company workspace ready after ${action}`);
    return;
  }
  throw new Error(
    `Company workspace is still empty after ${action} (picker still shows no companies).`,
  );
}

export async function isEmptyCompanyPicker(page: Page): Promise<boolean> {
  const bodyText = (await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '')).slice(0, 30_000);
  if (hasEmptyCompanyCopy(bodyText)) return true;
  if (!looksLikeCompanyPicker(page.url(), bodyText)) return false;
  return (await visibleCompanyCards(page)).length === 0
    && !bodyMentionsPreferredCompany(bodyText);
}

function bodyMentionsPreferredCompany(bodyText: string): boolean {
  const name = process.env.SMOKE_COMPANY_NAME?.trim() || 'Smoke Test Co';
  return bodyText.toLowerCase().includes(name.toLowerCase()) && !hasEmptyCompanyCopy(bodyText);
}

type PriorCreate = {
  session_id: number;
  selected_option: string;
};

async function priorCreateCompanyInRun(job: Job): Promise<PriorCreate | null> {
  const response = await backend.get<{ data: Array<{
    id?: number;
    session_id?: number;
    status?: string;
    selected_option?: string | null;
    situation_key?: string;
  }> }>('/worker/decisions', {
    params: { run_id: job.run_id },
  });
  // Keep the latest answered picker decision per prior session. A failed
  // remembered create followed by Skip on the same session must not count.
  const latestBySession = new Map<number, {
    session_id: number;
    selected_option: string;
    id: number;
  }>();
  for (const row of response.data.data ?? []) {
    const sessionId = Number(row.session_id ?? 0);
    if (!sessionId || sessionId === Number(job.session.id)) continue;
    if (row.status !== 'answered') continue;
    const situation = String(row.situation_key ?? '');
    if (situation !== 'company_picker_empty' && situation !== 'company_picker_ambiguous') continue;
    const selected = String(row.selected_option ?? '');
    if (!selected) continue;
    const id = Number(row.id ?? 0);
    const prev = latestBySession.get(sessionId);
    if (!prev || id >= prev.id) {
      latestBySession.set(sessionId, { session_id: sessionId, selected_option: selected, id });
    }
  }
  for (const row of latestBySession.values()) {
    if (row.selected_option === 'create_company' || row.selected_option.startsWith('create_')) {
      return { session_id: row.session_id, selected_option: row.selected_option };
    }
  }
  return null;
}

type CompanyCard = {
  label: string;
  starred: boolean;
  locator: ReturnType<Page['locator']>;
};

async function visibleCompanyCards(page: Page): Promise<CompanyCard[]> {
  const cards = page.locator(COMPANY_CARD_SELECTOR);
  const result: CompanyCard[] = [];
  const count = Math.min(await cards.count().catch(() => 0), 50);
  for (let index = 0; index < count; index++) {
    const locator = cards.nth(index);
    if (!await locator.isVisible().catch(() => false)) continue;
    const label = (await locator.innerText().catch(() => '')).trim().replace(/\s+/g, ' ').slice(0, 160);
    const starred = await locator.locator(
      '[aria-label*="star" i], [title*="star" i], [class*="starred" i], [data-starred="true"]',
    ).count().then((n) => n > 0).catch(() => false);
    result.push({ label, starred, locator });
  }
  return result;
}

function pickCompany(cards: CompanyCard[], preferred?: string): CompanyCard {
  if (preferred) {
    const normalized = preferred.toLowerCase();
    const match = cards.find((card) => card.label.toLowerCase().includes(normalized));
    if (match) return match;
  }
  return cards.find((card) => card.starred) ?? cards[0];
}

async function log(job: Job, message: string, level: 'info' | 'warn' | 'error' = 'info'): Promise<void> {
  await appendLog({
    run_id: job.run_id,
    session_id: job.session.id,
    job_id: job.job_id,
    level,
    message,
  }).catch(() => {});
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
