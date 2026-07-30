import type { Page } from 'playwright';
import { appendLog, backend, type Job } from '../backend.js';
import { captureScreenshot } from '../scanner/screenshotCapture.js';
import { describeVisibleControls } from '../forms/formDom.js';
import { askOrRecallDecision, forgetDecisionMemory, type DecisionOption } from './askDecision.js';
import { describeCards, findCompanyCards, pickCompany, waitForCompanyCards } from './companyCards.js';
import {
  hasEmptyCompanyCopy,
  isEmptyCompanyWorkspace,
  looksLikeCompanyPicker,
  readCompanyCount,
} from './companyPicker.js';
import { performNavAction, type NavActionResult } from './performNavAction.js';

export type ResolveAppContextOptions = {
  screenshotsDir?: string;
};

export type ResolveAppContextResult = NavActionResult & {
  detected: boolean;
};

/** A company created on a sibling app is not in the picker's list the instant we return. */
const WORKSPACE_SETTLE_MS = 25_000;
const LIST_SETTLE_MS = 15_000;

export async function resolveAppContext(
  page: Page,
  job: Job,
  options: ResolveAppContextOptions = {},
): Promise<ResolveAppContextResult> {
  const url = page.url();
  const bodyText = await readBody(page);
  if (!looksLikeCompanyPicker(url, bodyText)) {
    return { detected: false, navigated: false, rescan: false, skipped: false };
  }

  const cards = await findCompanyCards(page);
  const listed = readCompanyCount(bodyText);
  const empty = isEmptyCompanyWorkspace(bodyText);
  const companyName = preferredCompanyName();

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

  // The picker counts companies it is listing, but nothing we can match. That is our
  // markup guess failing, not an empty workspace, and answering "create" here only
  // adds a duplicate. Try the name we know, then ask for one we can click by name.
  if (listed !== null && listed > 0) {
    if (await openByName(page, job, companyName)) {
      return { detected: true, navigated: true, rescan: true, skipped: false };
    }
    await reportUnreadablePicker(page, job, listed);
    return decide(
      page,
      job,
      options,
      'company_picker_unreadable',
      `The picker lists ${listed} compan${listed === 1 ? 'y' : 'ies'}, but none of them could be identified in the page markup. `
      + 'How should the smoke run proceed?',
      // No rescan on offer: re-reading the same markup cannot make it identifiable,
      // and the picker already told us the list is rendered.
      [
        {
          id: 'open_named_company',
          label: 'Open a company by name — type its exact name in the note below',
          action: 'open_company',
          requires_note: true,
        },
        { id: 'skip_company_scoped_menus', label: 'Skip company-scoped navigation', action: 'skip_target' },
        { id: 'abort_session', label: 'Abort this session', action: 'abort_session' },
      ],
      { listed_company_count: listed, labels: [], detection: 'no_match', company_name: companyName },
    );
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
      { labels: [], empty_state_detected: empty, listed_company_count: listed, company_name: companyName },
    );
  }

  return { detected: true, navigated: false, rescan: false, skipped: false };
}

/**
 * A picker whose rows carry no name, id or test hook is a real product finding: no
 * automation can address a company on it. Record what was on screen so it does not
 * cost another run to work out why nothing matched.
 */
async function reportUnreadablePicker(page: Page, job: Job, listed: number): Promise<void> {
  const inventory = await describeVisibleControls(page).catch(() => null);
  await log(
    job,
    `Company picker lists ${listed} compan${listed === 1 ? 'y' : 'ies'} but exposes no identifiable company rows `
    + `(no [data-company-id], company test id, or company-card class, and no row text that reads as a name). `
    + `url=${page.url()}`
    + (inventory ? ` visible_controls=[${inventory.buttons.join(' | ')}]` : ''),
    'warn',
  );
}

async function openByName(page: Page, job: Job, name: string): Promise<boolean> {
  const target = page.getByText(name, { exact: false }).filter({ visible: true }).first();
  if (!await target.count().catch(() => 0)) return false;
  const clicked = await target.click({ timeout: 8_000 }).then(() => true).catch(() => false);
  if (!clicked) return false;
  await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
  await log(job, `Opened company context by name "${name}" (picker exposed no matchable company rows)`);
  return true;
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
  const pickerUrl = page.url();
  const shoot = () => (resolveOptions.screenshotsDir
    ? captureScreenshot(page, resolveOptions.screenshotsDir, `decision-${situationKey}`).catch(() => undefined)
    : Promise.resolve(undefined));
  const ask = (ignoreMemory: boolean, screenshotPath?: string) => askOrRecallDecision({
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

  const choice = await ask(false, await shoot());
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
    // The failed action may have left us on another app entirely. Ask about the
    // screen the question is about, or the operator answers for the wrong page.
    await returnToPicker(page, job, pickerUrl);
    return finishDecision(page, job, await ask(true, await shoot()), act);
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
    await log(job, `Creating company "${choice.option.company_name || preferredCompanyName()}" (source=${choice.source})`);
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
  const name = preferred || preferredCompanyName();

  // The picker was rendered before the company existed, so give the list time to
  // catch up. Failing here on the first read is what turned a create that had
  // worked into a session failure.
  const cards = await waitForCompanyCards(page, LIST_SETTLE_MS);
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
  if (await openByName(page, job, name)) return;
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
  await openByName(page, job, name);
}

/** After create/open, refuse to pretend success while the empty picker is still up. */
async function assertWorkspaceReady(page: Page, job: Job, action: string): Promise<void> {
  if (action !== 'create_company' && action !== 'open_company') return;

  const deadline = Date.now() + WORKSPACE_SETTLE_MS;
  let reloaded = false;
  for (;;) {
    if (!(await isEmptyCompanyPicker(page))) {
      await log(job, `Company workspace ready after ${action}`);
      return;
    }
    if (Date.now() >= deadline) break;
    // Half way through, assume the list we are staring at was cached before the
    // company existed rather than that the company is missing.
    if (!reloaded && Date.now() >= deadline - WORKSPACE_SETTLE_MS / 2) {
      reloaded = true;
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
    }
    await page.waitForTimeout(1_000);
  }

  const bodyText = await readBody(page);
  throw new Error(
    `Company workspace is still empty after ${action} (picker still shows no companies `
    + `after ${Math.round(WORKSPACE_SETTLE_MS / 1_000)}s). url=${page.url()} `
    + `listed_count=${readCompanyCount(bodyText) ?? 'not stated'} `
    + `cards=${describeCards(await findCompanyCards(page))} `
    + `empty_copy=${hasEmptyCompanyCopy(bodyText)}`,
  );
}

export async function isEmptyCompanyPicker(page: Page): Promise<boolean> {
  const bodyText = await readBody(page);
  // Off the picker means a workspace is open, which is the whole point of the check.
  // Empty-state copy makes a page count as a picker, so that case still lands below.
  if (!looksLikeCompanyPicker(page.url(), bodyText)) return false;
  const listed = readCompanyCount(bodyText);
  // A counter is the picker's own answer, so it settles the question either way.
  if (listed !== null) return listed === 0;
  if (hasEmptyCompanyCopy(bodyText)) return true;
  return (await findCompanyCards(page)).length === 0
    && !bodyMentionsPreferredCompany(bodyText);
}

async function readBody(page: Page): Promise<string> {
  const text = await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
  return text.slice(0, 30_000);
}

function preferredCompanyName(): string {
  return process.env.SMOKE_COMPANY_NAME?.trim() || 'Smoke Test Co';
}

function bodyMentionsPreferredCompany(bodyText: string): boolean {
  const name = preferredCompanyName();
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
