import path from 'node:path';
import { chromium, firefox, webkit, type Browser, type BrowserContext, type Page } from 'playwright';
import { config } from './config.js';
import {
  recordResult, recordInventory, recordUxIssues, recordFeatureGaps,
  appendLog,
  type Job,
} from './backend.js';
import { login } from './auth/login.js';
import { scanMenus, type MenuItem } from './scanner/menuScanner.js';
import { scanPage } from './scanner/pageScanner.js';
import { collectInventory } from './scanner/uiInventory.js';
import { captureScreenshot } from './scanner/screenshotCapture.js';
import { attachConsoleCapture } from './scanner/consoleCapture.js';
import { attachNetworkCapture } from './scanner/networkCapture.js';
import { reviewPage, type UxIssue } from './reviewer/uxReviewEngine.js';
import { detectGaps, type FeatureGap } from './reviewer/featureGapEngine.js';
import { enrichGaps } from './reviewer/competitorComparison.js';
import { buildSessionReport } from './reporter/sessionReportBuilder.js';
import { finalizeIfLast } from './reporter/finalReportBuilder.js';
import { evaluateClick } from './utils/safeActionGuard.js';

const browserMap = { chromium, firefox, webkit } as const;

type ObserveCtx = {
  job: Job;
  page: Page;
  reportsDir: string;
  screenshotsDir: string;
  allUx: UxIssue[];
  allInventory: import('./scanner/uiInventory.js').InventoryEntry[];
  screenshots: string[];
  onScreenObserved: () => void;
  onInventoryRecorded: (n: number) => void;
};

export async function runSession(job: Job): Promise<Record<string, unknown>> {
  const startedAt = new Date().toISOString();
  const reportsDir = path.isAbsolute(job.run.reports_dir)
    ? job.run.reports_dir
    : path.resolve(config.repoRoot, job.run.reports_dir);
  const screenshotsDir = path.join(reportsDir, 'screenshots');

  const browser: Browser = await browserMap[config.playwright.browser].launch({
    headless: config.playwright.headless,
    slowMo: config.playwright.slowMo,
  });
  const context: BrowserContext = await browser.newContext({
    userAgent: config.playwright.userAgent,
    viewport: { width: 1440, height: 900 },
  });
  // tsx/esbuild keepNames injects __name() into serialized page.evaluate fns;
  // polyfill it in the browser so any remaining function-form evaluates don't crash.
  await context.addInitScript('window.__name = function (t) { return t; };');
  const page = await context.newPage();
  const consoleSink = attachConsoleCapture(page);
  const networkSink = attachNetworkCapture(page);

  const allUx: UxIssue[] = [];
  const allInventory: import('./scanner/uiInventory.js').InventoryEntry[] = [];
  const screenshots: string[] = [];
  let screensObserved = 0;
  let inventoryCount = 0;

  const ctx: ObserveCtx = {
    job,
    page,
    reportsDir,
    screenshotsDir,
    allUx,
    allInventory,
    screenshots,
    onScreenObserved: () => { screensObserved++; },
    onInventoryRecorded: (n) => { inventoryCount += n; },
  };

  try {
    await appendLog({
      run_id: job.run_id,
      session_id: job.session.id,
      job_id: job.job_id,
      message: `Launching browser (${config.playwright.browser}, headless=${config.playwright.headless})`,
    }).catch(() => {});

    // Action 1: open login page and capture it
    await page.goto(job.profile.login_url, { waitUntil: 'domcontentloaded' });
    await observeAndPersist(ctx, '01-login-form');
    await appendLog({
      run_id: job.run_id,
      session_id: job.session.id,
      job_id: job.job_id,
      message: `Action screenshot: login form at ${page.url()}`,
    }).catch(() => {});

    try {
      await login(page, job.profile);
    } catch (err) {
      const errMsg = (err as Error).message;
      try {
        await observeAndPersist(ctx, '01b-login-failed');
      } catch { /* ignore */ }
      await appendLog({
        run_id: job.run_id,
        session_id: job.session.id,
        job_id: job.job_id,
        level: 'error',
        message: `Login failed: ${errMsg}`,
      }).catch(() => {});
      throw err;
    }
    await appendLog({
      run_id: job.run_id,
      session_id: job.session.id,
      job_id: job.job_id,
      message: `Login successful — now at ${page.url()}`,
    }).catch(() => {});

    // Action 2: post-login landing / dashboard
    await observeAndPersist(ctx, '02-after-login-landing');
    await appendLog({
      run_id: job.run_id,
      session_id: job.session.id,
      job_id: job.job_id,
      message: `Action screenshot: landing page "${(await page.title().catch(() => ''))}" @ ${page.url()}`,
    }).catch(() => {});

    // Discover menus and visit session-relevant ones
    let menus = await scanMenus(page);
    let targets = filterMenusForSession(menus, job);

    // If filter wiped everything, fall back to all menus (better than 0 screens).
    if (menus.length > 0 && targets.length === 0) {
      await appendLog({
        run_id: job.run_id,
        session_id: job.session.id,
        job_id: job.job_id,
        level: 'warn',
        message: `Menu filter matched 0 of ${menus.length} item(s) for path "${job.session.menu_path}"; using keyword/all-menu fallback`,
      }).catch(() => {});
      targets = keywordMenusForSession(menus, job);
      if (targets.length === 0) targets = menus;
    }

    // If still no menus, try direct URL from menu_path + capture each page
    let actionOrdinal = 3;
    if (targets.length === 0) {
      const direct = buildDirectUrls(job);
      for (const url of direct) {
        try {
          await appendLog({
            run_id: job.run_id,
            session_id: job.session.id,
            job_id: job.job_id,
            message: `Action: direct-nav ${url}`,
          }).catch(() => {});
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
          await sleep(800);
          const label = `${String(actionOrdinal).padStart(2, '0')}-direct-${slug(url)}`;
          actionOrdinal++;
          await observeAndPersist(ctx, label);
          await appendLog({
            run_id: job.run_id,
            session_id: job.session.id,
            job_id: job.job_id,
            message: `Observed screen after direct-nav @ ${page.url()}`,
          }).catch(() => {});

          menus = await scanMenus(page);
          targets = filterMenusForSession(menus, job);
          if (targets.length === 0) targets = keywordMenusForSession(menus, job);
          if (targets.length === 0) targets = menus;
          await appendLog({
            run_id: job.run_id,
            session_id: job.session.id,
            job_id: job.job_id,
            message: `After direct-nav rediscovered ${menus.length} menu item(s)`,
          }).catch(() => {});
          if (targets.length > 0) break;
        } catch (err) {
          await appendLog({
            run_id: job.run_id,
            session_id: job.session.id,
            job_id: job.job_id,
            level: 'warn',
            message: `Direct-nav failed (${url}): ${(err as Error).message}`,
          }).catch(() => {});
        }
      }
    }

    const visitLimit = Math.max(4, job.session.expected_screens || 4);
    await appendLog({
      run_id: job.run_id,
      session_id: job.session.id,
      job_id: job.job_id,
      message: `Found ${menus.length} menu item(s); visiting up to ${Math.min(targets.length, visitLimit)} for this session`,
    }).catch(() => {});

    for (const m of targets.slice(0, visitLimit)) {
      const decision = evaluateClick(m.label, {
        destructiveAllowed: !!job.session.destructive_allowed,
        environment: job.profile.environment,
        allowSafeDemo: !!job.profile.allow_safe_demo,
      });
      if (!decision.allowed) {
        await appendLog({
          run_id: job.run_id,
          session_id: job.session.id,
          job_id: job.job_id,
          level: 'warn',
          message: `Skipped restricted action "${m.label}" (${decision.reason})`,
        }).catch(() => {});
        continue;
      }
      try {
        await appendLog({
          run_id: job.run_id,
          session_id: job.session.id,
          job_id: job.job_id,
          message: `Action: open menu "${m.label}"`,
        }).catch(() => {});

        if (m.href && /^https?:/.test(m.href)) {
          await page.goto(m.href, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        } else {
          await page.locator(m.selector).first().click({ timeout: 10_000 });
          await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {});
        }
        await sleep(500);

        const label = `${String(actionOrdinal).padStart(2, '0')}-menu-${slug(m.label)}`;
        actionOrdinal++;
        await observeAndPersist(ctx, label);
        await appendLog({
          run_id: job.run_id,
          session_id: job.session.id,
          job_id: job.job_id,
          message: `Observed screen: ${m.label} @ ${page.url()}`,
        }).catch(() => {});
      } catch (err) {
        const errMsg = (err as Error).message;
        console.warn(`[smoke-worker] menu visit failed (${m.label}):`, errMsg);
        // Still capture whatever is on screen after a failed click.
        try {
          await observeAndPersist(ctx, `${String(actionOrdinal).padStart(2, '0')}-failed-${slug(m.label)}`);
          actionOrdinal++;
        } catch { /* ignore */ }
        await appendLog({
          run_id: job.run_id,
          session_id: job.session.id,
          job_id: job.job_id,
          level: 'warn',
          message: `Menu visit failed (${m.label}): ${errMsg}`,
        }).catch(() => {});
      }
    }

    if (screensObserved <= 2 && targets.length === 0) {
      await appendLog({
        run_id: job.run_id,
        session_id: job.session.id,
        job_id: job.job_id,
        level: 'warn',
        message: 'No navigable menu actions found after login — only login/landing screenshots were captured.',
      }).catch(() => {});
    }
  } finally {
    consoleSink.detach();
    networkSink.detach();
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  // Gap detection once at end of session against the full inventory.
  // Must use /worker/competitors (worker token) — JWT /competitors returns 401.
  let heuristicGaps: FeatureGap[] = [];
  try {
    const { backend } = await import('./backend.js');
    const benchmarksResp = await backend.get<{
      data: Array<{
        product_name: string;
        competitor_name: string;
        feature_list_json: string | string[];
        source_url?: string;
      }>;
    }>('/worker/competitors', {
      params: { product_name: job.run.product_name, enabled: true },
    });
    const rows = benchmarksResp.data?.data ?? [];
    const benchmarks = rows.map((c) => {
      const list = Array.isArray(c.feature_list_json)
        ? c.feature_list_json
        : (() => {
            try {
              return JSON.parse(c.feature_list_json as string) as string[];
            } catch {
              return [];
            }
          })();
      return {
        product_name: c.product_name,
        competitor_name: c.competitor_name,
        features: list,
        source_url: c.source_url,
      };
    });
    heuristicGaps = detectGaps(job.run.product_name, allInventory, benchmarks);
    await appendLog({
      run_id: job.run_id,
      session_id: job.session.id,
      job_id: job.job_id,
      message: `Feature gap scan: ${benchmarks.length} competitor catalog(s), ${allInventory.length} inventory item(s), ${heuristicGaps.length} gap(s)`,
    }).catch(() => {});
    if (benchmarks.length === 0) {
      await appendLog({
        run_id: job.run_id,
        session_id: job.session.id,
        job_id: job.job_id,
        level: 'warn',
        message: `No competitor benchmarks for product "${job.run.product_name}". Seed Competitor Benchmarks or match product_name.`,
      }).catch(() => {});
    }
  } catch (err) {
    const msg = (err as Error).message;
    console.warn('[smoke-worker] benchmarks fetch failed:', msg);
    await appendLog({
      run_id: job.run_id,
      session_id: job.session.id,
      job_id: job.job_id,
      level: 'warn',
      message: `Feature gap benchmarks fetch failed: ${msg}`,
    }).catch(() => {});
  }

  const enriched = await enrichGaps(job.run.product_name, job.run.environment, heuristicGaps);

  await recordUxIssues(allUx.map((i) => ({
    run_id:      job.run.id,
    session_id:  job.session.id,
    category:    i.category,
    severity:    i.severity,
    title:       i.title,
    description: i.description,
    recommendation:  i.recommendation,
    developer_prompt: i.developer_prompt,
    evidence:    i.evidence,
  })));
  await recordFeatureGaps(enriched.map((g) => ({
    run_id:           job.run.id,
    session_id:       job.session.id,
    product_name:     g.product_name,
    expected_feature: g.expected_feature,
    observed:         g.observed,
    partial:          g.partial,
    competitor_ref:   g.competitor_ref,
    severity:         g.severity,
    recommendation:   g.recommendation,
    developer_prompt: g.developer_prompt,
    notes:            g.notes,
    sources:          g.sources,
  })));

  const completedAt = new Date().toISOString();
  await buildSessionReport({
    run: job.run,
    session: job.session,
    reportsDir,
    screensObserved,
    inventoryCount,
    uxIssues: allUx,
    featureGaps: enriched,
    screenshots,
    startedAt,
    completedAt,
  });

  await finalizeIfLast(job.run.id);

  return {
    started_at: startedAt,
    completed_at: completedAt,
    screens_observed: screensObserved,
    inventory_count: inventoryCount,
    ux_issues: allUx.length,
    feature_gaps: enriched.length,
  };
}

async function observeAndPersist(ctx: ObserveCtx, label: string): Promise<void> {
  const { job, page, reportsDir, screenshotsDir, allUx, allInventory, screenshots } = ctx;
  const meta = await scanPage(page);
  const inventory = await collectInventory(page);
  const shotPath = await captureScreenshot(page, screenshotsDir, label || meta.title || 'screen');
  screenshots.push(shotPath);
  for (const item of inventory) allInventory.push(item);

  const resultId = await recordResult({
    run_id: job.run.id,
    session_id: job.session.id,
    screen_url: meta.url,
    screen_title: meta.title || label,
    module_name: meta.module_name || label,
    screenshot_path: shotPath,
    page_metadata: meta,
    console_errors: [],
    network_errors: [],
    performance: {},
  });
  await recordInventory(inventory.map((i) => ({
    run_id: job.run.id,
    session_id: job.session.id,
    result_id: resultId,
    kind: i.kind,
    label: i.label,
    selector: i.selector,
    url: i.url,
    payload: i.payload,
  })));

  const issues = reviewPage({ meta, inventory, consoleEvents: [], networkEvents: [] });
  for (const i of issues) allUx.push(i);

  ctx.onScreenObserved();
  ctx.onInventoryRecorded(inventory.length);
  void reportsDir;
}

function filterMenusForSession(menus: MenuItem[], job: Job): MenuItem[] {
  const raw = (job.session.menu_path || '').toLowerCase().trim();
  if (!raw || raw === '/' || raw === '/menu/*' || raw === '*') return menus;

  const token = raw.replace(/\*/g, '').replace(/^\//, '').replace(/\/$/, '');
  const parts = token.split(/[\/\-_]+/).filter((p) => p.length > 1);

  const matched = menus.filter((m) => {
    const hay = `${m.label} ${m.href}`.toLowerCase();
    if (token && hay.includes(token.replace(/\//g, ''))) return true;
    return parts.some((p) => hay.includes(p));
  });
  return matched;
}

/** Match menus using session name words (e.g. "Settings & Configuration"). */
function keywordMenusForSession(menus: MenuItem[], job: Job): MenuItem[] {
  const words = `${job.session.name} ${job.session.menu_path || ''}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !['and', 'the', 'for', 'with', 'menu'].includes(w));
  if (words.length === 0) return [];
  return menus.filter((m) => {
    const hay = `${m.label} ${m.href}`.toLowerCase();
    return words.some((w) => hay.includes(w));
  });
}

function buildDirectUrls(job: Job): string[] {
  const base = (job.profile.base_url || '').replace(/\/$/, '');
  if (!base) return [];
  const raw = (job.session.menu_path || '').trim();
  const urls: string[] = [];
  if (raw && raw !== '/' && !raw.includes('*')) {
    urls.push(base + (raw.startsWith('/') ? raw : `/${raw}`));
  }
  const slugName = slug(job.session.name).replace(/-/g, '');
  const guesses = [
    job.session.name.toLowerCase().includes('setting') ? '/settings' : '',
    job.session.name.toLowerCase().includes('sales') ? '/sales' : '',
    job.session.name.toLowerCase().includes('invoice') ? '/invoices' : '',
    job.session.name.toLowerCase().includes('purchase') || job.session.name.toLowerCase().includes('bill') ? '/purchase' : '',
    job.session.name.toLowerCase().includes('bank') ? '/banking' : '',
    job.session.name.toLowerCase().includes('inventory') ? '/inventory' : '',
    job.session.name.toLowerCase().includes('gst') ? '/gst' : '',
    job.session.name.toLowerCase().includes('gst') ? '/gstr' : '',
    job.session.name.toLowerCase().includes('gst') ? '/returns' : '',
    job.session.name.toLowerCase().includes('report') ? '/reports' : '',
    job.session.name.toLowerCase().includes('account') || job.session.name.toLowerCase().includes('journal') ? '/accounts' : '',
    job.session.name.toLowerCase().includes('dashboard') ? '/dashboard' : '',
    job.session.name.toLowerCase().includes('dashboard') ? '/home' : '',
    slugName ? `/${slugName}` : '',
  ].filter(Boolean);
  for (const g of guesses) {
    const u = base + g;
    if (!urls.includes(u)) urls.push(u);
  }
  return urls.slice(0, 6);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'screen';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
