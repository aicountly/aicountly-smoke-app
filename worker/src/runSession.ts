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
import { dedupeUxIssues, reviewPage, type UxIssue } from './reviewer/uxReviewEngine.js';
import { detectGaps, type CompetitorBenchmark, type FeatureGap } from './reviewer/featureGapEngine.js';
import { enrichGaps } from './reviewer/competitorComparison.js';
import { fallbackCompetitorCatalogs } from './reviewer/fallbackCompetitorCatalogs.js';
import { buildSessionReport } from './reporter/sessionReportBuilder.js';
import { finalizeIfLast } from './reporter/finalReportBuilder.js';
import {
  buildFeatureGapCursorPrompt,
  buildFeatureGapHumanSummary,
  buildUxCursorPrompt,
  buildUxHumanSummary,
  type CursorPromptContext,
} from './reporter/cursorPromptBuilder.js';
import { evaluateClick, isRestrictedLabel, parseAllowedActions } from './utils/safeActionGuard.js';
import { evaluateHostGuard } from './utils/hostGuard.js';
import { dismissOverlays } from './utils/dismissOverlays.js';
import { askOrRecallDecision, type DecisionOption } from './nav/askDecision.js';
import { performNavAction } from './nav/performNavAction.js';
import { isEmptyCompanyPicker, resolveAppContext } from './nav/resolveAppContext.js';
import type { ConsoleEvent } from './scanner/consoleCapture.js';
import type { NetworkEvent } from './scanner/networkCapture.js';
import { runFileIoScenarios, shouldRunFileIoSession } from './fileIo/fileIoEngine.js';
import type { FileIoTestResult } from './fileIo/types.js';
import { computeVisitBudget } from './utils/visitBudget.js';

const browserMap = { chromium, firefox, webkit } as const;

type ObserveCtx = {
  job: Job;
  page: Page;
  reportsDir: string;
  screenshotsDir: string;
  allUx: UxIssue[];
  allInventory: import('./scanner/uiInventory.js').InventoryEntry[];
  screenshots: string[];
  screenUrls: string[];
  screenTitles: string[];
  screenCapturedAt: string[];
  consoleEvents: ConsoleEvent[];
  networkEvents: NetworkEvent[];
  consoleCursor: number;
  networkCursor: number;
  onScreenObserved: () => void;
  onInventoryRecorded: (n: number) => void;
};

export async function runSession(job: Job): Promise<Record<string, unknown>> {
  const startedAt = new Date().toISOString();
  const reportsDir = path.isAbsolute(job.run.reports_dir)
    ? job.run.reports_dir
    : path.resolve(config.repoRoot, job.run.reports_dir);
  const screenshotsDir = path.join(reportsDir, 'screenshots');
  const allowedActions = parseAllowedActions(job.session.allowed_actions_json);

  const browser: Browser = await browserMap[config.playwright.browser].launch({
    headless: config.playwright.headless,
    slowMo: config.playwright.slowMo,
  });
  const context: BrowserContext = await browser.newContext({
    userAgent: config.playwright.userAgent,
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
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
  const screenUrls: string[] = [];
  const screenTitles: string[] = [];
  const screenCapturedAt: string[] = [];
  let screensObserved = 0;
  let inventoryCount = 0;
  let fileIoResults: FileIoTestResult[] = [];
  let estimatedScreens = 0;

  const ctx: ObserveCtx = {
    job,
    page,
    reportsDir,
    screenshotsDir,
    allUx,
    allInventory,
    screenshots,
    screenUrls,
    screenTitles,
    screenCapturedAt,
    consoleEvents: consoleSink.events,
    networkEvents: networkSink.events,
    consoleCursor: 0,
    networkCursor: 0,
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

    try {
      await enforceProductHost(page, job);
    } catch (err) {
      try {
        await observeAndPersist(ctx, '01c-wrong-product-host');
      } catch { /* ignore */ }
      await appendLog({
        run_id: job.run_id,
        session_id: job.session.id,
        job_id: job.job_id,
        level: 'error',
        message: (err as Error).message,
      }).catch(() => {});
      throw err;
    }

    // Action 2: post-login landing / dashboard
    await observeAndPersist(ctx, '02-after-login-landing');
    await appendLog({
      run_id: job.run_id,
      session_id: job.session.id,
      job_id: job.job_id,
      message: `Action screenshot: landing page "${(await page.title().catch(() => ''))}" @ ${page.url()}`,
    }).catch(() => {});

    const appContext = await resolveAppContext(page, job, { screenshotsDir });
    if (appContext.navigated || appContext.rescan) {
      await sleep(500);
      await observeAndPersist(ctx, '02b-app-context-resolved');
    }
    // Do not walk menus on an empty company workspace — that produces a false
    // "session completed successfully" with only picker/empty-state screenshots.
    if (appContext.detected && !appContext.skipped && await isEmptyCompanyPicker(page)) {
      throw new Error(
        'Company workspace is still unresolved after app-context resolution; '
        + 'refusing to walk menus with no company selected.',
      );
    }

    // Discover menus and visit session-relevant ones
    let menus = await scanMenus(page);
    let targets = appContext.skipped ? [] : selectMenuTargets(menus, job);
    if (!appContext.skipped && targets.length === 0 && menus.length > 0 && isSpecificMenuPath(job.session.menu_path)) {
      await appendLog({
        run_id: job.run_id,
        session_id: job.session.id,
        job_id: job.job_id,
        level: 'warn',
        message: `Menu path "${job.session.menu_path}" matched none of the ${menus.length} menu item(s) at ${page.url()} `
          + '— not falling back to unrelated menus; trying direct navigation instead.',
      }).catch(() => {});
    }

    // If still no menus, try direct URL from menu_path + capture each page
    let actionOrdinal = 3;
    if (targets.length === 0 && !appContext.skipped) {
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
          targets = selectMenuTargets(menus, job);
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

    const visitBudget = computeVisitBudget({
      expectedScreens: job.session.expected_screens,
      matchedCount: targets.length,
      safetyMax: config.maxScreensPerSession,
    });
    const { visitLimit } = visitBudget;
    estimatedScreens = visitBudget.estimated;
    await appendLog({
      run_id: job.run_id,
      session_id: job.session.id,
      job_id: job.job_id,
      message: `Visit budget: estimated_screens=${estimatedScreens}, matched_menus=${targets.length}, visit_limit=${visitLimit} (safety_max=${config.maxScreensPerSession})`,
    }).catch(() => {});
    if (visitBudget.truncated) {
      await appendLog({
        run_id: job.run_id,
        session_id: job.session.id,
        job_id: job.job_id,
        level: 'warn',
        message: `Matched menus truncated by safety max: matched_menus=${targets.length}, visit_limit=${visitLimit}, safety_max=${config.maxScreensPerSession}`,
      }).catch(() => {});
    }

    const attemptedLabels = new Set<string>();
    while (attemptedLabels.size < visitLimit && !appContext.skipped) {
      // Every iteration starts from current DOM state; selectors captured before
      // navigation or overlay changes are intentionally never reused.
      menus = await scanMenus(page);
      targets = selectMenuTargets(menus, job);
      const m = targets.find((item) => !attemptedLabels.has(normalizeLabel(item.label)));
      if (!m) break;
      attemptedLabels.add(normalizeLabel(m.label));

      const decision = evaluateClick(m.label, {
        destructiveAllowed: !!job.session.destructive_allowed,
        environment: job.profile.environment,
        allowSafeDemo: !!job.profile.allow_safe_demo,
        allowedActions,
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

        const opened = await openMenuWithRecovery(page, job, m, screenshotsDir);
        if (!opened) continue;
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

    if (targets.length === 0 && isSpecificMenuPath(job.session.menu_path)) {
      await appendLog({
        run_id: job.run_id,
        session_id: job.session.id,
        job_id: job.job_id,
        level: 'warn',
        message: `Session scope "${job.session.menu_path}" was never reached (no matching menu and no working direct URL) `
          + `on ${page.url()} — reporting no coverage for it instead of substituting unrelated menus.`,
      }).catch(() => {});
    } else if (screensObserved <= 2 && targets.length === 0) {
      await appendLog({
        run_id: job.run_id,
        session_id: job.session.id,
        job_id: job.job_id,
        level: 'warn',
        message: 'No navigable menu actions found after login — only login/landing screenshots were captured.',
      }).catch(() => {});
    }
    if (shouldRunFileIoSession(job.session.name, allowedActions)) {
      fileIoResults = await runFileIoScenarios({
        page,
        job,
        reportsDir,
        executionContext: {
          urls: screenUrls,
          titles: screenTitles,
          inventoryLabels: allInventory.map((item) => item.label),
        },
      });
      for (const test of fileIoResults.filter((row) => row.compare_status === 'fail')) {
        allUx.push({
          category: 'file_io',
          severity: 'high',
          title: `File I/O failed: ${test.scenario_key}`,
          description: String(test.evidence.download ?? test.evidence.upload ?? 'File fidelity check failed.'),
          recommendation: 'Fix the upload/download flow and preserve source structure and content.',
          human_summary: '',
          developer_prompt: '',
          evidence: { ...test.evidence, artifact_paths: test.artifact_paths },
        });
      }
    }
  } finally {
    consoleSink.detach();
    networkSink.detach();
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  if (screensObserved < estimatedScreens) {
    await appendLog({
      run_id: job.run_id,
      session_id: job.session.id,
      job_id: job.job_id,
      level: 'warn',
      message: `Coverage below planning estimate: screens_observed=${screensObserved}, estimated_screens=${estimatedScreens}`,
    }).catch(() => {});
  }

  // Gap detection once at end of session against the full inventory.
  // Prefer /worker/competitors; fall back to bundled samples/competitors catalogs.
  let benchmarks: CompetitorBenchmark[] = [];
  let catalogSource = 'none';
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
    benchmarks = rows.map((c) => {
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
    if (benchmarks.length > 0) catalogSource = 'api';
  } catch (err) {
    const msg = (err as Error).message;
    console.warn('[smoke-worker] benchmarks fetch failed:', msg);
    await appendLog({
      run_id: job.run_id,
      session_id: job.session.id,
      job_id: job.job_id,
      level: 'warn',
      message: `Feature gap benchmarks fetch failed: ${msg} — using bundled fallback catalogs`,
    }).catch(() => {});
  }

  if (benchmarks.length === 0) {
    benchmarks = fallbackCompetitorCatalogs(job.run.product_name);
    if (benchmarks.length > 0) catalogSource = 'bundled-fallback';
  }

  const heuristicGaps = detectGaps(job.run.product_name, allInventory, benchmarks, {
    sessionName: job.session.name,
    menuPath: job.session.menu_path,
    screensChecked: screenUrls,
  });
  await appendLog({
    run_id: job.run_id,
    session_id: job.session.id,
    job_id: job.job_id,
    message: `Feature gap scan: source=${catalogSource}, ${benchmarks.length} competitor catalog(s), ${allInventory.length} inventory item(s), ${heuristicGaps.length} gap(s)`,
  }).catch(() => {});
  if (benchmarks.length === 0) {
    await appendLog({
      run_id: job.run_id,
      session_id: job.session.id,
      job_id: job.job_id,
      level: 'warn',
      message: `No competitor benchmarks for product "${job.run.product_name}". Add Competitor Benchmarks in the portal.`,
    }).catch(() => {});
  }

  const brainEnriched = await enrichGaps(job.run.product_name, job.run.environment, heuristicGaps);
  const enriched = restoreGapContract(brainEnriched, heuristicGaps);
  linkGapVisualEvidence(enriched, screenUrls, screenshots);
  const promptContext: CursorPromptContext = {
    product_name: job.run.product_name,
    environment: job.run.environment,
    run_code: job.run.run_code,
    session_name: job.session.name,
    menu_path: job.session.menu_path,
  };
  const uxIssues = dedupeUxIssues(allUx);
  for (const issue of uxIssues) {
    issue.human_summary = buildUxHumanSummary(issue);
    issue.developer_prompt = buildUxCursorPrompt(issue, promptContext);
  }
  for (const gap of enriched) {
    gap.human_summary = buildFeatureGapHumanSummary(gap);
    gap.developer_prompt = buildFeatureGapCursorPrompt(gap, promptContext);
  }

  await recordUxIssues(uxIssues.map((i) => ({
    run_id:      job.run.id,
    session_id:  job.session.id,
    result_id:   i.result_id,
    category:    i.category,
    severity:    i.severity,
    title:       i.title,
    description: i.description,
    recommendation:  i.recommendation,
    human_summary: i.human_summary,
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
    confidence:       g.confidence,
    mode:             g.mode,
    recommendation:   g.recommendation,
    human_summary:     g.human_summary,
    developer_prompt: g.developer_prompt,
    notes:            g.notes,
    sources:          g.sources,
    evidence:         g.evidence,
  })));

  const completedAt = new Date().toISOString();
  await buildSessionReport({
    run: job.run,
    session: job.session,
    reportsDir,
    screensObserved,
    inventoryCount,
    uxIssues,
    featureGaps: enriched,
    screenshots,
    screenshotUrls: screenUrls,
    screenshotTitles: screenTitles,
    screenshotCapturedAt: screenCapturedAt,
    startedAt,
    completedAt,
    fileIoTests: fileIoResults,
  });

  await finalizeIfLast(job.run.id);

  return {
    started_at: startedAt,
    completed_at: completedAt,
    screens_observed: screensObserved,
    inventory_count: inventoryCount,
    ux_issues: uxIssues.length,
    feature_gaps: enriched.length,
    file_io_tests: fileIoResults.length,
  };
}

/**
 * Post-login gate: pull the session onto profile.base_url and fail the session
 * when it is still on another product host. Without this, a Books-biased "Jump
 * To" turns an HRMS run into a pile of Books screenshots that look successful.
 */
async function enforceProductHost(page: Page, job: Job): Promise<void> {
  const baseUrl = (job.profile.base_url || '').trim();
  if (!baseUrl) return;
  const allowedDomains = job.profile.allowed_domains;

  const landed = evaluateHostGuard({ currentUrl: page.url(), baseUrl, allowedDomains });
  if (landed.ok) return;

  await appendLog({
    run_id: job.run_id,
    session_id: job.session.id,
    job_id: job.job_id,
    level: 'warn',
    message: `Post-login host "${landed.actualHost || page.url()}" is not the profile host `
      + `"${landed.expectedHost}" — navigating to ${baseUrl}`,
  }).catch(() => {});

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await sleep(800);
  } catch (err) {
    await appendLog({
      run_id: job.run_id,
      session_id: job.session.id,
      job_id: job.job_id,
      level: 'warn',
      message: `Force-navigation to ${baseUrl} failed: ${(err as Error).message}`,
    }).catch(() => {});
  }

  const settled = evaluateHostGuard({ currentUrl: page.url(), baseUrl, allowedDomains });
  if (settled.ok) {
    await appendLog({
      run_id: job.run_id,
      session_id: job.session.id,
      job_id: job.job_id,
      message: `Recovered onto product host ${settled.actualHost} @ ${page.url()}`,
    }).catch(() => {});
    return;
  }

  throw new Error(
    `${settled.message} (profile "${job.profile.profile_name}", product "${job.profile.product_name}", `
    + `current url ${page.url()}). Check the login "Jump To" product for this profile.`,
  );
}

async function observeAndPersist(ctx: ObserveCtx, label: string): Promise<void> {
  const { job, page, reportsDir, screenshotsDir, allUx, allInventory, screenshots } = ctx;
  const meta = await scanPage(page);
  const inventory = await collectInventory(page);
  const shotPath = await captureScreenshot(page, screenshotsDir, label || meta.title || 'screen');
  screenshots.push(shotPath);
  ctx.screenUrls.push(meta.url);
  ctx.screenTitles.push(meta.module_name || meta.title || label || 'Untitled screen');
  ctx.screenCapturedAt.push(new Date().toISOString());
  for (const item of inventory) allInventory.push(item);
  // Consume only events emitted since the previous screen snapshot.
  const consoleEvents = ctx.consoleEvents.slice(ctx.consoleCursor);
  const networkEvents = ctx.networkEvents.slice(ctx.networkCursor);
  ctx.consoleCursor = ctx.consoleEvents.length;
  ctx.networkCursor = ctx.networkEvents.length;

  const resultId = await recordResult({
    run_id: job.run.id,
    session_id: job.session.id,
    screen_url: meta.url,
    screen_title: meta.title || label,
    module_name: meta.module_name || label,
    screenshot_path: shotPath,
    page_metadata: meta,
    console_errors: consoleEvents,
    network_errors: networkEvents,
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

  const issues = reviewPage({ meta, inventory, consoleEvents, networkEvents });
  for (const i of issues) {
    i.result_id = resultId;
    i.evidence = {
      ...i.evidence,
      affected_urls: [meta.url],
      screen_titles: [meta.module_name || meta.title || label],
      screenshot_paths: [shotPath],
      inventory_samples: relevantInventory(i, inventory),
      ...(consoleEvents.length ? { console_events: consoleEvents.slice(0, 10) } : {}),
      ...(networkEvents.length ? { network_events: networkEvents.slice(0, 10) } : {}),
    };
    allUx.push(i);
  }

  ctx.onScreenObserved();
  ctx.onInventoryRecorded(inventory.length);
  void reportsDir;
}

function filterMenusForSession(menus: MenuItem[], job: Job): MenuItem[] {
  const raw = (job.session.menu_path || '').toLowerCase().trim();
  if (!raw || raw === '/' || raw === '/menu/*' || raw === '*') return menus;

  const token = raw.replace(/\*/g, '').replace(/^\//, '').replace(/\/$/, '');
  const parts = token.split(/[/_-]+/).filter((p) => p.length > 1);

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

/** A session scoped to a concrete area (e.g. "/leave"), not a whole-app sweep. */
function isSpecificMenuPath(menuPath: string | null | undefined): boolean {
  const raw = (menuPath || '').trim().toLowerCase();
  if (!raw) return false;
  return raw !== '/' && raw !== '*' && raw !== '/menu/*';
}

function selectMenuTargets(menus: MenuItem[], job: Job): MenuItem[] {
  let targets = filterMenusForSession(menus, job);
  if (menus.length > 0 && targets.length === 0) targets = keywordMenusForSession(menus, job);
  if (menus.length > 0 && targets.length === 0) {
    // A specific menu_path that matches nothing usually means we are in the
    // wrong app; visiting every menu would report unrelated coverage as if the
    // session had succeeded. Leave it empty so direct navigation runs instead.
    if (isSpecificMenuPath(job.session.menu_path)) return [];
    targets = menus;
  }

  const rawPath = (job.session.menu_path || '').trim().toLowerCase();
  const broadLandingSession = !rawPath || rawPath === '/' || rawPath === '*' || rawPath === '/menu/*'
    || /login\s*\+?\s*dashboard/i.test(job.session.name);
  if (!broadLandingSession) return targets;

  return targets.filter((menu) => {
    const text = `${menu.label} ${menu.href}`;
    return !/\b(help|support|chat|live\s*chat|logout|log\s*out|sign\s*out)\b/i.test(text);
  });
}

async function openMenuWithRecovery(
  page: Page,
  job: Job,
  menu: MenuItem,
  screenshotsDir: string,
): Promise<boolean> {
  try {
    await clickCurrentMenu(page, menu);
    return true;
  } catch (firstError) {
    const overlayChanged = await dismissOverlays(page);
    const retried = await findMenuByLabel(page, menu.label);
    if (retried) {
      try {
        await clickCurrentMenu(page, retried);
        return true;
      } catch {
        // Continue to the single guarded force-click below.
      }
    }

    const forceTarget = await findMenuByLabel(page, menu.label);
    if (forceTarget && !forceTarget.href && !isRestrictedLabel(forceTarget.label).matched) {
      try {
        await page.locator(forceTarget.selector).first().click({ timeout: 8_000, force: true });
        await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {});
        return true;
      } catch {
        // The user decision is the final recovery path.
      }
    }

    const situationKey = `click_intercepted:${menu.label}`.slice(0, 191);
    const decisionOptions: DecisionOption[] = [
      { id: 'dismiss_and_retry', label: 'Dismiss the overlay and rescan menus', action: 'dismiss_overlay' },
      { id: 'skip_control', label: `Skip "${menu.label}"`, action: 'skip_target' },
      { id: 'rescan_menus', label: 'Rescan menus without clicking this target', action: 'rescan_menus' },
      ...(menu.href
        ? [{ id: 'navigate_href', label: `Navigate directly to "${menu.label}"`, action: 'navigate_href' as const, href: menu.href }]
        : []),
      { id: 'abort_session', label: 'Abort this session', action: 'abort_session' },
    ];
    const screenshotPath = await captureScreenshot(
      page,
      screenshotsDir,
      `decision-click-${slug(menu.label)}`,
    ).catch(() => undefined);
    const choice = await askOrRecallDecision({
      job,
      page,
      situationKey,
      question: `"${menu.label}" is still blocked after dismissing overlays and retrying. How should the smoke run proceed?`,
      options: decisionOptions,
      context: {
        target_label: menu.label,
        target_href: menu.href,
        click_error: (firstError as Error).message,
        overlay_changed: overlayChanged,
      },
      screenshotPath,
    });
    const action = await performNavAction(page, job, choice, { href: menu.href });
    if (action.skipped) return false;
    if (action.navigated) return true;

    if (action.rescan) {
      const finalTarget = await findMenuByLabel(page, menu.label);
      if (finalTarget) {
        try {
          await clickCurrentMenu(page, finalTarget);
          return true;
        } catch {
          return false;
        }
      }
    }
    return false;
  }
}

async function clickCurrentMenu(page: Page, menu: MenuItem): Promise<void> {
  if (menu.href && /^https?:/i.test(menu.href)) {
    await page.goto(menu.href, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  } else {
    await page.locator(menu.selector).first().click({ timeout: 10_000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {});
  }
}

async function findMenuByLabel(page: Page, label: string): Promise<MenuItem | undefined> {
  const normalized = normalizeLabel(label);
  return (await scanMenus(page)).find((item) => normalizeLabel(item.label) === normalized);
}

function normalizeLabel(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
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

function relevantInventory(issue: UxIssue, inventory: import('./scanner/uiInventory.js').InventoryEntry[]) {
  const preferredKinds = issue.category === 'navigation'
    ? ['menu', 'submenu', 'search']
    : issue.category === 'multi_tenant'
      ? ['company_selector', 'branch_selector', 'fy_selector', 'menu']
      : issue.category === 'reports'
        ? ['table', 'export', 'print', 'download']
        : issue.category === 'filters'
          ? ['table', 'filter']
          : ['button', 'form', 'table'];
  const preferred = inventory.filter((item) => preferredKinds.includes(item.kind));
  return (preferred.length ? preferred : inventory).slice(0, 10).map(({ kind, label, selector, url }) => ({
    kind, label, selector, url,
  }));
}

function linkGapVisualEvidence(gaps: FeatureGap[], screenUrls: string[], screenshots: string[]): void {
  for (const gap of gaps) {
    const nearby = gap.evidence.nearby_inventory ?? [];
    const relatedUrls = new Set([
      ...gap.evidence.screens_checked,
      ...nearby.map((item) => item.url).filter(Boolean),
    ]);
    const linked = screenUrls.flatMap((url, index) =>
      relatedUrls.has(url) && screenshots[index] ? [screenshots[index]!] : [],
    );
    gap.evidence.screenshot_paths = [...new Set(linked.length ? linked : screenshots.slice(0, 1))];
    gap.evidence.target_selectors = [...new Set(
      nearby.map((item) => item.selector).filter(Boolean),
    )].slice(0, 5);
  }
}

function restoreGapContract(enriched: FeatureGap[], heuristic: FeatureGap[]): FeatureGap[] {
  const defaults = new Map(heuristic.map((gap) => [gap.expected_feature.toLowerCase(), gap]));
  return enriched.map((gap) => {
    const base = defaults.get(String(gap.expected_feature).toLowerCase());
    return {
      ...base,
      ...gap,
      observed: base ? base.observed : gap.observed,
      partial: base ? base.partial : gap.partial,
      confidence: gap.confidence ?? base?.confidence ?? 'low',
      mode: gap.mode ?? base?.mode ?? 'validate_first',
      evidence: gap.evidence ?? base?.evidence ?? { sample_labels: [], screens_checked: [] },
      sources: Array.isArray(gap.sources) ? gap.sources : (base?.sources ?? []),
    };
  });
}
