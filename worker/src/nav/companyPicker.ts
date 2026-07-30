/**
 * Shared company-picker heuristics used by create/open validation.
 * Kept free of Playwright so the empty-copy rules can be unit-tested.
 */

export function hasEmptyCompanyCopy(bodyText: string): boolean {
  const text = bodyText.slice(0, 30_000);
  return /\bno\s+compan(?:y|ies)\s+(yet|found|available)\b/i.test(text)
    || /\b(create|add)\s+(your\s+)?first\s+compan/i.test(text)
    || /\bno\s+compan(?:y|ies)\s+yet\b/i.test(text);
}

export function looksLikeCompanyPicker(url: string, bodyText: string): boolean {
  const text = bodyText.slice(0, 30_000);
  return /#\/company\/all|\/compan(?:y|ies)(?:\/|$)/i.test(url)
    || /\b(select|choose|switch)\s+(a\s+)?(company|organisation|organization)\b/i.test(text)
    || hasEmptyCompanyCopy(text);
}

export function bodyMentionsCompany(bodyText: string, companyName: string): boolean {
  const name = companyName.trim().toLowerCase();
  if (!name) return false;
  return bodyText.slice(0, 30_000).toLowerCase().includes(name);
}

/**
 * Counters the picker prints about itself ("All Companies (2)", "TOTAL COMPANIES 2").
 * These are the only statement of how many companies exist that does not depend on
 * guessing the tenant's markup, so they outrank both card selectors and empty copy.
 */
const COMPANY_COUNTERS: RegExp[] = [
  /\ball\s+compan(?:y|ies)\s*\(\s*(\d{1,4})\s*\)/i,
  /\btotal\s+compan(?:y|ies)\s*[:\s]*?(\d{1,4})\b/i,
  /\bactive\s+compan(?:y|ies)\s*[:\s]*?(\d{1,4})\b/i,
  /\bshowing\s+\d+\s+(?:to|-|–)\s+\d+\s+of\s+(\d{1,4})\b/i,
];

/** How many companies the picker says it is listing, or null when it never says. */
export function readCompanyCount(bodyText: string): number | null {
  const text = bodyText.slice(0, 30_000);
  let found: number | null = null;
  for (const pattern of COMPANY_COUNTERS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const value = Number(match[1]);
    if (!Number.isFinite(value)) continue;
    // Any counter reporting companies outweighs one reporting none: a zeroed
    // "Your starred" tile must never cancel out "All Companies (2)".
    found = found === null ? value : Math.max(found, value);
  }
  return found;
}

/**
 * Whether the workspace really has no company. A printed counter is believed over
 * empty-state copy, because placeholder panels ("Companies you open will appear
 * here") sit on a populated picker too.
 */
export function isEmptyCompanyWorkspace(bodyText: string): boolean {
  const listed = readCompanyCount(bodyText);
  if (listed !== null) return listed === 0;
  return hasEmptyCompanyCopy(bodyText);
}

/** A duplicate-name rejection means the company is already there — the goal, not a failure. */
export function isDuplicateCompanyError(errors: string[]): boolean {
  return errors.some((error) => /\balready\b|\bduplicate\b|\bexists\b|\btaken\b/i.test(error)
    && /compan|organi[sz]ation|\bname\b/i.test(error));
}

/**
 * Chrome that a row-shaped element can be made of on a picker page: nav entries,
 * stat tiles, placeholder panels, keyboard hints. Anything matching is not a company.
 */
const PICKER_CHROME = new RegExp([
  '^(?:',
  'dashboard|invitations|companies|branches|financial\\s+years?|key\\s+persons?',
  '|print\\s+assets|product\\s+icons|business\\s+id|learn\\s+more',
  '|(?:help|guide)\\s*(?:&|and)\\s*support|chat\\s+with\\s+ai\\s+buddy|need\\s+help\\??',
  '|add|add\\s+company|create\\s+(?:new\\s+)?company|filters?|search\\b.*|sort\\s+by\\b.*',
  '|showing\\b.*|all\\s+companies\\b.*|default\\s+company|recently\\s+opened',
  '|total\\s+companies\\b.*|active\\s+companies\\b.*|your\\s+starred\\b.*|last\\s+opened\\b.*',
  '|star\\s+a\\s+company\\b.*|companies\\s+you\\s+open\\b.*|nothing\\s+yet|no\\s+.*',
  '|welcome\\s+back\\b.*|select\\s+a\\s+company\\b.*|tip:.*|chat',
  ')$',
].join(''), 'i');

/**
 * Whether a row's own text could name a company. Used only for the fallback that
 * runs when the picker exposes no test hooks on its rows at all.
 */
export function isCompanyRowText(text: string): boolean {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length < 2 || trimmed.length > 200) return false;
  // Initials badges ("TC") and bare counts carry no name.
  if (!/[a-z]{4,}/i.test(trimmed)) return false;
  if (PICKER_CHROME.test(trimmed)) return false;
  return !hasEmptyCompanyCopy(trimmed);
}
