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
