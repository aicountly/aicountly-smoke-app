import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';

export type PageSignature = {
  url: string;
  title: string;
  markCount: number;
  domHash: string;
  dialogCount: number;
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
  const state = await page.evaluate<{ markCount: number; domHash: string; dialogCount: number }>(`(() => {
    const source = (document.body && document.body.innerText || '') + '|' + document.querySelectorAll('*').length;
    let hash = 2166136261;
    for (let i = 0; i < source.length; i += 1) {
      hash ^= source.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return {
      markCount: document.querySelectorAll('[data-smoke-mark]').length,
      domHash: (hash >>> 0).toString(16),
      dialogCount: document.querySelectorAll('dialog,[role="dialog"],[aria-modal="true"]').length
    };
  })()`);
  return {
    url: page.url(),
    title: await page.title().catch(() => ''),
    ...state,
  };
}

export function signatureKey(value: PageSignature): string {
  return `${value.url}|${value.title}|${value.markCount}|${value.domHash}|${value.dialogCount}`;
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
