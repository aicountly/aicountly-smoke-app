import type { Locator, Page } from 'playwright';
import { decryptCredential, type ProfileRow } from '../backend.js';

/**
 * AICOUNTLY login is multi-step:
 *   1) Email address / Username  → SIGN IN
 *   2) Password                  → CONTINUE / SIGN IN
 *   3) Optional OTP (not automatable here)
 */
export async function login(page: Page, profile: ProfileRow): Promise<void> {
  const password = await decryptCredential(profile.id);
  if (!password) {
    throw new Error(`No credential stored for target profile ${profile.id}.`);
  }
  if (!profile.username?.trim()) {
    throw new Error(`Target profile ${profile.id} has an empty username/email.`);
  }

  if (!isLoginUrl(page.url())) {
    await page.goto(profile.login_url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  }
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await sleep(500);

  switch (profile.login_strategy || 'standard') {
    case 'standard':
    default:
      await aicountlyLogin(page, profile.username.trim(), password);
      break;
  }

  await assertLoggedIn(page, profile);
}

async function aicountlyLogin(page: Page, username: string, password: string): Promise<void> {
  // --- Step 1: identity (Email address / Username) ---
  const identity = await findIdentityField(page);
  if (!identity) {
    throw new Error('Login form: could not find Email/Username field on step 1.');
  }
  await fillReactInput(identity, username);

  const step1Btn = page
    .locator('button[type="submit"], button:has-text("SIGN IN"), button:has-text("Sign In"), button:has-text("CONTINUE")')
    .filter({ hasNotText: /google|otp|phone/i })
    .first();
  if (!(await step1Btn.isVisible().catch(() => false))) {
    throw new Error('Login form: SIGN IN button not found on step 1.');
  }
  await step1Btn.click();

  // --- Step 2: password (appears after identity submit) ---
  const pass = page.locator('input[type="password"]:visible').first();
  try {
    await pass.waitFor({ state: 'visible', timeout: 20_000 });
  } catch {
    await throwIfOtpOrError(page, 'Password step did not appear after submitting email/username.');
  }

  await fillReactInput(pass, password);

  const step2Btn = page
    .locator('button[type="submit"], button:has-text("CONTINUE"), button:has-text("SIGN IN"), button:has-text("Sign In"), button:has-text("Log in")')
    .filter({ hasNotText: /google|different way|customer care/i })
    .first();
  if (await step2Btn.isVisible().catch(() => false)) {
    await step2Btn.click();
  } else {
    await page.keyboard.press('Enter');
  }

  // Wait for app shell, URL leave, or OTP challenge.
  await Promise.race([
    page.waitForURL((url) => !isLoginUrl(url.href), { timeout: 30_000 }),
    page.waitForSelector(
      'nav, aside, [role="navigation"], .sidebar, [class*="sidebar" i], [class*="sidenav" i], [class*="side-nav" i], [class*="dashboard" i]',
      { timeout: 30_000 },
    ),
    page.waitForSelector('input[placeholder*="Verification" i], input[name*="otp" i], text=/6 digit code/i', {
      timeout: 30_000,
    }),
  ]).catch(() => {});

  await sleep(800);
  await throwIfOtpOrError(page);

  try {
    await page.waitForLoadState('networkidle', { timeout: 12_000 });
  } catch {
    /* non-fatal */
  }
}

async function findIdentityField(page: Page): Promise<Locator | null> {
  const candidates = [
    'input[placeholder*="Email" i]',
    'input[placeholder*="Username" i]',
    'input[placeholder*="Phone" i]',
    'input[placeholder*="Mobile" i]',
    'input[name="email"]',
    'input[name="username"]',
    'input[name="email_or_phone"]',
    'input[name="login"]',
    'input[type="email"]',
    'input[type="tel"]',
    'input[autocomplete="username"]',
    'input[id*="email" i]',
    'input[id*="user" i]',
    'input[type="text"]',
  ];

  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) {
      // Skip password / otp fields if a broad selector matched them.
      const type = ((await loc.getAttribute('type')) || 'text').toLowerCase();
      if (type === 'password' || type === 'hidden') continue;
      return loc;
    }
  }

  // Last resort: first visible text-like input on the page.
  const fallback = page.locator('input:not([type="password"]):not([type="hidden"]):visible').first();
  if (await fallback.isVisible().catch(() => false)) return fallback;
  return null;
}

/** React-controlled inputs often ignore a single fill(); clear + type is reliable. */
async function fillReactInput(loc: Locator, value: string): Promise<void> {
  await loc.click({ timeout: 10_000 });
  await loc.fill('');
  await loc.fill(value);
  const current = await loc.inputValue().catch(() => '');
  if (current !== value) {
    await loc.pressSequentially(value, { delay: 20 });
  }
  const again = await loc.inputValue().catch(() => '');
  if (!again) {
    throw new Error('Login form: failed to type into identity/password field (value stayed empty).');
  }
}

async function throwIfOtpOrError(page: Page, prefix = ''): Promise<void> {
  const body = ((await page.locator('body').innerText().catch(() => '')) || '').slice(0, 4000);
  const passVisible = await page.locator('input[type="password"]:visible').count();

  const otpChallenge =
    (/verification code|6 digit code|enter the 6 digit|resend otp/i.test(body) && passVisible === 0)
    || (/check your phone|check your email|verify your identity/i.test(body) && /verification|otp|6 digit/i.test(body));
  if (otpChallenge) {
    throw new Error(
      `${prefix}Login requires OTP / 2FA. Smoke worker cannot complete OTP. Use a sandbox account with password-only login, or disable OTP for this profile.`,
    );
  }

  const errBox = page.locator('.error, .alert-danger, [class*="error" i], [role="alert"]').first();
  if (await errBox.isVisible().catch(() => false)) {
    const msg = ((await errBox.innerText().catch(() => '')) || '').trim().replace(/\s+/g, ' ');
    if (msg && /empty|invalid|incorrect|required|failed|not found/i.test(msg)) {
      throw new Error(`${prefix}Login form error: ${msg.slice(0, 240)}`);
    }
  }

  if (
    isLoginUrl(page.url())
    && /email\/phone cannot be empty|cannot be empty|invalid (email|password|credentials)/i.test(body)
  ) {
    const m = body.match(/email\/phone cannot be empty|cannot be empty|invalid [^\n.]{0,80}/i);
    throw new Error(`${prefix}Login form error: ${(m?.[0] || 'validation failed').slice(0, 240)}`);
  }
}

async function assertLoggedIn(page: Page, profile: ProfileRow): Promise<void> {
  await throwIfOtpOrError(page);

  const url = page.url();
  const stillLogin = isLoginUrl(url);
  const hasPassword = await page.locator('input[type="password"]:visible').first().isVisible().catch(() => false);
  const hasIdentity = await page.locator('input[placeholder*="Email" i]:visible, input[type="email"]:visible').first().isVisible().catch(() => false);
  const hasNav = await page
    .locator('nav, aside, [role="navigation"], .sidebar, [class*="sidebar" i], [class*="sidenav" i], [class*="dashboard" i]')
    .first()
    .isVisible()
    .catch(() => false);

  if (stillLogin || ((hasPassword || hasIdentity) && !hasNav)) {
    throw new Error(
      `Login did not reach the app shell (still at ${url}). Check username/password for profile "${profile.profile_name}".`,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
