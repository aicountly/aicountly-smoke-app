/**
 * Synthetic values for any form the smoke run meets, not just company creation.
 *
 * A smoke run walks screens it has never seen, so it will keep hitting forms
 * nobody wrote a rule for. The mapper reads whatever the field tells us — name,
 * id, placeholder, aria-label, associated label — and answers with something a
 * human tester would plausibly type.
 *
 * Two deliberate refusals:
 *   - Checksum or registry identifiers (GSTIN, CIN, IFSC, bank accounts) are left
 *     blank. An invented value is rejected anyway and reads worse in a report
 *     than the form's own "required" message.
 *   - Credentials, OTPs and search boxes are never touched.
 */

export type FormFieldDescriptor = {
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
  /** Primary subject of the form, e.g. the company or record name. */
  entityName?: string;
};

export const DEFAULT_ENTITY_NAME = 'Smoke Test';
const DEFAULT_EMAIL = 'smoke.test@example.com';

/** Indian financial year containing `now`: 1 April to 31 March. */
export function financialYearWindow(now: Date): { start: string; end: string } {
  const year = now.getFullYear();
  const startYear = now.getMonth() + 1 >= 4 ? year : year - 1;
  return { start: `${startYear}-04-01`, end: `${startYear + 1}-03-31` };
}

/** "Smoke Test Co" -> "SMOKE". Short-code fields usually cap at 8-10 chars. */
export function shortCodeFor(entityName: string): string {
  const cleaned = entityName.replace(/[^a-z0-9 ]/gi, ' ').trim();
  const first = cleaned.split(/\s+/)[0] ?? 'SMOKE';
  return (first || 'SMOKE').toUpperCase().slice(0, 8);
}

export function isoDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

// "PIN" is deliberately absent: in this product a PIN code is a postal code.
const NEVER_FILL = /search|filter|\botp\b|captcha|password|passcode|token|secret|api.?key|\bcvv\b|signature/i;

/** Identifiers with checksums or registry lookups we must not invent. */
const UNSAFE_IDENTIFIER = /gstin|\bgst\b|\bcin\b|\bllpin\b|\bdin\b|\btin\b|aadhaar|aadhar|passport|account.?(no|number)|\bifsc\b|\bupi\b|\bmicr\b|\bswift\b|\biban\b|card.?(no|number)/i;

/** Normalises separators so word-boundary rules work on snake_case names. */
function readable(field: FormFieldDescriptor): string {
  return [field.name, field.id, field.placeholder, field.ariaLabel, field.label]
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function synthesizeFieldValue(
  field: FormFieldDescriptor,
  options: SynthesisOptions = {},
): string | null {
  const now = options.now ?? new Date();
  const entity = (options.entityName ?? DEFAULT_ENTITY_NAME).trim() || DEFAULT_ENTITY_NAME;
  const fy = financialYearWindow(now);
  const blob = readable(field);
  const isDateField = field.type === 'date' || field.type === 'month' || /\bdate\b|\bdob\b/.test(blob);

  if (NEVER_FILL.test(blob)) return null;
  if (UNSAFE_IDENTIFIER.test(blob)) return null;

  // Postal codes before short codes: "PIN code" matches both.
  if (/pincode|\bpin\b|\bzip\b|postal/.test(blob)) return '560001';
  if (/short|abbrev|alias|initials|\bcode\b/.test(blob)) return shortCodeFor(entity);
  if (/print/.test(blob)) return entity;
  if (/comp|firm|entity|organi[sz]ation|business|trade|legal/.test(blob)) return entity;

  // Dates: financial-year windows first, then anything date-shaped.
  if (/(fy|financ|book|year).*(start|begin|from)|start.*date|from.?date|valid.?from|effective/.test(blob)) return fy.start;
  if (/(fy|financ|book|year).*(end|close|to)|end.*date|to.?date|valid.?(till|upto)|expiry|expire|due/.test(blob)) return fy.end;
  if (/incorporat|registrat|establish|commence|inception|joining|hire|appoint/.test(blob)) return fy.start;
  if (isDateField) {
    // A bare "From"/"To" pair is only a range once we know the field is a date.
    if (/\bfrom\b|\bsince\b/.test(blob)) return fy.start;
    if (/\bto\b|\btill\b|\bupto\b/.test(blob)) return fy.end;
    return isoDate(now);
  }
  if (field.type === 'time') return '10:00';

  if (field.type === 'email' || /e ?mail/.test(blob)) return options.email ?? DEFAULT_EMAIL;
  if (/mobile|phone|contact|telephone|whatsapp|\bfax\b/.test(blob)) return '9000000000';
  if (/\bpan\b/.test(blob)) return 'AAAAA0000A';
  if (/\btan\b/.test(blob)) return 'AAAA00000A';
  if (/website|\burl\b|domain|\blink\b/.test(blob)) return 'https://example.com';
  if (/address|adrs|street|locality|area|building|premise|\bline \d/.test(blob)) return '1 Smoke Test Street';
  if (/city|town/.test(blob)) return 'Bengaluru';
  if (/district|taluk|tehsil/.test(blob)) return 'Bengaluru Urban';
  if (/state|province|region/.test(blob)) return 'Karnataka';
  if (/country|nation/.test(blob)) return 'India';
  if (/currency/.test(blob)) return 'INR';
  if (/\bhsn\b|\bsac\b/.test(blob)) return '9983';

  // Numeric-ish business fields: keep every amount tiny and obviously synthetic.
  if (/percent|\brate\b|\bpct\b|discount|\btax\b/.test(blob)) return '0';
  if (/quantity|\bqty\b|\bunits\b|\bcount\b|\bnos\b/.test(blob)) return '1';
  if (/amount|price|value|cost|salary|wage|balance|credit|debit|limit|total/.test(blob)) return '1';
  if (/\bdays\b|\bterms\b|duration|period/.test(blob)) return '30';
  if (/\bage\b/.test(blob)) return '30';

  if (/description|remark|note|comment|narration|particular|purpose|reason/.test(blob)) {
    return 'Synthetic smoke test entry';
  }
  if (/reference|\bref\b|\bno\b|number|invoice|voucher|bill|receipt|order/.test(blob)) {
    return `SMOKE-${isoDate(now).replace(/-/g, '')}`;
  }
  if (/\bname\b|title|label|subject/.test(blob)) return entity;

  // A label we cannot read stays unanswered here. Guessing from the field's type
  // alone would rob the brain of the chance to read the label properly, so that
  // guess lives in lastResortValue and runs only after the brain declines.
  return null;
}

/**
 * The final answer for a required field nothing else could map, so an unreadable
 * label cannot block the run. Deliberately bland and recognisable in a report.
 */
export function lastResortValue(field: FormFieldDescriptor): string | null {
  if (isUnsafeToFill(field)) return null;
  if (field.type === 'number' || field.type === 'tel') return '1';
  if (field.type === 'date' || field.type === 'month') return isoDate(new Date());
  if (field.type === 'email') return DEFAULT_EMAIL;
  if (field.tag === 'textarea') return 'Synthetic smoke test entry';
  return DEFAULT_ENTITY_NAME;
}

/** True when a <select> option is a "-- Select --" style prompt rather than a value. */
export function isPlaceholderOption(value: string, text: string): boolean {
  if (value.trim() === '') return true;
  return /^(?:-{2,}|(?:select|choose|please|none|all|any)\b)/i.test(text.trim());
}

/**
 * Values the model must never be allowed to supply, whatever it returns.
 * Applied to every brain-proposed value before it reaches the page.
 */
export function isUnsafeToFill(field: FormFieldDescriptor): boolean {
  const blob = readable(field);
  return NEVER_FILL.test(blob) || UNSAFE_IDENTIFIER.test(blob);
}
