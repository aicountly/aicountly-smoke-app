/**
 * DOM-level primitives shared by every form the smoke run touches.
 *
 * Kept separate from the decision logic so the company-creation path and the
 * generic engine read the page the same way — one definition of "what is a
 * field", "what is a dialog", and "what did the form complain about".
 */

import type { Locator, Page } from 'playwright';
import { isPlaceholderOption, type FormFieldDescriptor } from './fieldSynthesis.js';

export const DIALOG_SELECTOR = '[role="dialog"], dialog, [class*="modal" i], [class*="drawer" i], [class*="dialog" i]';

export type FormScope = Page | Locator;

export type DescribedField = FormFieldDescriptor & { value: string };

/** Field types we never write to, whatever their label says. */
const UNWRITABLE_TYPES = ['hidden', 'submit', 'button', 'reset', 'file', 'checkbox', 'radio', 'image', 'range', 'color'];

export function isWritableType(type: string): boolean {
  return !UNWRITABLE_TYPES.includes(type);
}

/** Prefer a visible dialog so controls behind a modal are never candidates. */
export async function dialogOrPage(page: Page): Promise<FormScope> {
  const dialog = page.locator(DIALOG_SELECTOR).filter({ visible: true }).first();
  return await dialog.count().catch(() => 0) ? dialog : page;
}

/** The tightest scope around real inputs: visible dialog, else visible form, else page. */
export async function formScope(page: Page): Promise<FormScope> {
  const dialog = page.locator(DIALOG_SELECTOR).filter({ visible: true }).first();
  if (await dialog.count().catch(() => 0)) return dialog;
  const form = page.locator('form').filter({ visible: true }).first();
  if (await form.count().catch(() => 0)) return form;
  return page;
}

export async function scopeText(page: Page, scope: FormScope, limit = 10_000): Promise<string> {
  const text = scope === page
    ? await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '')
    : await (scope as Locator).innerText({ timeout: 5_000 }).catch(() => '');
  return text.slice(0, limit);
}

export async function describeField(control: Locator): Promise<DescribedField | null> {
  return control.evaluate((node) => {
    const el = node as HTMLInputElement;
    const labels = 'labels' in el && el.labels
      ? Array.from(el.labels).map((label) => label.textContent ?? '').join(' ')
      : '';
    return {
      tag: el.tagName.toLowerCase() as 'input' | 'select' | 'textarea',
      type: (el.getAttribute('type') || el.type || 'text').toLowerCase(),
      name: el.getAttribute('name') || '',
      id: el.getAttribute('id') || '',
      placeholder: el.getAttribute('placeholder') || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      label: labels.replace(/\s+/g, ' ').trim().slice(0, 80),
      required: el.required || el.getAttribute('aria-required') === 'true',
      value: String(el.value ?? ''),
    };
  }).catch(() => null);
}

export async function fillTextField(field: Locator, value: string): Promise<void> {
  await field.fill(value).catch(() => {});
  if ((await field.inputValue().catch(() => '')).trim() === value) return;
  // Controlled React inputs occasionally ignore fill(); real keystrokes dispatch
  // the input events their state depends on.
  await field.click({ timeout: 5_000 }).catch(() => {});
  await field.press('ControlOrMeta+a').catch(() => {});
  await field.pressSequentially(value, { delay: 25, timeout: 10_000 }).catch(() => {});
}

export async function firstRealOption(select: Locator): Promise<{ value: string; text: string } | null> {
  const options = await select.evaluate((node) => Array.from((node as HTMLSelectElement).options)
    .filter((option) => !option.disabled)
    .map((option) => ({ value: option.value, text: (option.textContent ?? '').trim() }))).catch(() => []);
  return options.find((option) => !isPlaceholderOption(option.value, option.text)) ?? null;
}

/**
 * The form's own validation text is the fastest route to a fix, so surface it
 * verbatim instead of only reporting that the submit did not land.
 */
export async function collectFormErrors(page: Page): Promise<string[]> {
  const messages = await page.evaluate(`(() => {
    const selector = [
      '[role="alert"]', '.invalid-feedback', '.field-error', '.error-message',
      '.error', '.text-danger', '.help-block', '[class*="errorText" i]',
      '[class*="text-red" i]', '[class*="Mui-error" i]',
    ].join(', ');
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const texts = [...document.querySelectorAll(selector)]
      .filter(visible)
      .map((el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim())
      .filter((text) => text.length > 0 && text.length < 200);
    const invalid = [...document.querySelectorAll('[aria-invalid="true"]')]
      .filter(visible)
      .map((el) => 'invalid:' + (el.getAttribute('name') || el.getAttribute('id') || 'field'));
    return [...new Set([...texts, ...invalid])].slice(0, 10);
  })()`).catch(() => [] as string[]);
  return messages as string[];
}

/** Picker search ("Search companies...") must never be treated as a data field. */
export async function looksLikeSearchField(locator: Locator): Promise<boolean> {
  const attrs = await locator.evaluate((el) => {
    const input = el as HTMLInputElement;
    return {
      name: input.getAttribute('name') || '',
      id: input.getAttribute('id') || '',
      type: (input.getAttribute('type') || input.type || '').toLowerCase(),
      placeholder: input.getAttribute('placeholder') || '',
      ariaLabel: input.getAttribute('aria-label') || '',
      role: input.getAttribute('role') || '',
    };
  }).catch(() => null);
  if (!attrs) return false;
  if (attrs.type === 'search') return true;
  const blob = [attrs.name, attrs.id, attrs.placeholder, attrs.ariaLabel, attrs.role].join(' ');
  return /\bsearch\b/i.test(blob);
}

export async function firstVisible(
  builders: Array<() => Locator>,
  opts: { editable?: boolean; rejectSearch?: boolean } = {},
): Promise<Locator | null> {
  for (const build of builders) {
    let matches: Locator;
    try {
      matches = build().filter({ visible: true });
    } catch {
      continue; // one unsupported strategy must not kill the rest
    }
    const count = Math.min(await matches.count().catch(() => 0), 8);
    for (let index = 0; index < count; index++) {
      const candidate = matches.nth(index);
      if (opts.editable && !await candidate.isEditable({ timeout: 500 }).catch(() => false)) continue;
      if (opts.rejectSearch && await looksLikeSearchField(candidate)) continue;
      return candidate;
    }
  }
  return null;
}

/**
 * The worker cannot see the tenant's DOM, so a bare "not found" costs another
 * whole run to diagnose. Attach what was actually on screen instead.
 */
export async function describeVisibleControls(page: Page): Promise<{
  fields: string[];
  buttons: string[];
  dialogs: number;
}> {
  return await page.evaluate(`(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const attr = (el, n) => (el.getAttribute(n) || '').slice(0, 40);
    const fields = [...document.querySelectorAll('input, textarea, select')]
      .filter(visible)
      .slice(0, 12)
      .map((el) => [
        el.tagName.toLowerCase(),
        'type=' + (attr(el, 'type') || 'text'),
        attr(el, 'name') && 'name=' + attr(el, 'name'),
        attr(el, 'id') && 'id=' + attr(el, 'id'),
        attr(el, 'placeholder') && 'placeholder=' + attr(el, 'placeholder'),
        attr(el, 'aria-label') && 'aria-label=' + attr(el, 'aria-label'),
      ].filter(Boolean).join(' '));
    const buttons = [...document.querySelectorAll('button, [role="button"], a')]
      .filter(visible)
      .map((el) => (el.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 40))
      .filter(Boolean)
      .slice(0, 15);
    const dialogs = [...document.querySelectorAll('[role="dialog"], dialog')].filter(visible).length;
    return { fields, buttons, dialogs };
  })()`).catch(() => ({ fields: [], buttons: [], dialogs: 0 })) as {
    fields: string[];
    buttons: string[];
    dialogs: number;
  };
}
