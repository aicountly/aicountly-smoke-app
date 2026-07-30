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
import { isCompanyRowText } from './companyPicker.js';

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
