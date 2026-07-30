import type { Locator, Page } from 'playwright';
import { decryptCredential, type ProfileRow } from '../backend.js';
import { buildJumpPlan, pickJumpTarget } from './jumpTargets.js';

/**
 * AICOUNTLY login is multi-step:
 *   1) Email address / Username + required "Jump To" product → SIGN IN
 *   2) Password                  → CONTINUE / SIGN IN
 *   3) Optional OTP (not automatable here)
 *
 * Without "Jump To", the form stays on /login with:
 *   "Error! Please choose jump to."
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
      await aicountlyLogin(page, profile, password);
      break;
  }

  await assertLoggedIn(page, profile);
}

async function aicountlyLogin(page: Page, profile: ProfileRow, password: string): Promise<void> {
  const username = profile.username.trim();

  // --- Step 1: identity (Email address / Username) + Jump To ---
  const identity = await findIdentityField(page);
  if (!identity) {
    throw new Error('Login form: could not find Email/Username field on step 1.');
  }
  await fillReactInput(identity, username);

  // Required on my.aicountly.com — omitting this leaves you on /login with
  // "Error! Please choose jump to." and never reaches Sales/Invoices etc.
  await selectJumpTo(page, profile);

  const step1Btn = page
    .locator('button[type="submit"], button:has-text("SIGN IN"), button:has-text("Sign In"), button:has-text("CONTINUE")')
    .filter({ hasNotText: /google|otp|phone/i })
    .first();
  if (!(await step1Btn.isVisible().catch(() => false))) {
    throw new Error('Login form: SIGN IN button not found on step 1.');
  }
  await step1Btn.click();

  // --- Step 2: password (appears after identity submit) ---
  // Without Jump To, AICountly stays on step 1 ("Please choose jump to.") and
  // never shows the password field — that is what the click timeout in logs means.
  const pass = page.locator('input[type="password"]:visible').first();
  try {
    await pass.waitFor({ state: 'visible', timeout: 20_000 });
  } catch {
    await throwIfOtpOrError(page, 'Password step did not appear after submitting email/username. ');
    throw new Error(
      'Password step did not appear after submitting email/username. '
      + 'Usually Jump To was not selected, or the account hit OTP/2FA. '
      + 'Ensure worker login.ts selects #jumptoe for this profile\'s product and PM2 was restarted.',
    );
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

/**
 * AICountly login requires a "Jump To" product destination (Smart Books, ERP, etc.).
 * The destination decides which product host you land on, so it is chosen
 * product-first from the profile's product_name — never by dropdown order.
 */
async function selectJumpTo(page: Page, profile: ProfileRow): Promise<void> {
  const select = await findJumpToSelect(page);
  if (!select) {
    // my.aicountly.com always has #jumptoe; missing it means wrong page or stale DOM.
    if (/aicountly\.com/i.test(page.url())) {
      throw new Error(
        'Login form: Jump To dropdown (#jumptoe) not found. '
        + 'Upload the latest portals/smoke/auth/login.ts and restart PM2.',
      );
    }
    return;
  }

  const options = await select.locator('option').evaluateAll((els) =>
    els.map((el) => ({
      value: (el as HTMLOptionElement).value,
      label: ((el as HTMLOptionElement).textContent || '').trim(),
    })),
  );

  const plan = buildJumpPlan(profile.product_name || '');
  for (const warning of plan.warnings) {
    console.warn(`[smoke-worker] Jump To: ${warning}`);
  }

  const pick = pickJumpTarget(options, plan);
  if (!pick) {
    throw new Error('Login form: Jump To dropdown has no selectable products.');
  }
  const picked = pick.option;

  console.log(
    `[smoke-worker] Jump To: product="${plan.product || '(none)'}" → "${picked.label}" `
    + `(value="${picked.value}", match=${pick.source}${pick.matchedPreference ? `:${pick.matchedPreference}` : ''}, `
    + `preferred=[${plan.preferred.join(', ')}])`,
  );
  if (pick.source !== 'preferred' && plan.product) {
    console.warn(
      `[smoke-worker] Jump To: no option matched product "${plan.product}"; `
      + `fell back to "${picked.label}". Available: ${options.map((o) => o.label).filter(Boolean).join(' | ')}`,
    );
  }

  // Prefer label match for React/select2; fall back to value.
  try {
    await select.selectOption({ label: picked.label });
  } catch {
    await select.selectOption({ value: picked.value });
  }

  // Custom dropdowns sometimes need a click + option click instead of native select.
  const selected = await select.inputValue().catch(() => '');
  if (!selected || /^select|^choose|^jump|^--$/i.test(selected)) {
    await select.click({ timeout: 5_000 }).catch(() => {});
    const opt = page
      .locator(
        `option:has-text("${picked.label}"), [role="option"]:has-text("${picked.label}"), li:has-text("${picked.label}")`,
      )
      .first();
    if (await opt.isVisible().catch(() => false)) {
      await opt.click();
    }
  }

  const after = await select.inputValue().catch(() => '');
  if (!after || /^select|^choose|^jump|^--$/i.test(after)) {
    throw new Error(
      `Login form: could not select Jump To product (tried "${picked.label}" for product "${plan.product || 'unknown'}"). `
      + `Set SMOKE_JUMP_TO_${(plan.product || 'PRODUCT').toUpperCase().replace(/[^A-Z0-9]+/g, '_')} if the label differs on this tenant.`,
    );
  }
}

async function findJumpToSelect(page: Page): Promise<Locator | null> {
  // Live my.aicountly.com uses <select id="jumptoe" name="jumptoe"> (email tab)
  // and a hidden <select id="jumptop_phone" name="jumptop"> (phone tab).
  const candidates = [
    'select#jumptoe',
    'select[name="jumptoe"]',
    'select[name*="jump" i]',
    'select[id*="jump" i]',
    'select[name*="product" i]',
    'select[id*="product" i]',
    'select[name*="redirect" i]',
    'select[aria-label*="Jump" i]',
    'label:has-text("Jump To") + select',
    'label:has-text("Jump To") ~ select',
  ];

  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) return loc;
  }

  // Near the "Jump To" label.
  const jumpLabel = page.getByText(/jump\s*to/i).first();
  if (await jumpLabel.isVisible().catch(() => false)) {
    const nearby = jumpLabel.locator('xpath=ancestor::*[self::div or self::form or self::fieldset][1]//select').first();
    if (await nearby.isVisible().catch(() => false)) return nearby;
  }

  // Any visible select whose options look like AICountly products.
  const selects = page.locator('select:visible');
  const count = await selects.count();
  for (let i = 0; i < count; i++) {
    const loc = selects.nth(i);
    const text = ((await loc.innerText().catch(() => '')) || '').toLowerCase();
    if (/smart books|books|erp|contacts|hrms|our people|ourpeople|buddy|vault|auditor|my account/.test(text)) {
      return loc;
    }
  }
  return null;
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
    if (msg && /empty|invalid|incorrect|required|failed|not found|please choose|jump to|user not found/i.test(msg)) {
      throw new Error(`${prefix}Login form error: ${msg.slice(0, 240)}`);
    }
  }

  if (
    isLoginUrl(page.url())
    && /email\/phone cannot be empty|cannot be empty|invalid (email|password|credentials)|please choose jump|choose jump to|user not found/i.test(body)
  ) {
    const m = body.match(
      /email\/phone cannot be empty|cannot be empty|invalid [^\n.]{0,80}|please choose jump[^\n.]{0,40}|choose jump to[^\n.]{0,40}|user not found/i,
    );
    throw new Error(`${prefix}Login form error: ${(m?.[0] || 'validation failed').slice(0, 240)}`);
  }
}

/**
 * Whether a browser context restored from earlier in the run is still signed in.
 * Deliberately does not require an app shell: the company picker is a legitimate
 * signed-in landing screen and has no sidebar of its own.
 */
export async function isSignedIn(page: Page): Promise<boolean> {
  if (isLoginUrl(page.url())) return false;
  const hasPassword = await page.locator('input[type="password"]:visible').first().isVisible().catch(() => false);
  if (hasPassword) return false;
  const hasIdentity = await page
    .locator('input[placeholder*="Email" i]:visible, input[type="email"]:visible')
    .first()
    .isVisible()
    .catch(() => false);
  return !hasIdentity;
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
      `Login did not reach the app shell (still at ${url}). Check username/password and Jump To product for profile "${profile.profile_name}".`,
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
