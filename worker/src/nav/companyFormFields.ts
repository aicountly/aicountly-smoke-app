/**
 * Value synthesis for a full company-creation form.
 *
 * AICOUNTLY's Manage app creates a company through a whole setup screen
 * (comp_name, print_name, short_name, fy_start, fy_end, registered office
 * address, ...), not a single-field dialog, so filling only the name leaves the
 * form failing its own validation.
 *
 * Fields we cannot satisfy safely are left blank on purpose: a checksum-bearing
 * identifier like GSTIN would be rejected anyway, and a wrong guess is harder to
 * read in a report than the form's own "required" message.
 */

export type CompanyFormField = {
  tag: 'input' | 'select' | 'textarea';
  type: string;
  name: string;
  id: string;
  placeholder: string;
  ariaLabel: string;
  label: string;
  required: boolean;
};

export type SynthesisOptions = {
  now?: Date;
  email?: string;
};

/** Indian financial year containing `now`: 1 April to 31 March. */
export function financialYearWindow(now: Date): { start: string; end: string } {
  const year = now.getFullYear();
  const startYear = now.getMonth() + 1 >= 4 ? year : year - 1;
  return { start: `${startYear}-04-01`, end: `${startYear + 1}-03-31` };
}

/** "Smoke Test Co" -> "SMOKE". Short-code fields usually cap at 8-10 chars. */
export function shortCodeFor(companyName: string): string {
  const cleaned = companyName.replace(/[^a-z0-9 ]/gi, ' ').trim();
  const first = cleaned.split(/\s+/)[0] ?? 'SMOKE';
  return (first || 'SMOKE').toUpperCase().slice(0, 8);
}

const NEVER_FILL = /search|otp|captcha|password|token|secret/i;

/** Identifiers with checksums or registry lookups we must not invent. */
const UNSAFE_IDENTIFIER = /gstin|\bgst\b|\bcin\b|\bllpin\b|\bdin\b|aadhaar|aadhar|account.?(no|number)|\bifsc\b|\bupi\b/i;

export function synthesizeCompanyFieldValue(
  field: CompanyFormField,
  companyName: string,
  options: SynthesisOptions = {},
): string | null {
  const now = options.now ?? new Date();
  const fy = financialYearWindow(now);
  // Separators become spaces so word-boundary rules work on snake_case and
  // camel-free names alike: "gst_no" must read as "gst no", not one long token.
  const blob = [field.name, field.id, field.placeholder, field.ariaLabel, field.label]
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');
  const isDate = field.type === 'date' || /date|dob|\bfrom\b|\bto\b/.test(blob);

  if (NEVER_FILL.test(blob)) return null;
  if (UNSAFE_IDENTIFIER.test(blob)) return null;

  // Postal codes first: "PIN code" also matches the short-code rule below.
  if (/\bpin\b|pincode|zip|postal/.test(blob)) return '560001';
  if (/short|abbrev|alias|initials|\bcode\b/.test(blob)) return shortCodeFor(companyName);
  if (/print/.test(blob)) return companyName;
  if (/comp|firm|entity|organi[sz]ation|business|trade|legal|\bname\b/.test(blob)) return companyName;

  if (/(fy|financ|book|year).*(start|begin|from)|start.*date|from.?date/.test(blob)) return fy.start;
  if (/(fy|financ|book|year).*(end|close|to)|end.*date|to.?date/.test(blob)) return fy.end;
  if (/incorporat|registrat|establish|commence|inception/.test(blob)) return fy.start;
  if (isDate) return fy.start;

  if (field.type === 'email' || /e.?mail/.test(blob)) return options.email ?? 'smoke.test@example.com';
  if (/mobile|phone|contact|telephone|whatsapp|\bfax\b/.test(blob)) return '9000000000';
  if (/\bpan\b/.test(blob)) return 'AAAAA0000A';
  if (/\btan\b/.test(blob)) return 'AAAA00000A';
  if (/website|\burl\b|domain/.test(blob)) return 'https://example.com';
  if (/address|adrs|street|locality|area|building|premise|\bline\s*\d/.test(blob)) return '1 Smoke Test Street';
  if (/city|town/.test(blob)) return 'Bengaluru';
  if (/district|taluk/.test(blob)) return 'Bengaluru Urban';
  if (/state|province|region/.test(blob)) return 'Karnataka';
  if (/country|nation/.test(blob)) return 'India';
  if (/currency/.test(blob)) return 'INR';

  if (field.type === 'number') return field.required ? '1' : null;
  // An unknown optional field stays blank; an unknown required one gets a
  // recognisable placeholder so the run is not blocked by a label we cannot map.
  if (field.required) return 'Smoke Test';
  return null;
}

/** True when a <select> option is a "-- Select --" style prompt rather than a value. */
export function isPlaceholderOption(value: string, text: string): boolean {
  if (value.trim() === '') return true;
  return /^(?:-{2,}|(?:select|choose|please|none|all)\b)/i.test(text.trim());
}
