import type { Page } from 'playwright';
import { appendLog, type Job } from '../backend.js';
import { captureScreenshot } from '../scanner/screenshotCapture.js';
import { askOrRecallDecision, type DecisionOption } from './askDecision.js';
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
  const looksLikePicker = /#\/company\/all|\/compan(?:y|ies)(?:\/|$)/i.test(url)
    || /\b(select|choose|switch)\s+(a\s+)?(company|organisation|organization)\b/i.test(bodyText)
    || /\bno\s+(companies|organisations|organizations)\s+(yet|found|available)\b/i.test(bodyText);
  if (!looksLikePicker) {
    return { detected: false, navigated: false, rescan: false, skipped: false };
  }

  const cards = await visibleCompanyCards(page);
  const empty = /\bno\s+(companies|organisations|organizations)\s+(yet|found|available)\b/i.test(bodyText)
    || /\b(create|add)\s+(your\s+)?first\s+(company|organisation|organization)\b/i.test(bodyText);

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
    const companyName = process.env.SMOKE_COMPANY_NAME?.trim() || 'Smoke Test Co';
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
      { labels: [], empty_state_detected: empty },
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
    return { detected: true, ...await act(choice) };
  } catch (error) {
    // A remembered choice that no longer works would otherwise replay and fail
    // identically on every retry, burning the run without ever asking anyone.
    if (choice.source !== 'memory') throw error;
    await log(
      job,
      `Remembered choice "${choice.option.label}" failed: ${errorMessage(error)} — asking again.`,
      'warn',
    );
    return { detected: true, ...await act(await ask(true)) };
  }
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

async function log(job: Job, message: string, level: 'info' | 'warn' = 'info'): Promise<void> {
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
