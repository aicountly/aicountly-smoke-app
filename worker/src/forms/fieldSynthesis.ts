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

/**
 * Search/filter boxes and credential-style fields used to share one regex and one
 * refusal reason, so a search box was refused with the same "credential, OTP, or
 * statutory identifier" message as a password field — a false and unconvincing
 * reason the model kept re-testing. They are split so each gets an honest reason,
 * and so search input can be allowed independently of credentials.
 */
export const SEARCH_OR_FILTER = /search|filter/i;
// "PIN" is deliberately absent: in this product a PIN code is a postal code.
export const NEVER_FILL_CREDENTIAL = /\botp\b|captcha|password|passcode|token|secret|api.?key|\bcvv\b|signature/i;

/** Identifiers with checksums or registry lookups we must not invent. */
const UNSAFE_IDENTIFIER = /gstin|\bgst\b|\bcin\b|\bllpin\b|\bdin\b|\btin\b|aadhaar|aadhar|passport|account.?(no|number)|\bifsc\b|\bupi\b|\bmicr\b|\bswift\b|\biban\b|card.?(no|number)/i;

/**
 * Short-code family already relied on by `synthesizeFieldValue`. Exported so
 * `actions.ts` can detect the same "this field wants an `[A-Z0-9]`-only code"
 * shape without duplicating (and drifting from) the pattern.
 */
export const CODE_FIELD_PATTERN = /short|abbrev|alias|initials|\bcode\b/i;

/**
 * Navigating by search or filtering a list writes nothing, so refusing it as
 * unsafe made a whole class of screens untestable by design. Default on; set
 * SMOKE_ALLOW_SEARCH_INPUT=0 (or "false") to restore the hard refusal.
 */
const allowSearchInputEnv = String(process.env.SMOKE_ALLOW_SEARCH_INPUT ?? '').trim().toLowerCase();
export const ALLOW_SEARCH_INPUT = allowSearchInputEnv !== '0' && allowSearchInputEnv !== 'false';

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

  // The heuristic synthesizer never invents search/filter text — even once
  // ALLOW_SEARCH_INPUT permits typing into the box, deciding *what* to search for
  // is a brain/model job, not a canned-value job.
  if (SEARCH_OR_FILTER.test(blob)) return null;
  if (NEVER_FILL_CREDENTIAL.test(blob)) return null;
  if (UNSAFE_IDENTIFIER.test(blob)) return null;

  // Postal codes before short codes: "PIN code" matches both.
  if (/pincode|\bpin\b|\bzip\b|postal/.test(blob)) return '560001';
  if (CODE_FIELD_PATTERN.test(blob)) return shortCodeFor(entity);
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
 * Distinguishes *why* a field would be refused, so the guard can give an honest
 * reason instead of calling a search box a "credential" because both used to
 * share one regex. Returned independently of ALLOW_SEARCH_INPUT — that flag is
 * applied by `isUnsafeToFill` when turning a classification into a permission
 * decision.
 */
export function classifyUnsafeField(field: FormFieldDescriptor): 'credential' | 'search' | 'safe' {
  const blob = readable(field);
  if (NEVER_FILL_CREDENTIAL.test(blob) || UNSAFE_IDENTIFIER.test(blob)) return 'credential';
  if (SEARCH_OR_FILTER.test(blob)) return 'search';
  return 'safe';
}

/**
 * Values the model must never be allowed to supply, whatever it returns.
 * Applied to every brain-proposed value before it reaches the page.
 * Credential/statutory-identifier fields are always unsafe; a search/filter box
 * is only unsafe when ALLOW_SEARCH_INPUT has been switched off.
 */
export function isUnsafeToFill(field: FormFieldDescriptor): boolean {
  const category = classifyUnsafeField(field);
  if (category === 'credential') return true;
  if (category === 'search') return !ALLOW_SEARCH_INPUT;
  return false;
}
