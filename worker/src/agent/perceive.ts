import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';

export type PageSignature = {
  url: string;
  title: string;
  /** Badged controls, i.e. those on screen. Offscreen marks are excluded on purpose. */
  markCount: number;
  domHash: string;
  /**
   * Hash of every input/select/textarea's current value/checked state, in DOM
   * order. `domHash` is innerText + element count, which does not move when a
   * field is typed into but its rendered text does not change — so a `type`
   * action looked identical to a no-op. This hash exists to make typing count as
   * progress without over-counting scroll-triggered re-renders. Optional so
   * fixtures written before this field existed keep compiling; `signatureKey`
   * treats a missing value as an empty string.
   */
  formHash?: string;
  dialogCount: number;
  scrollY: number;
};

export async function captureViewportJpeg(
  page: Page,
  dir: string,
  name: string,
): Promise<{ path: string; base64: string }> {
  fs.mkdirSync(dir, { recursive: true });
  const safe = name.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 100);
  const filePath = path.join(dir, `${Date.now()}-${safe}.jpg`);
  const buffer = await page.screenshot({
    path: filePath,
    type: 'jpeg',
    quality: 70,
    fullPage: false,
    animations: 'disabled',
  });
  return { path: filePath, base64: buffer.toString('base64') };
}

export async function signature(page: Page): Promise<PageSignature> {
  // Badges rather than marks: marks now include offscreen controls, so counting
  // them would barely move when the page scrolls, and a scroll would look to loop
  // detection like an action that changed nothing.
  const state = await page.evaluate<{
    markCount: number;
    domHash: string;
    formHash: string;
    dialogCount: number;
    scrollY: number;
  }>(`(() => {
    const fnv = (source) => {
      let hash = 2166136261;
      for (let i = 0; i < source.length; i += 1) {
        hash ^= source.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(16);
    };
    const source = (document.body && document.body.innerText || '') + '|' + document.querySelectorAll('*').length;
    const formControls = Array.from(document.querySelectorAll('input,select,textarea'));
    const formSource = formControls
      .map((el) => {
        const checked = typeof el.checked === 'boolean' ? (el.checked ? '1' : '0') : '';
        return (el.value || '') + ':' + checked;
      })
      .join('|');
    return {
      markCount: document.querySelectorAll('[data-smoke-mark-badge]').length,
      domHash: fnv(source),
      formHash: fnv(formSource),
      dialogCount: document.querySelectorAll('dialog,[role="dialog"],[aria-modal="true"]').length,
      scrollY: Math.round(window.scrollY || document.documentElement.scrollTop || 0)
    };
  })()`);
  return {
    url: page.url(),
    title: await page.title().catch(() => ''),
    ...state,
  };
}

/**
 * Rendered text of the page, capped. Used to confirm a value the session typed is
 * now on screen; deliberately innerText, so a form's own field values (which
 * innerText does not expose) cannot confirm the save that submitted them.
 */
export async function visibleText(page: Page, limit = 30_000): Promise<string> {
  const text = await page
    .evaluate<string>(`(() => (document.body && document.body.innerText) || '')()`)
    .catch(() => '');
  return text.slice(0, limit);
}

/** Vertical scroll extent of the page, for deciding whether anything is left to see. */
export async function scrollExtent(page: Page): Promise<{ y: number; maxY: number; height: number }> {
  return page.evaluate<{ y: number; maxY: number; height: number }>(`(() => {
    const doc = document.documentElement;
    const height = window.innerHeight || doc.clientHeight || 0;
    const full = Math.max(
      doc.scrollHeight || 0,
      document.body ? document.body.scrollHeight : 0,
      height
    );
    return {
      y: Math.round(window.scrollY || doc.scrollTop || 0),
      maxY: Math.max(0, Math.round(full - height)),
      height: Math.round(height)
    };
  })()`).catch(() => ({ y: 0, maxY: 0, height: 0 }));
}

/**
 * `scrollY` is deliberately excluded: scrolling is not progress, and including it
 * made a pure scroll look like a changed screen while a filled-in field (before
 * `formHash` existed) looked unchanged — the exact inversion loop detection
 * depends on getting right.
 */
export function signatureKey(value: PageSignature): string {
  return `${value.url}|${value.title}|${value.markCount}|${value.domHash}|${value.formHash ?? ''}|${value.dialogCount}`;
}

/**
 * Wait for a React/SPA render to settle by polling the DOM hash until it is
 * unchanged for quietMs, or until maxMs elapses. Navigation load events are
 * unreliable on client-side route changes.
 */
export async function waitForSettle(
  page: Page,
  options: { maxMs?: number; quietMs?: number; pollMs?: number } = {},
): Promise<void> {
  const maxMs = Math.max(200, options.maxMs ?? 4_000);
  const quietMs = Math.max(100, options.quietMs ?? 350);
  const pollMs = Math.max(50, options.pollMs ?? 150);
  const started = Date.now();
  let lastHash = '';
  let stableSince = 0;

  while (Date.now() - started < maxMs) {
    const next = await page.evaluate<string>(`(() => {
      const source = (document.body && document.body.innerText || '') + '|' + document.querySelectorAll('*').length;
      let hash = 2166136261;
      for (let i = 0; i < source.length; i += 1) {
        hash ^= source.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(16);
    })()`).catch(() => '');
    if (next && next === lastHash) {
      if (stableSince === 0) stableSince = Date.now();
      if (Date.now() - stableSince >= quietMs) return;
    } else {
      lastHash = next;
      stableSince = 0;
    }
    await page.waitForTimeout(pollMs);
  }
}
