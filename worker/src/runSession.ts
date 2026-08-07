import path from 'node:path';
import { chromium, firefox, webkit, type Browser, type BrowserContext, type Page } from 'playwright';
import { config } from './config.js';
import {
  recordResult, recordInventory, recordUxIssues, recordFeatureGaps,
  appendLog,
  type Job,
} from './backend.js';
import { isSignedIn, login } from './auth/login.js';
import { loadStorageState, saveStorageState } from './auth/sessionState.js';
import { scanPage } from './scanner/pageScanner.js';
import { collectInventory } from './scanner/uiInventory.js';
import { captureScreenshot } from './scanner/screenshotCapture.js';
import { attachConsoleCapture } from './scanner/consoleCapture.js';
import { attachNetworkCapture } from './scanner/networkCapture.js';
import { dedupeUxIssues, dropProvenShellUxIssues, reviewPage, type UxIssue } from './reviewer/uxReviewEngine.js';
import { countExpectedFeatures, detectGaps, type CompetitorBenchmark, type FeatureGap } from './reviewer/featureGapEngine.js';
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
import { loadRepoRules } from './reporter/repoAttribution.js';
import { parseAllowedActions } from './utils/safeActionGuard.js';
import { evaluateHostGuard } from './utils/hostGuard.js';
import { isOnCompanyPicker } from './nav/companyCards.js';
import type { ConsoleEvent } from './scanner/consoleCapture.js';
import type { NetworkEvent } from './scanner/networkCapture.js';
import { runFileIoScenarios, shouldRunFileIoSession } from './fileIo/fileIoEngine.js';
import type { FileIoTestResult } from './fileIo/types.js';
import { evaluateSessionCoverage } from './utils/sessionCoverage.js';
import { meaningfulScopeTokens, scopeTokensMatchUrl } from './utils/scopeMatch.js';
import { BrainUnavailableError, brainHealth } from './brain/ensemble.js';
import { runAgentLoop } from './agent/agentLoop.js';
import type { AgentStepRecord } from './agent/actions.js';
import { detectAgentFindings } from './agent/agentFindings.js';

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
  const health = await brainHealth().catch((error: unknown) => {
    throw new BrainUnavailableError('health', error instanceof Error ? error.message : String(error));
  });
  if (!health.vision_available) {
    throw new BrainUnavailableError('none', 'No configured vision-capable provider.');
  }

  const browser: Browser = await browserMap[config.playwright.browser].launch({
    headless: config.playwright.headless,
    slowMo: config.playwright.slowMo,
  });
  // Carry the run's signed-in state (and with it the selected company) into this
  // session, so only the first session of a run pays for a login and a company pick.
  const restoredState = loadStorageState(job);
  // Indian locale and timezone: a native date input renders in the browser's
  // locale, so without this a dd/mm/yyyy check would be measuring our own
  // container rather than the product.
  const context: BrowserContext = await browser.newContext({
    userAgent: config.playwright.userAgent,
    viewport: { width: 1440, height: 900 },
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    acceptDownloads: true,
    ...(restoredState ? { storageState: restoredState } : {}),
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
  // Screens reached under the session's own scope. Login and landing are captured
  // by every session and prove nothing, so they are deliberately excluded.
  let scopeScreens = 0;
  let workspaceSkipped = false;
  let inventoryCount = 0;
  let fileIoResults: FileIoTestResult[] = [];
  let estimatedScreens = 0;
  let agentSteps: AgentStepRecord[] = [];
  let loopStatus = 'budget';
  let createsVerified = 0;

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

    // Action 1: enter the app. With restored state that is the product itself;
    // otherwise it is the login page, captured as the session's first screen.
    const entryUrl = restoredState
      ? (job.profile.base_url?.trim() || job.profile.login_url)
      : job.profile.login_url;
    await page.goto(entryUrl, { waitUntil: 'domcontentloaded' });
    const reusedSignIn = restoredState ? await isSignedIn(page) : false;
    await observeAndPersist(ctx, reusedSignIn ? '01-restored-session' : '01-login-form');
    await appendLog({
      run_id: job.run_id,
      session_id: job.session.id,
      job_id: job.job_id,
      message: reusedSignIn
        ? `Reusing the signed-in session from earlier in this run (no re-login) — at ${page.url()}`
        : `Action screenshot: login form at ${page.url()}`,
    }).catch(() => {});

    if (!reusedSignIn) {
      if (restoredState) {
        await appendLog({
          run_id: job.run_id,
          session_id: job.session.id,
          job_id: job.job_id,
          level: 'warn',
          message: 'The signed-in state saved earlier in this run is no longer valid — signing in again.',
        }).catch(() => {});
      }
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
    }

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

    estimatedScreens = Math.max(1, job.session.expected_screens);
    const goal = `Smoke-test session "${job.session.name}". `
      + `Scope: ${job.session.menu_path || 'whole application'}. `
      + `${job.session.description || ''}`.trim();
    // Per-session override, clamped to the hard ceiling either way, so a bad
    // DB value can never exceed the safety cap nor drop below 1.
    const effectiveBudget = Math.max(
      1,
      Math.min(config.maxStepsCeiling, job.session.max_steps ?? config.maxScreensPerSession),
    );
    const loop = await runAgentLoop({
      page,
      job,
      goal,
      budget: effectiveBudget,
      screenshotsDir,
      onStep: async (step) => {
        await observeAndPersist(
          ctx,
          `agent-${String(step.ordinal).padStart(3, '0')}-${step.action.type}`,
          step.screenshot,
        );
        const label = step.target_label ? `"${step.target_label}"` : step.action.type;
        const change = step.signature_changed ? 'screen changed' : 'screen unchanged';
        const isRestrictedWrite = step.outcome === 'executed'
          && step.action.type === 'click'
          && Boolean(step.guard.matchedToken);
        // A restricted-write click is only worth a warn when the session was not
        // actually set up to create/submit — otherwise it is the session doing its
        // configured job, not a safety concern.
        const writeExpected = isRestrictedWrite && (
          allowedActions.length === 0
          || allowedActions.includes('create_record')
          || allowedActions.includes('submit_form')
        );
        const restrictedWrite = isRestrictedWrite && !writeExpected;
        const level = step.outcome === 'refused' || step.outcome === 'failed' || restrictedWrite
          ? 'warn'
          : 'info';
        const writeNote = isRestrictedWrite
          ? (writeExpected
            ? ` [expected write: ${step.guard.matchedToken}]`
            : ` [restricted write: ${step.guard.matchedToken}]`)
          : '';
        await appendLog({
          run_id: job.run_id,
          session_id: job.session.id,
          job_id: job.job_id,
          level,
          message: `Agent step ${step.ordinal}/${effectiveBudget}: ${step.action.type} ${label} -> ${step.outcome}, ${change}${writeNote} — ${step.observation || step.outcome_observation}`,
          context: {
            action: step.action,
            target_label: step.target_label,
            typed_value: step.typed_value,
            fill_results: step.fill_results,
            guard: step.guard,
            signature_changed: step.signature_changed,
            restricted_write: restrictedWrite,
          },
        }).catch(() => {});
      },
      onLoopWarning: async (message) => {
        await appendLog({
          run_id: job.run_id,
          session_id: job.session.id,
          job_id: job.job_id,
          level: 'warn',
          message,
        }).catch(() => {});
      },
      onFinding: (issue) => {
        allUx.push(issue);
        void appendLog({
          run_id: job.run_id,
          session_id: job.session.id,
          job_id: job.job_id,
          level: issue.severity === 'suggestion' ? 'info' : 'warn',
          message: `Agent finding (${issue.category}, ${issue.severity}): ${issue.title}`,
          context: { evidence: issue.evidence },
        }).catch(() => {});
      },
    });
    agentSteps = loop.steps;
    const agentFindings = detectAgentFindings(agentSteps);
    for (const finding of agentFindings) allUx.push(finding);
    scopeScreens = countScopeScreens(loop.steps, job.session.menu_path, job.session.name);
    workspaceSkipped = loop.status === 'blocked' || loop.status === 'operator';
    loopStatus = loop.status;
    createsVerified = loop.createdRecords.filter((record) => record.verifiedInList).length;
    await appendLog({
      run_id: job.run_id,
      session_id: job.session.id,
      job_id: job.job_id,
      level: loop.status === 'done' ? 'info' : 'warn',
      message: `Vision agent finished with ${loop.status}: ${loop.reason}`,
      context: { steps: loop.steps.length, goal },
    }).catch(() => {});

    // Ending on the picker says nothing about whether the workspace was ever
    // open earlier in the session: a session can open a company, do 38 screens
    // of real work, and simply route back through the picker on its way out (or
    // be misdetected there — see companyPicker.isPickerScreen). Zeroing
    // scopeScreens in that case would erase coverage the session actually
    // earned, so this only marks the workspace skipped when no in-scope screen
    // was reached at all; otherwise it is a no-op beyond skipping the
    // storage-state save, since a picker is not a signed-into-workspace state
    // worth persisting.
    const endedOnPicker = await isOnCompanyPicker(page);
    if (endedOnPicker && scopeScreens === 0) {
      workspaceSkipped = true;
      await appendLog({
        run_id: job.run_id,
        session_id: job.session.id,
        job_id: job.job_id,
        level: 'warn',
        message: `Vision agent ended while still on the company picker (${page.url()}); reporting no scope coverage.`,
      }).catch(() => {});
    } else if (endedOnPicker) {
      await appendLog({
        run_id: job.run_id,
        session_id: job.session.id,
        job_id: job.job_id,
        message: `Vision agent ended on the company picker (${page.url()}) after ${scopeScreens} in-scope `
          + 'screen(s) earlier in the session; that coverage stands.',
      }).catch(() => {});
    }
    if (!endedOnPicker) {
      await saveStorageState(context, job).catch(async (err: unknown) => {
        await appendLog({
          run_id: job.run_id,
          session_id: job.session.id,
          job_id: job.job_id,
          level: 'warn',
          message: `Could not save the signed-in state for later sessions: ${(err as Error).message}`,
        }).catch(() => {});
      });
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

  const coverage = evaluateSessionCoverage({
    scopeScreens,
    menuPath: job.session.menu_path,
    workspaceSkipped,
    creates_verified: createsVerified,
    loop_status: loopStatus,
  });
  if (coverage.status === 'blocked') {
    await appendLog({
      run_id: job.run_id,
      session_id: job.session.id,
      job_id: job.job_id,
      level: 'warn',
      message: `No coverage for this session: ${coverage.reason}. Reporting it as blocked rather than passed.`,
    }).catch(() => {});
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
    pageTitles: screenTitles,
    moduleNames: screenTitles,
  });
  // detectGaps now drops fully-observed rows entirely, so heuristicGaps.length
  // already equals the not-observed count; report both it and the total expected
  // count so "K gaps" cannot be mistaken for "K observed features".
  const expectedFeatureCount = countExpectedFeatures(job.run.product_name, benchmarks);
  await appendLog({
    run_id: job.run_id,
    session_id: job.session.id,
    job_id: job.job_id,
    message: `Feature gap scan: source=${catalogSource}, ${benchmarks.length} competitor catalog(s), `
      + `${allInventory.length} inventory item(s), ${expectedFeatureCount} expected feature(s) evaluated, `
      + `${heuristicGaps.length} not observed`,
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
    repo_rules: loadRepoRules(),
  };
  const allInventoryLabels = allInventory.map((item) => item.label);
  const uxIssues = dropProvenShellUxIssues(dedupeUxIssues(allUx), allInventoryLabels);
  for (const issue of uxIssues) {
    issue.human_summary = buildUxHumanSummary(issue);
    issue.developer_prompt = buildUxCursorPrompt(issue, promptContext);
  }
  for (const gap of enriched) {
    gap.human_summary = buildFeatureGapHumanSummary(gap);
    gap.developer_prompt = buildFeatureGapCursorPrompt(gap, promptContext);
  }

  const uxPersist = await recordUxIssues(uxIssues.map((i) => ({
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
  const gapPersist = await recordFeatureGaps(enriched.map((g) => ({
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

  const persistFailures = [
    ...uxPersist.failures.map((f) => `ux-issues[${f.index}] ${f.status ?? '?'}: ${f.message}`),
    ...gapPersist.failures.map((f) => `feature-gaps[${f.index}] ${f.status ?? '?'}: ${f.message}`),
  ];
  if (persistFailures.length) {
    await appendLog({
      run_id: job.run_id,
      session_id: job.session.id,
      job_id: job.job_id,
      level: 'warn',
      message: `Finding persist soft-failed (${persistFailures.length} row(s)); session will still complete. `
        + persistFailures.slice(0, 3).join(' | '),
      context: {
        ux_saved: uxPersist.saved,
        ux_attempted: uxPersist.attempted,
        gaps_saved: gapPersist.saved,
        gaps_attempted: gapPersist.attempted,
        sample: persistFailures.slice(0, 5),
      },
    }).catch(() => {});
  }

  const completedAt = new Date().toISOString();
  await buildSessionReport({
    run: job.run,
    session: job.session,
    reportsDir,
    screensObserved,
    inventoryCount,
    uxIssues,
    featureGaps: enriched,
    allInventoryLabels,
    screenshots,
    screenshotUrls: screenUrls,
    screenshotTitles: screenTitles,
    screenshotCapturedAt: screenCapturedAt,
    startedAt,
    completedAt,
    fileIoTests: fileIoResults,
    coverage,
    agentSteps,
    createsVerified,
    loopStatus,
  });

  await finalizeIfLast(job.run.id);

  return {
    started_at: startedAt,
    completed_at: completedAt,
    coverage: coverage.status,
    coverage_reason: coverage.reason,
    screens_observed: screensObserved,
    scope_screens: scopeScreens,
    inventory_count: inventoryCount,
    ux_issues: uxIssues.length,
    feature_gaps: enriched.length,
    file_io_tests: fileIoResults.length,
    agent_steps: agentSteps,
    creates_verified: createsVerified,
    loop_status: loopStatus,
    persist_warnings: {
      count: persistFailures.length,
      ux_saved: uxPersist.saved,
      ux_attempted: uxPersist.attempted,
      gaps_saved: gapPersist.saved,
      gaps_attempted: gapPersist.attempted,
      sample: persistFailures.slice(0, 5),
    },
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

async function observeAndPersist(ctx: ObserveCtx, label: string, existingScreenshot?: string): Promise<void> {
  const { job, page, reportsDir, screenshotsDir, allUx, allInventory, screenshots } = ctx;
  const meta = await scanPage(page);
  const inventory = await collectInventory(page);
  const shotPath = existingScreenshot
    || await captureScreenshot(page, screenshotsDir, label || meta.title || 'screen');
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
      // Runtime blobs only aid error findings; keep UX categories lean.
      ...(i.category === 'errors' && consoleEvents.length ? { console_events: consoleEvents.slice(0, 10) } : {}),
      ...(i.category === 'errors' && networkEvents.length ? { network_events: networkEvents.slice(0, 10) } : {}),
    };
    allUx.push(i);
  }

  ctx.onScreenObserved();
  ctx.onInventoryRecorded(inventory.length);
  void reportsDir;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


/**
 * Counts only executed agent steps whose resulting screen carries a meaningful
 * token overlap with the session's declared scope (menu_path or session name).
 * Whole-app sessions (Login + Dashboard: empty/'/' menu_path) have no
 * meaningful scope to filter by, so every executed step counts, as before.
 */
function countScopeScreens(steps: AgentStepRecord[], menuPath: string, sessionName: string): number {
  const scope = (menuPath ?? '').trim();
  const executed = steps.filter((step) => step.outcome === 'executed');
  if (!scope || scope === '/') return executed.length;
  const scopeTokens = meaningfulScopeTokens(`${scope} ${sessionName ?? ''}`);
  if (!scopeTokens.length) return executed.length;
  return executed.filter((step) => {
    const url = step.signature_after?.url || step.signature_before?.url || '';
    return scopeTokensMatchUrl(scopeTokens, url);
  }).length;
}

function relevantInventory(issue: UxIssue, inventory: import('./scanner/uiInventory.js').InventoryEntry[]) {
  const preferredKinds = issue.category === 'navigation'
    ? ['menu', 'submenu', 'search']
    : issue.category === 'multi_tenant'
      ? ['company_selector', 'branch_selector', 'fy_selector', 'menu']
      : issue.category === 'reports'
        ? ['table', 'export', 'print', 'download']
        : issue.category === 'filters'
          ? ['table', 'filter', 'search']
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
