/**
 * Judges a date control the way a user in India would meet it: click it and see
 * whether a picker appears, then type 31/12/2024 and see whether it sticks.
 *
 * A native <input type="date"> is deliberately treated differently. Its calendar
 * is drawn by the browser, so it never enters the DOM and never lands in a
 * screenshot — "no picker appeared" would be unobservable rather than false. Its
 * display format is the browser locale's, which is why the context is pinned to
 * en-IN in runSession. So native controls raise no per-field finding; they only
 * feed one session-level note about that locale dependence.
 */

import type { Page } from 'playwright';
import type { UxIssue } from '../reviewer/uxReviewEngine.js';
import type { MarkDescriptor } from './marks.js';
import { captureViewportJpeg, waitForSettle } from './perceive.js';

export type DateProbe = {
  label: string;
  url: string;
  kind: 'native' | 'custom';
  input_type: string;
  placeholder: string;
  locale: string;
  /** null on native controls: the browser's calendar is not observable from the page. */
  picker_opened: boolean | null;
  /** null when the dd/mm/yyyy attempt was not made (native controls). */
  accepted_ddmmyyyy: boolean | null;
  read_back: string;
  validation_message: string;
  screenshot?: string;
};

/**
 * Lets the agent loop decide which date fields are still worth probing and
 * collect the results, while the probe itself runs next to the fill it precedes.
 */
export type DateProbeSink = {
  shouldProbe: (key: string) => boolean;
  record: (probe: DateProbe) => void;
};

export const DATE_PROBE_CAP = 6;
export const DD_MM_YYYY_SAMPLE = '31/12/2024';
const FINDING_CATEGORY = 'date_input';
const NATIVE_TYPES = new Set(['date', 'month', 'datetime-local']);
const DATE_LABEL = /date|dob|joining|dd.?mm|mm.?dd/i;
const PICKER_SELECTOR = [
  '[class*="picker"]', '[class*="calendar"]', '[class*="datepicker"]',
  '[role="dialog"]', '[role="grid"]', 'table[class*="cal"]',
].join(',');

export function isDateishMark(mark: MarkDescriptor): boolean {
  if (mark.disabled) return false;
  if (mark.tag.toLowerCase() !== 'input') return false;
  const type = mark.type.toLowerCase();
  if (NATIVE_TYPES.has(type)) return true;
  if (type && type !== 'text' && type !== 'search') return false;
  return DATE_LABEL.test(mark.name);
}

/** One probe per field per session; the label is what a report reader recognises. */
export function dateFieldKey(url: string, label: string): string {
  return `${url}\u0000${label.trim().toLowerCase()}`;
}

export function dateFieldLabel(mark: MarkDescriptor): string {
  return mark.name || `mark ${mark.mark}`;
}

export async function probeDateControl(input: {
  page: Page;
  mark: MarkDescriptor;
}): Promise<DateProbe | null> {
  const { page, mark } = input;
  const locator = page.locator(`[data-smoke-mark="${mark.mark}"]`);
  const details = await locator.evaluate((el) => {
    const field = el as HTMLInputElement;
    return {
      type: (field.getAttribute('type') || '').toLowerCase(),
      placeholder: field.getAttribute('placeholder') || '',
      readOnly: Boolean(field.readOnly),
      locale: navigator.language || '',
    };
  }).catch(() => null);
  if (!details) return null;

  const kind = NATIVE_TYPES.has(details.type) ? 'native' : 'custom';
  const probe: DateProbe = {
    label: dateFieldLabel(mark),
    url: page.url(),
    kind,
    input_type: details.type || 'text',
    placeholder: details.placeholder,
    locale: details.locale,
    picker_opened: null,
    accepted_ddmmyyyy: null,
    read_back: '',
    validation_message: '',
  };
  if (kind === 'native') return probe;

  const before = await countVisiblePickers(page);
  await locator.click({ timeout: 5_000 }).catch(() => {});
  await waitForSettle(page, { maxMs: 1_500, quietMs: 200 });
  const after = await countVisiblePickers(page);
  probe.picker_opened = after > before;

  if (!details.readOnly) {
    await locator.fill(DD_MM_YYYY_SAMPLE, { timeout: 5_000 }).catch(() => {});
    await waitForSettle(page, { maxMs: 1_500, quietMs: 200 });
    const readout = await locator.evaluate((el) => {
      const field = el as HTMLInputElement;
      const container = field.closest('.form-group,.form-field,.field,.mb-3,div') ?? field.parentElement;
      const notice = container?.querySelector('.invalid-feedback,.error,[class*="error"],[class*="invalid"],[role="alert"]');
      return {
        value: field.value || '',
        message: (field.validationMessage || (notice as HTMLElement | null)?.innerText || '').trim().slice(0, 200),
      };
    }).catch(() => ({ value: '', message: '' }));
    probe.read_back = readout.value;
    probe.validation_message = readout.message;
    probe.accepted_ddmmyyyy = keepsIndianOrder(readout.value);
  }
  return probe;
}

/**
 * Runs before the real fill so the field is still untouched, and swallows every
 * failure: a probe exists to describe the control, never to fail the step.
 * Shared by the single-field executor and the batch filler, so a form filled ten
 * fields at a time still raises the same date findings as one filled field by
 * field.
 */
export async function probeDateFieldBeforeFill(input: {
  page: Page;
  descriptor: MarkDescriptor;
  sink: DateProbeSink;
  screenshotsDir: string;
  ordinal: number;
}): Promise<void> {
  try {
    if (!isDateishMark(input.descriptor)) return;
    const key = dateFieldKey(input.page.url(), dateFieldLabel(input.descriptor));
    if (!input.sink.shouldProbe(key)) return;
    const probe = await probeDateControl({ page: input.page, mark: input.descriptor });
    if (!probe) return;
    // A dedicated file: step screenshots are thinned off disk as the run grows,
    // and a finding must keep its evidence.
    const shot = await captureViewportJpeg(
      input.page,
      input.screenshotsDir,
      `date-probe-${String(input.ordinal).padStart(3, '0')}`,
    ).catch(() => undefined);
    probe.screenshot = shot?.path;
    input.sink.record(probe);
  } catch {
    // Probing is best-effort.
  }
}

/**
 * The control may legitimately reformat 31/12/2024 to 31-12-2024 or 2024-12-31.
 * Only losing the value, or flipping to a month-first reading, counts against it.
 */
export function keepsIndianOrder(readBack: string): boolean {
  const numbers = (readBack.match(/\d+/g) ?? []).map(Number);
  if (numbers.length < 3) return false;
  const [a, b, c] = numbers;
  if (a === 31 && b === 12 && c === 2024) return true;
  if (a === 2024 && b === 12 && c === 31) return true;
  return false;
}

async function countVisiblePickers(page: Page): Promise<number> {
  return page.evaluate((selector) => {
    let count = 0;
    for (const node of Array.from(document.querySelectorAll(selector))) {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
      if (rect.width <= 0 || rect.height <= 0) continue;
      count += 1;
    }
    return count;
  }, PICKER_SELECTOR).catch(() => 0);
}

/** Per-field findings. Empty for native controls and for controls that behaved. */
export function buildDateFindings(probe: DateProbe): UxIssue[] {
  if (probe.kind !== 'custom') return [];
  const issues: UxIssue[] = [];
  const evidence = {
    url: probe.url,
    field_label: probe.label,
    input_type: probe.input_type,
    placeholder: probe.placeholder,
    browser_locale: probe.locale,
    ...(probe.screenshot ? { screenshot_paths: [probe.screenshot] } : {}),
  };

  if (probe.picker_opened === false) {
    issues.push({
      category: FINDING_CATEGORY,
      severity: 'medium',
      title: `Date field "${probe.label}" does not open a date picker`,
      description: `Clicking the "${probe.label}" field on ${probe.url} opened no calendar or picker, so the date can only be typed by hand.`,
      recommendation: 'Attach the product\'s standard date picker to this field so a date can be chosen instead of typed.',
      human_summary: '',
      developer_prompt: '',
      evidence,
    });
  }
  if (probe.accepted_ddmmyyyy === false) {
    issues.push({
      category: FINDING_CATEGORY,
      severity: 'medium',
      title: `Date field "${probe.label}" does not accept dd/mm/yyyy`,
      description: `Typing ${DD_MM_YYYY_SAMPLE} into "${probe.label}" left the field as "${probe.read_back || 'empty'}"${probe.validation_message ? ` with the message "${probe.validation_message}"` : ''}. Indian users write dates day-first.`,
      recommendation: 'Accept and display dd/mm/yyyy in this field, and say so in a placeholder or hint.',
      human_summary: '',
      developer_prompt: '',
      evidence: {
        ...evidence,
        typed_value: DD_MM_YYYY_SAMPLE,
        read_back: probe.read_back,
        validation_message: probe.validation_message,
      },
    });
  }
  return issues;
}

/**
 * One note per session, not per field: a native date input renders and parses in
 * whatever locale the visitor's browser reports, so dd/mm/yyyy is not guaranteed
 * for an Indian user even though our own context asks for it.
 */
export function buildNativeLocaleFinding(probes: DateProbe[]): UxIssue | null {
  const native = probes.filter((probe) => probe.kind === 'native');
  if (native.length === 0) return null;
  const fields = native.map((probe) => probe.label);
  return {
    category: FINDING_CATEGORY,
    severity: 'suggestion',
    title: 'Native date inputs inherit the end user\'s locale',
    description: `${fields.join(', ')} use the browser's built-in date control, so the displayed order (dd/mm/yyyy or mm/dd/yyyy) follows each visitor's browser locale rather than the product. This run pinned the browser to en-IN.`,
    recommendation: 'Render and parse dd/mm/yyyy in the product itself rather than relying on the visitor\'s browser locale.',
    human_summary: '',
    developer_prompt: '',
    evidence: {
      url: native[0].url,
      native_date_fields: fields,
      browser_locale: native[0].locale,
      affected_urls: [...new Set(native.map((probe) => probe.url))],
    },
  };
}
