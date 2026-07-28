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

  await assertLoggedIn(page, profile);
}

async function standardLogin(page: Page, profile: ProfileRow, password: string): Promise<void> {
  const userSelectors = [
    'input[name="email"]',
    'input[type="email"]',
    'input[name="username"]',
    'input#email',
    'input#username',
    'input[autocomplete="username"]',
    'input[placeholder*="email" i]',
    'input[placeholder*="user" i]',
  ];
  const passSelectors = [
    'input[name="password"]',
    'input[type="password"]',
    'input#password',
    'input[autocomplete="current-password"]',
  ];
  const submitSelectors = [
    'button[type="submit"]',
    'button:has-text("SIGN IN")',
    'button:has-text("Sign In")',
    'button:has-text("Sign in")',
    'button:has-text("Log in")',
    'button:has-text("Login")',
    'button:has-text("Log In")',
    'input[type="submit"]',
    'a:has-text("SIGN IN")',
  ];

  let filledUser = false;
  for (const sel of userSelectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) {
      await loc.fill(profile.username);
      filledUser = true;
      break;
    }
  }
  if (!filledUser) {
    throw new Error('Login form: could not find username/email field.');
  }

  let filledPass = false;
  for (const sel of passSelectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) {
      await loc.fill(password);
      filledPass = true;
      break;
    }
  }
  if (!filledPass) {
    throw new Error('Login form: could not find password field.');
  }

  const beforeUrl = page.url();
  let clicked = false;
  for (const sel of submitSelectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible().catch(() => false)) {
      await Promise.all([
        page.waitForLoadState('domcontentloaded', { timeout: 25_000 }).catch(() => {}),
        btn.click(),
      ]);
      clicked = true;
      break;
    }
  }
  if (!clicked) {
    await page.keyboard.press('Enter');
  }

  // SPA apps often keep the document; wait for URL change and/or app shell.
  await Promise.race([
    page.waitForURL((url) => !isLoginUrl(url.href) && url.href !== beforeUrl, { timeout: 25_000 }),
    page.waitForSelector(
      'nav, aside, [role="navigation"], .sidebar, [class*="sidebar" i], [class*="sidenav" i], [class*="side-nav" i]',
      { timeout: 25_000 },
    ),
  ]).catch(() => {});

  try {
    await page.waitForLoadState('networkidle', { timeout: 12_000 });
  } catch {
    /* non-fatal */
  }
}

async function assertLoggedIn(page: Page, profile: ProfileRow): Promise<void> {
  const url = page.url();
  const stillLogin = isLoginUrl(url);
  const hasPassword = await page.locator('input[type="password"]').first().isVisible().catch(() => false);
  const hasNav = await page
    .locator('nav, aside, [role="navigation"], .sidebar, [class*="sidebar" i], [class*="sidenav" i]')
    .first()
    .isVisible()
    .catch(() => false);

  if (stillLogin || (hasPassword && !hasNav)) {
    throw new Error(
      `Login did not reach the app shell (still at ${url}). Check username/password for profile "${profile.profile_name}" and that the account can sign in.`,
    );
  }
}

function isLoginUrl(href: string): boolean {
  try {
    const u = new URL(href);
    const p = u.pathname.toLowerCase();
    return /login|signin|sign-in|auth|authenticate/.test(p);
  } catch {
    return /login|signin|sign-in/i.test(href);
  }
}
