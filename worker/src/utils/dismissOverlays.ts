import type { Page } from 'playwright';

const OVERLAY_ROOTS = [
  '[role="dialog"]',
  '[aria-modal="true"]',
  '.modal.show',
  '.MuiDialog-root',
  '.MuiModal-root',
  '.cdk-overlay-container',
  '[class*="overlay" i]',
  '[class*="popover" i]',
];

const DISMISS_LABEL = /^(close|dismiss|not now|maybe later|got it|skip|×)$/i;

/**
 * Dismisses visible modal/popover UI without mutating the underlying page DOM.
 * Returns true when an overlay was present or a dismiss control was clicked.
 */
export async function dismissOverlays(page: Page): Promise<boolean> {
  const roots = page.locator(OVERLAY_ROOTS.join(', '));
  const overlayVisible = await anyVisible(roots);

  if (overlayVisible) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(150);
  }

  const candidates = page.getByRole('button').filter({ visible: true });
  const count = Math.min(await candidates.count().catch(() => 0), 80);
  for (let index = 0; index < count; index++) {
    const button = candidates.nth(index);
    const label = (await button.getAttribute('aria-label').catch(() => null))
      ?? (await button.textContent().catch(() => null))
      ?? '';
    const title = await button.getAttribute('title').catch(() => null) ?? '';
    if (!DISMISS_LABEL.test(label.trim()) && !DISMISS_LABEL.test(title.trim())) continue;
    const insideOverlay = await button.locator('xpath=ancestor::*[@role="dialog" or @aria-modal="true"]').count()
      .then((n) => n > 0)
      .catch(() => false);
    if (!insideOverlay && !overlayVisible) continue;
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 2_000 }).catch(() => {});
      await page.waitForTimeout(150);
      return true;
    }
  }

  return overlayVisible;
}

async function anyVisible(locator: ReturnType<Page['locator']>): Promise<boolean> {
  const count = Math.min(await locator.count().catch(() => 0), 40);
  for (let index = 0; index < count; index++) {
    if (await locator.nth(index).isVisible().catch(() => false)) return true;
  }
  return false;
}
