import type { Page } from 'playwright';
import { decryptCredential, type ProfileRow } from '../backend.js';

/**
 * Generic AICOUNTLY login flow. Tries common selectors in order:
 *   email/username -> password -> submit. The login_strategy field in the
 *   target profile selects between standard / sandbox / etc. Add product-
 *   specific strategies here as needed.
 */
export async function login(page: Page, profile: ProfileRow): Promise<void> {
  const password = await decryptCredential(profile.id);
  if (!password) {
    throw new Error(`No credential stored for target profile ${profile.id}.`);
  }

  await page.goto(profile.login_url, { waitUntil: 'domcontentloaded' });

  switch (profile.login_strategy || 'standard') {
    case 'standard':
    default:
      await standardLogin(page, profile, password);
      break;
  }

  // Wait for app shell -- best-effort
  try {
    await page.waitForLoadState('networkidle', { timeout: 15000 });
  } catch { /* non-fatal */ }
}

async function standardLogin(page: Page, profile: ProfileRow, password: string): Promise<void> {
  const userSelectors = [
    'input[name="email"]',
    'input[type="email"]',
    'input[name="username"]',
    'input#email',
    'input#username',
    'input[autocomplete="username"]',
  ];
  const passSelectors = [
    'input[name="password"]',
    'input[type="password"]',
    'input#password',
    'input[autocomplete="current-password"]',
  ];
  const submitSelectors = [
    'button[type="submit"]',
    'button:has-text("Login")',
    'button:has-text("Sign in")',
    'input[type="submit"]',
  ];

  for (const sel of userSelectors) {
    if (await page.locator(sel).first().isVisible().catch(() => false)) {
      await page.locator(sel).first().fill(profile.username);
      break;
    }
  }
  for (const sel of passSelectors) {
    if (await page.locator(sel).first().isVisible().catch(() => false)) {
      await page.locator(sel).first().fill(password);
      break;
    }
  }
  for (const sel of submitSelectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      return;
    }
  }
  // fallback: press Enter
  await page.keyboard.press('Enter');
}
