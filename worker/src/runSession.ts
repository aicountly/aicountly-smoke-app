import path from 'node:path';
import { chromium, firefox, webkit, type Browser, type BrowserContext } from 'playwright';
import { config } from './config.js';
import {
  recordResult, recordInventory, recordUxIssues, recordFeatureGaps,
  type Job,
} from './backend.js';
import { login } from './auth/login.js';
import { scanMenus } from './scanner/menuScanner.js';
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
  const page = await context.newPage();
  const consoleSink = attachConsoleCapture(page);
  const networkSink = attachNetworkCapture(page);

  const allUx: UxIssue[] = [];
  const allGaps: FeatureGap[] = [];
  const screenshots: string[] = [];
  let screensObserved = 0;
  let inventoryCount = 0;

  try {
    await login(page, job.profile);

    // Persist landing page observation
    await observeAndPersist(job, page, 'landing', reportsDir, screenshotsDir, allUx, allGaps, screenshots, () => {
      screensObserved++;
    }, (n) => { inventoryCount += n; });

    // Walk top-level menus relevant to this session
    const menus = await scanMenus(page);
    const targets = filterMenusForSession(menus, job);
    for (const m of targets.slice(0, Math.max(4, job.session.expected_screens))) {
      const decision = evaluateClick(m.label, {
        destructiveAllowed: !!job.session.destructive_allowed,
        environment: job.profile.environment,
        allowSafeDemo: !!job.profile.allow_safe_demo,
      });
      if (!decision.allowed) {
        // skip restricted -- log nothing destructive
        continue;
      }
      try {
        if (m.href && /^https?:/.test(m.href)) {
          await page.goto(m.href, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        } else {
          await page.locator(m.selector).first().click({ timeout: 10_000 });
          await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {});
        }
        await observeAndPersist(job, page, m.label, reportsDir, screenshotsDir, allUx, allGaps, screenshots, () => {
          screensObserved++;
        }, (n) => { inventoryCount += n; });
      } catch (err) {
        console.warn(`[smoke-worker] menu visit failed (${m.label}):`, (err as Error).message);
      }
    }
  } finally {
    consoleSink.detach();
    networkSink.detach();
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  // Optional brain enrichment pass over feature gaps
  const enriched = await enrichGaps(job.run.product_name, job.run.environment, allGaps);

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

  // Ask backend to finalise the run if this was the last job (idempotent)
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

async function observeAndPersist(
  job: Job,
  page: import('playwright').Page,
  label: string,
  reportsDir: string,
  screenshotsDir: string,
  allUx: UxIssue[],
  allGaps: FeatureGap[],
  screenshots: string[],
  onScreenObserved: () => void,
  onInventoryRecorded: (n: number) => void,
): Promise<void> {
  const meta = await scanPage(page);
  const inventory = await collectInventory(page);
  const shotPath = await captureScreenshot(page, screenshotsDir, label || meta.title || 'screen');
  screenshots.push(shotPath);

  const resultId = await recordResult({
    run_id: job.run.id,
    session_id: job.session.id,
    screen_url: meta.url,
    screen_title: meta.title,
    module_name: meta.module_name,
    screenshot_path: shotPath,
    page_metadata: meta,
    console_errors: [],   // captured at session level; left empty here for the row
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

  // Heuristic UX review for this screen
  const issues = reviewPage({ meta, inventory, consoleEvents: [], networkEvents: [] });
  for (const i of issues) allUx.push(i);

  // Feature-gap heuristic uses inventory + benchmarks fetched lazily once per run
  if (allGaps.length === 0) {
    try {
      const benchmarksResp = await import('./backend.js').then(({ backend }) =>
        backend.get<{ data: Array<{ product_name: string; competitor_name: string; feature_list_json: string | string[]; source_url?: string }> }>('/competitors', { params: { product_name: job.run.product_name, enabled: true } }),
      );
      const benchmarks = benchmarksResp.data.data.map((c) => {
        const list = Array.isArray(c.feature_list_json)
          ? c.feature_list_json
          : (() => { try { return JSON.parse(c.feature_list_json as string) as string[]; } catch { return []; } })();
        return {
          product_name: c.product_name,
          competitor_name: c.competitor_name,
          features: list,
          source_url: c.source_url,
        };
      });
      const gaps = detectGaps(job.run.product_name, inventory, benchmarks);
      for (const g of gaps) allGaps.push(g);
    } catch (err) {
      console.warn('[smoke-worker] benchmarks fetch failed:', (err as Error).message);
    }
  }

  onScreenObserved();
  onInventoryRecorded(inventory.length);
  void reportsDir;
}

function filterMenusForSession(menus: Awaited<ReturnType<typeof scanMenus>>, job: Job): Awaited<ReturnType<typeof scanMenus>> {
  const path = (job.session.menu_path || '').toLowerCase();
  if (!path || path === '/' || path === '/menu/*') return menus;
  return menus.filter((m) => m.label.toLowerCase().includes(path.replace(/[^a-z0-9 ]/g, ' ').trim()) ||
                              m.href.toLowerCase().includes(path.replace('*', '').replace(/^\//, '')));
}
