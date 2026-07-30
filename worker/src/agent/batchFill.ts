/**
 * Filling a whole form from one vision decision.
 *
 * A form used to cost one screenshot and one vision call per field, which is how
 * a twelve-field employee record spent thirty of an eighty-step budget copying
 * values the run had already fetched in a single `synthetic_data` call. The
 * batch writes every field the model names, then hands back one screenshot and a
 * per-field report so the next decision can see what landed and mop up the rest
 * one at a time.
 *
 * Speed is only worth having if the batch is no less careful than the loop it
 * replaces, so every field is guarded, resolved and verified on its own:
 * - each entry goes through `guardAction`, and a refusal skips that field alone;
 * - a control that vanished under a re-render is skipped, never guessed at;
 * - a dropdown is opened and its real options are read before one is clicked, so
 *   an option the model invented is reported back rather than approximated;
 * - an unexpected dialog stops the batch, so nothing is typed into a covered page.
 */

import type { Locator, Page } from 'playwright';
import type { Job } from '../backend.js';
import type { GuardDecision } from '../utils/safeActionGuard.js';
import { guardAction } from './actionGuard.js';
import type { AgentAction } from './actions.js';
import { probeDateFieldBeforeFill, type DateProbeSink } from './dateFieldProbe.js';
import { resolveTypedValue } from './fieldValue.js';
import { markInteractive, type MarkDescriptor } from './marks.js';
import { waitForSettle } from './perceive.js';

/** One field of a `fill_form` action: `value` types, `option` chooses. */
export type FillEntry = {
  mark: number;
  value?: string;
  option?: string;
};

export type FillResult = {
  mark: number;
  label: string;
  /** `chosen` is a dropdown selection; `skipped` means the batch declined to act. */
  status: 'filled' | 'chosen' | 'refused' | 'failed' | 'skipped';
  value?: string;
  reason?: string;
  adjusted_from?: string;
  /** What a dropdown actually offered, when the requested option was not among them. */
  available_options?: string[];
};

export type BatchFillOutcome = {
  status: 'executed' | 'refused' | 'failed';
  observation: string;
  guard: GuardDecision;
  results: FillResult[];
};

/** More fields than any real form, and a bound on how long one step may run. */
export const MAX_BATCH_FIELDS = 30;

/** Between fields: long enough for a dependent field to react, short enough to stay worth batching. */
const ENTRY_SETTLE = { maxMs: 700, quietMs: 150, pollMs: 60 };
const WIDGET_SETTLE = { maxMs: 1_500, quietMs: 200, pollMs: 60 };

/**
 * Candidate option elements in a dropdown a product built itself. Deliberately
 * broad, because the "appeared only after the control was clicked" filter in
 * `collectNewOptions` is what actually narrows it down.
 */
const OPTION_SELECTOR = [
  '[role="option"]', '[role="menuitem"]', '[role="menuitemradio"]', '[role="treeitem"]',
  'li', 'option', '[class*="option"]', '[class*="item"]', '[class*="choice"]',
].join(',');

const PLACEHOLDER_OPTION = /^[\s\-—–]*(?:select|choose|please\s+select|none|--?)\b|^[\s\-—–]+$/i;

export async function runBatchFill(input: {
  page: Page;
  job: Job;
  fields: FillEntry[];
  marks: MarkDescriptor[];
  screenshotsDir: string;
  ordinal: number;
  dateProbe?: DateProbeSink;
}): Promise<BatchFillOutcome> {
  const plan = planBatchFill(input.fields, input.marks);
  const results: FillResult[] = [...plan.rejected];
  const context: MarkContext = { marks: input.marks, remarked: false };
  const baselineDialogs = await countDialogs(input.page);

  for (let index = 0; index < plan.entries.length; index += 1) {
    const item = plan.entries[index]!;
    // An overlay that opened part-way through means every field after it would
    // be typed into a page the user can no longer see. Hand the rest back
    // instead: the next decision gets a screenshot of the dialog and can deal
    // with it.
    if (await dialogsGrew(input.page, baselineDialogs)) {
      for (const pending of plan.entries.slice(index)) {
        results.push({
          mark: pending.descriptor.mark,
          label: pending.descriptor.name,
          status: 'skipped',
          reason: 'a dialog opened part-way through the batch, so this field was left alone',
        });
      }
      break;
    }
    results.push(await fillOne(input, item, context));
  }

  await clearOptionTags(input.page);
  await waitForSettle(input.page);

  const succeeded = results.filter(isSet);
  const status: BatchFillOutcome['status'] = succeeded.length
    ? 'executed'
    : results.some((result) => result.status === 'refused')
      ? 'refused'
      : 'failed';
  return {
    status,
    observation: summariseBatch(results),
    // The step-level guard reads as allowed whenever anything was written; a
    // batch that wrote nothing reports the first refusal so the timeline still
    // names the rule that stopped it.
    guard: succeeded.length
      ? { allowed: true }
      : { allowed: false, reason: results.find((result) => result.status === 'refused')?.reason ?? 'nothing in the batch could be filled' },
    results,
  };
}

function isSet(result: FillResult): boolean {
  return result.status === 'filled' || result.status === 'chosen';
}

/**
 * Exported for unit tests — which entries are worth attempting, in what order,
 * and why the rest were dropped before the browser was touched.
 */
export function planBatchFill(fields: FillEntry[], marks: MarkDescriptor[]): {
  entries: Array<{ entry: FillEntry; descriptor: MarkDescriptor }>;
  rejected: FillResult[];
} {
  const byMark = new Map(marks.map((mark) => [mark.mark, mark]));
  const entries: Array<{ entry: FillEntry; descriptor: MarkDescriptor }> = [];
  const rejected: FillResult[] = [];
  const seen = new Set<number>();

  for (const entry of fields) {
    const descriptor = byMark.get(entry.mark);
    if (!descriptor) {
      rejected.push({
        mark: entry.mark,
        label: '',
        status: 'skipped',
        reason: `mark ${entry.mark} is not one of the controls on this screen`,
      });
      continue;
    }
    const base = { mark: descriptor.mark, label: descriptor.name };
    if (seen.has(entry.mark)) {
      rejected.push({ ...base, status: 'skipped', reason: 'the batch listed this control twice' });
      continue;
    }
    seen.add(entry.mark);
    if (!String(entry.option ?? entry.value ?? '').trim()) {
      rejected.push({ ...base, status: 'skipped', reason: 'no value was supplied for this field' });
      continue;
    }
    if (entries.length >= MAX_BATCH_FIELDS) {
      rejected.push({
        ...base,
        status: 'skipped',
        reason: `only ${MAX_BATCH_FIELDS} fields may be filled in one batch`,
      });
      continue;
    }
    entries.push({ entry, descriptor });
  }

  // Reading order: a field that reveals, clears or disables another has to run
  // before it, and filling top-to-bottom keeps Playwright's scroll-into-view
  // moving one way through the form instead of jumping about.
  entries.sort((left, right) => (left.descriptor.bbox.y - right.descriptor.bbox.y)
    || (left.descriptor.bbox.x - right.descriptor.bbox.x));
  return { entries, rejected };
}

type MarkContext = { marks: MarkDescriptor[]; remarked: boolean };

async function fillOne(
  input: {
    page: Page;
    job: Job;
    screenshotsDir: string;
    ordinal: number;
    dateProbe?: DateProbeSink;
  },
  item: { entry: FillEntry; descriptor: MarkDescriptor },
  context: MarkContext,
): Promise<FillResult> {
  const { entry, descriptor } = item;
  const base = { mark: descriptor.mark, label: descriptor.name };
  const isNativeSelect = descriptor.tag.toLowerCase() === 'select';
  // A dropdown sent as a value rather than an option is the model using the
  // wrong key for the right intent; a <select> can only ever be chosen from, so
  // read it that way instead of failing the field on a technicality.
  const requested = String(entry.option ?? (isNativeSelect ? entry.value ?? '' : '')).trim();
  const wantsOption = requested.length > 0;

  const type = descriptor.type.toLowerCase();
  if (!wantsOption && (type === 'checkbox' || type === 'radio')) {
    return {
      ...base,
      status: 'skipped',
      reason: 'a checkbox or radio is toggled with a click, not filled with a value',
    };
  }

  // Guarded as the equivalent single action, so the batch and the one-at-a-time
  // path can never disagree about what is safe to touch. A custom dropdown is
  // opened with a click, so it is judged as a click.
  const equivalent: AgentAction = wantsOption
    ? (isNativeSelect
      ? { type: 'select', mark: descriptor.mark, option: requested }
      : { type: 'click', mark: descriptor.mark })
    : { type: 'type', mark: descriptor.mark, text: entry.value ?? '' };
  const guard = guardAction(equivalent, descriptor, input.job);
  if (!guard.allowed) {
    return { ...base, status: 'refused', reason: guard.reason ?? 'blocked by the safety guard' };
  }

  const locator = await resolveLocator(input.page, descriptor, context);
  if (!locator) {
    return {
      ...base,
      status: 'skipped',
      reason: 'the control was no longer on the page when the batch reached it',
    };
  }

  try {
    if (wantsOption) {
      return await chooseOption(input.page, descriptor, locator, requested, isNativeSelect);
    }
    if (!await locator.isEditable({ timeout: 2_000 }).catch(() => false)) {
      return {
        ...base,
        status: 'skipped',
        reason: 'the field was read-only or disabled by the time the batch reached it',
      };
    }
    if (input.dateProbe) {
      await probeDateFieldBeforeFill({
        page: input.page,
        descriptor,
        sink: input.dateProbe,
        screenshotsDir: input.screenshotsDir,
        ordinal: input.ordinal,
      });
    }
    const { typedValue, adjustedFrom } = resolveTypedValue(entry.value ?? '', descriptor);
    await locator.fill(typedValue, { timeout: 10_000 });
    await waitForSettle(input.page, ENTRY_SETTLE);
    return { ...base, status: 'filled', value: typedValue, adjusted_from: adjustedFrom };
  } catch (error) {
    return { ...base, status: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Never picks an option it has not read. A native select is asked for its own
 * option list; a custom widget is opened and the entries that appeared with it
 * are collected. Either way, an option the model invented comes back as a
 * `skipped` carrying the real choices rather than a near-enough guess.
 */
async function chooseOption(
  page: Page,
  descriptor: MarkDescriptor,
  locator: Locator,
  requested: string,
  isNativeSelect: boolean,
): Promise<FillResult> {
  const base = { mark: descriptor.mark, label: descriptor.name };

  if (isNativeSelect) {
    const options = await locator.evaluate((element) => Array.from((element as HTMLSelectElement).options)
      .filter((option) => !option.disabled)
      .map((option) => (option.label || option.text || option.value || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)).catch(() => [] as string[]);
    const index = matchOption(options, requested);
    if (index === null) {
      return {
        ...base,
        status: 'skipped',
        reason: `"${requested}" is not one of the options this dropdown offers`,
        available_options: offerable(options),
      };
    }
    const chosen = options[index]!;
    await locator.selectOption({ label: chosen }).catch(() => locator.selectOption(chosen));
    await waitForSettle(page, ENTRY_SETTLE);
    return { ...base, status: 'chosen', value: chosen };
  }

  await tagVisibleOptions(page);
  await locator.click({ timeout: 10_000 });
  await waitForSettle(page, WIDGET_SETTLE);
  const opened = await collectNewOptions(page, descriptor.mark);
  if (opened.length === 0) {
    await page.keyboard.press('Escape').catch(() => {});
    return {
      ...base,
      status: 'failed',
      reason: 'clicking this control opened no option list, so it may not be a dropdown',
    };
  }

  const index = matchOption(opened.map((option) => option.text), requested);
  if (index === null) {
    await page.keyboard.press('Escape').catch(() => {});
    await waitForSettle(page, ENTRY_SETTLE);
    return {
      ...base,
      status: 'skipped',
      reason: `"${requested}" is not one of the options this dropdown offers`,
      available_options: offerable(opened.map((option) => option.text)),
    };
  }

  const picked = opened[index]!;
  await page.locator(`[data-smoke-opt="${picked.index}"]`).click({ timeout: 10_000 });
  await waitForSettle(page, WIDGET_SETTLE);
  if (!await optionWasTaken(page, descriptor.mark, picked.text)) {
    await page.keyboard.press('Escape').catch(() => {});
    return {
      ...base,
      status: 'failed',
      reason: `clicking "${picked.text}" left the control unset`,
      available_options: offerable(opened.map((option) => option.text)),
    };
  }
  return { ...base, status: 'chosen', value: picked.text };
}

/**
 * Exported for unit tests — the index of the option that answers `requested`, or
 * null. Tiers are tried across the whole list before the next tier is
 * considered, so an exact match always beats a substring one elsewhere in the
 * list. Placeholders are never matchable: "— Select —" is what the control says
 * when nothing is chosen, not a choice.
 */
export function matchOption(available: string[], requested: string): number | null {
  const want = normalize(requested);
  if (!want) return null;
  const candidates = available.map((text, index) => ({ index, text: normalize(text), raw: text }))
    .filter((option) => option.text && !PLACEHOLDER_OPTION.test(option.raw.trim()));

  const tiers: Array<(text: string) => boolean> = [
    (text) => text === want,
    (text) => text.startsWith(want) || want.startsWith(text),
    (text) => want.length >= 3 && text.includes(want),
    (text) => text.length >= 3 && want.includes(text),
  ];
  for (const matches of tiers) {
    const hit = candidates.find((option) => matches(option.text));
    if (hit) return hit.index;
  }
  return null;
}

function normalize(value: string): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Real choices, trimmed to something a prompt can carry. */
function offerable(options: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const option of options) {
    const text = option.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!text || PLACEHOLDER_OPTION.test(text) || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= 20) break;
  }
  return out;
}

/**
 * Exported for unit tests — the per-field report the next decision reads as
 * `prior_feedback`. Fields that were not set come first: they are the only part
 * the model has to act on, and the tail is what gets clipped when a wide form
 * makes the summary long.
 */
export function summariseBatch(results: FillResult[], limit = 1_400): string {
  const set = results.filter(isSet);
  const unset = results.filter((result) => !isSet(result));
  const parts = [`Batch fill: set ${set.length} of ${results.length} fields.`];
  if (unset.length) {
    parts.push(`Not set: ${unset.map(describeUnset).join('; ')}.`);
    parts.push('Fill any field that is still empty one at a time, then submit the form.');
  }
  if (set.length) {
    parts.push(`Set: ${set.map((result) => `"${result.label}"="${result.value}"`).join(', ')}.`);
  }
  const summary = parts.join(' ');
  return summary.length > limit ? `${summary.slice(0, limit - 1)}…` : summary;
}

function describeUnset(result: FillResult): string {
  const options = result.available_options?.length
    ? `; it offers ${result.available_options.join(', ')}`
    : '';
  return `"${result.label || `mark ${result.mark}`}" (${result.status}: ${result.reason ?? 'no reason recorded'}${options})`;
}

/**
 * A control recreated by a re-render loses the attribute the mark was written
 * to. Re-marking once per batch usually restores the same number, because mark
 * ordinals are keyed off `data-smoke-key`; where the node is genuinely new, the
 * accessible name is the last resort before the field is skipped.
 */
async function resolveLocator(
  page: Page,
  descriptor: MarkDescriptor,
  context: MarkContext,
): Promise<Locator | null> {
  const direct = page.locator(`[data-smoke-mark="${descriptor.mark}"]`);
  if (await direct.count()) return direct.first();

  if (!context.remarked) {
    context.remarked = true;
    context.marks = await markInteractive(page).catch(() => context.marks);
  }
  const remarked = page.locator(`[data-smoke-mark="${descriptor.mark}"]`);
  if (await remarked.count()) return remarked.first();

  const byName = context.marks.find((mark) => mark.tag === descriptor.tag
    && mark.name === descriptor.name
    && !mark.disabled);
  if (!byName) return null;
  const fallback = page.locator(`[data-smoke-mark="${byName.mark}"]`);
  return await fallback.count() ? fallback.first() : null;
}

async function countDialogs(page: Page): Promise<number> {
  return page.evaluate<number>(
    'document.querySelectorAll(\'dialog[open],[role="dialog"],[aria-modal="true"]\').length',
  ).catch(() => 0);
}

/** Re-checked once after a settle, so a dropdown panel mid-animation is not read as an overlay. */
async function dialogsGrew(page: Page, baseline: number): Promise<boolean> {
  if (await countDialogs(page) <= baseline) return false;
  await waitForSettle(page, ENTRY_SETTLE);
  return await countDialogs(page) > baseline;
}

/** Marks what is on screen *before* a dropdown opens, so its entries can be told apart afterwards. */
async function tagVisibleOptions(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    document.querySelectorAll('[data-smoke-preopt]').forEach((el) => el.removeAttribute('data-smoke-preopt'));
    for (const el of document.querySelectorAll(${JSON.stringify(OPTION_SELECTOR)})) {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0
        || rect.width <= 0 || rect.height <= 0) continue;
      el.setAttribute('data-smoke-preopt', '1');
    }
  })()`).catch(() => {});
}

/** Everything that became visible when the control was clicked: the option list, and only it. */
async function collectNewOptions(
  page: Page,
  triggerMark: number,
): Promise<Array<{ index: number; text: string }>> {
  return page.evaluate<Array<{ index: number; text: string }>>(`(() => {
    document.querySelectorAll('[data-smoke-opt]').forEach((el) => el.removeAttribute('data-smoke-opt'));
    const trigger = document.querySelector('[data-smoke-mark="${triggerMark}"]');
    const out = [];
    const seen = new Set();
    for (const el of document.querySelectorAll(${JSON.stringify(OPTION_SELECTOR)})) {
      if (el.hasAttribute('data-smoke-preopt')) continue;
      if (trigger && (trigger === el || trigger.contains(el) || el.contains(trigger))) continue;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0
        || rect.width <= 0 || rect.height <= 0) continue;
      // A candidate holding another candidate is the list, not one of its entries.
      if (el.querySelector(${JSON.stringify(OPTION_SELECTOR)})) continue;
      const text = String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
      if (!text || text.length > 80 || seen.has(text)) continue;
      seen.add(text);
      el.setAttribute('data-smoke-opt', String(out.length));
      out.push({ index: out.length, text });
      if (out.length >= 60) break;
    }
    return out;
  })()`).catch(() => []);
}

/**
 * A widget that closed its list, or now shows the option on its trigger, took
 * the click. Anything else is reported as unset rather than assumed: a false
 * "chosen" would have the run submit a form it never finished filling.
 */
async function optionWasTaken(page: Page, triggerMark: number, text: string): Promise<boolean> {
  const state = await page.evaluate<{ trigger: string; open: number }>(`(() => {
    const trigger = document.querySelector('[data-smoke-mark="${triggerMark}"]');
    let open = 0;
    for (const el of document.querySelectorAll('[data-smoke-opt]')) {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0
        || rect.width <= 0 || rect.height <= 0) continue;
      open += 1;
    }
    return {
      trigger: trigger ? String(trigger.value || trigger.innerText || '').replace(/\\s+/g, ' ').trim() : '',
      open,
    };
  })()`).catch(() => ({ trigger: '', open: 0 }));
  return state.open === 0 || normalize(state.trigger).includes(normalize(text));
}

async function clearOptionTags(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    document.querySelectorAll('[data-smoke-preopt]').forEach((el) => el.removeAttribute('data-smoke-preopt'));
    document.querySelectorAll('[data-smoke-opt]').forEach((el) => el.removeAttribute('data-smoke-opt'));
  })()`).catch(() => {});
}
