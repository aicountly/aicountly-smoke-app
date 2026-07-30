/**
 * Finding the companies on a picker screen.
 *
 * The tenant apps are not ours to instrument, so a selector list is a guess: HRMS
 * renders its picker as plain rows and emits none of the hooks below. A picker that
 * counts its own companies while we match nothing is a detection failure, never an
 * empty workspace, so this module always offers a text-shaped fallback and reports
 * which route found the cards.
 */

import type { Locator, Page } from 'playwright';
import {
  isCompanyRowText,
  isPickerScreen,
} from './companyPicker.js';

export type CompanyCard = {
  label: string;
  starred: boolean;
  locator: Locator;
  source: 'selector' | 'row_fallback';
};

export const COMPANY_CARD_SELECTOR = [
  '[data-company-id]',
  '[data-testid*="company" i]',
  '[class*="company-card" i]',
  '[class*="organisation-card" i]',
  '[class*="organization-card" i]',
].join(', ');

/** Row shapes a list of companies is built from when it carries no test hooks. */
const COMPANY_ROW_SELECTOR = [
  'a[href]',
  'li',
  'tr',
  '[role="row"]',
  '[role="listitem"]',
  '[role="button"]',
  '[tabindex="0"]',
].join(', ');

const STAR_SELECTOR = '[aria-label*="star" i], [title*="star" i], [class*="starred" i], [data-starred="true"]';

const MAX_SCANNED = 200;
const MAX_CARDS = 50;

export async function findCompanyCards(page: Page): Promise<CompanyCard[]> {
  const tagged = await collectCards(page, COMPANY_CARD_SELECTOR, 'selector', () => true);
  if (tagged.length > 0) return tagged;
  const rows = await collectCards(page, COMPANY_ROW_SELECTOR, 'row_fallback', isCompanyRowText);
  return innermost(rows);
}

/** Polls for cards, for the window where a just-created company is not listed yet. */
export async function waitForCompanyCards(page: Page, timeoutMs: number): Promise<CompanyCard[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const cards = await findCompanyCards(page);
    if (cards.length > 0) return cards;
    if (Date.now() >= deadline) return [];
    await page.waitForTimeout(500);
  }
}

async function collectCards(
  page: Page,
  selector: string,
  source: CompanyCard['source'],
  accept: (label: string) => boolean,
): Promise<CompanyCard[]> {
  const all = await page.locator(selector).all().catch(() => [] as Locator[]);
  const scanned = all.slice(0, MAX_SCANNED);
  const described = await Promise.all(scanned.map(async (locator) => {
    if (!await locator.isVisible().catch(() => false)) return null;
    const label = (await locator.innerText().catch(() => '')).trim().replace(/\s+/g, ' ').slice(0, 160);
    if (!accept(label)) return null;
    const starred = await locator.locator(STAR_SELECTOR).count()
      .then((count) => count > 0)
      .catch(() => false);
    return { label, starred, locator, source } satisfies CompanyCard;
  }));
  return described.filter((card): card is CompanyCard => card !== null).slice(0, MAX_CARDS);
}

/**
 * Keeps the smallest element per company and drops its wrappers, so the list
 * container itself is never mistaken for a single company.
 */
function innermost(cards: CompanyCard[]): CompanyCard[] {
  const byLength = [...cards].sort((left, right) => left.label.length - right.label.length);
  const kept: CompanyCard[] = [];
  for (const card of byLength) {
    if (kept.some((seen) => seen.label !== card.label && card.label.includes(seen.label))) continue;
    if (kept.some((seen) => seen.label === card.label)) continue;
    kept.push(card);
  }
  return kept;
}

export function pickCompany(cards: CompanyCard[], preferred?: string): CompanyCard {
  if (preferred) {
    const normalized = preferred.toLowerCase();
    const match = cards.find((card) => card.label.toLowerCase().includes(normalized));
    if (match) return match;
  }
  return cards.find((card) => card.starred) ?? cards[0];
}

export function describeCards(cards: CompanyCard[]): string {
  if (cards.length === 0) return 'none';
  return `${cards.length} via ${cards[0].source} [${cards.map((card) => card.label).join(' | ')}]`;
}

/**
 * Whether we are still standing on the company picker.
 *
 * A company-scoped route can carry /company in its path, so the URL alone is not
 * enough: require the screen to be listing or counting companies as well. See
 * `isPickerScreen` for why a route that does not look like the picker needs more
 * than a text-shaped row match.
 */
export async function isOnCompanyPicker(page: Page): Promise<boolean> {
  const bodyText = await readBodyText(page);
  return isPickerScreen({
    url: page.url(),
    bodyText,
    findCards: () => findCompanyCards(page),
  });
}

/**
 * Waits for the app to actually leave the picker, then confirms it stays gone.
 * A single-page app can accept a click, change nothing, and route straight back.
 */
export async function waitUntilOffPicker(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!await isOnCompanyPicker(page)) {
      // Guard against a bounce: no company selected means the app sends us back.
      await page.waitForTimeout(800);
      return !await isOnCompanyPicker(page);
    }
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(400);
  }
}

/** Controls that open a company row, deliberately excluding its star toggle. */
const OPEN_CONTROL_SELECTOR = [
  'a[href]',
  'button:not([aria-label*="star" i]):not([title*="star" i]):not([class*="star" i])',
  '[role="button"]:not([aria-label*="star" i]):not([class*="star" i])',
].join(', ');

export type OpenCompanyResult = {
  opened: boolean;
  strategy?: string;
  attempts: string[];
};

/**
 * Opens a company and proves it happened.
 *
 * A picker row is often a focusable div whose handler sits on an inner link, so a
 * centre click on the row can land on dead space, report success, and leave the
 * run walking the picker's own chrome for the rest of the session. Every route is
 * therefore verified, and the next one is tried until the app really moves on.
 */
export async function openCompanyCard(
  page: Page,
  card: CompanyCard,
  verifyMs = 8_000,
): Promise<OpenCompanyResult> {
  const row = card.locator;
  const strategies: Array<[string, () => Promise<void>]> = [
    ['inner link', async () => {
      await row.locator('a[href]').first().click({ timeout: 5_000 });
    }],
    // Aim at the name rather than the row's centre: the star toggle and overflow
    // menu live at the right edge, and the centre is often padding.
    ['company name', async () => {
      await row.click({ timeout: 5_000, position: { x: 90, y: 24 } });
    }],
    ['row', async () => {
      await row.click({ timeout: 5_000 });
    }],
    // These pickers tell you so themselves: "Use up/down to navigate, Enter to open".
    ['focus and Enter', async () => {
      await row.focus({ timeout: 3_000 });
      await page.keyboard.press('Enter');
    }],
    ['open control', async () => {
      await row.locator(OPEN_CONTROL_SELECTOR).last().click({ timeout: 5_000 });
    }],
  ];

  const attempts: string[] = [];
  for (const [strategy, attempt] of strategies) {
    try {
      await attempt();
    } catch (error) {
      attempts.push(`${strategy}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
      continue;
    }
    await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
    if (await waitUntilOffPicker(page, verifyMs)) return { opened: true, strategy, attempts };
    attempts.push(`${strategy}: accepted the click but the picker is still showing`);
  }
  return { opened: false, attempts };
}

async function readBodyText(page: Page): Promise<string> {
  const text = await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
  return text.slice(0, 30_000);
}
