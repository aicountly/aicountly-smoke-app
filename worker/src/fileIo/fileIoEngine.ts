import path from 'node:path';
import type { Page } from 'playwright';
import { config } from '../config.js';
import { appendLog, recordFileIoTest, type Job } from '../backend.js';
import { askOrRecallDecision } from '../nav/askDecision.js';
import { evaluateFileActionContract, parseAllowedActions, type FileAction } from '../utils/safeActionGuard.js';
import type { GuardContext, GuardDecision } from '../utils/safeActionGuard.js';
import { compareArtifacts, inspectExportArtifact } from './compareArtifacts.js';
import { downloadArtifact } from './downloadHelper.js';
import { materializeFixture, scenariosForProduct } from './fixtureFactory.js';
import { reviewFileQuality } from './fileQualityBrain.js';
import type {
  ArtifactComparison,
  FileIoExecutionContext,
  FileIoScenario,
  FileIoTestResult,
} from './types.js';
import { uploadFixture } from './uploadHelper.js';

const FILE_ACTIONS: FileAction[] = [
  'upload_file', 'import_file', 'download_file', 'export_file', 'compare_file',
];

export async function runFileIoScenarios(input: {
  page: Page;
  job: Job;
  reportsDir: string;
  executionContext: FileIoExecutionContext;
}): Promise<FileIoTestResult[]> {
  const { page, job, reportsDir, executionContext } = input;
  const scenarios = scenariosForProduct(config.repoRoot, job.run.product_name);
  const allowedActions = parseAllowedActions(job.session.allowed_actions_json);
  const guardContext = {
    environment: job.profile.environment,
    allowSafeDemo: !!job.profile.allow_safe_demo,
    destructiveAllowed: !!job.session.destructive_allowed,
    allowedActions,
  };
  const results: FileIoTestResult[] = [];

  for (const scenario of scenarios) {
    if (!scenarioMatchesContext(scenario, executionContext)) {
      await appendLog({
        run_id: job.run.id,
        session_id: job.session.id,
        job_id: job.job_id,
        message: `File I/O ${scenario.key}: skipped because menu_hints did not match this session`,
        context: { menu_hints: scenario.menu_hints, context_scope: executionContext },
      }).catch(() => {});
      continue;
    }
    const gate = evaluateScenarioGate(scenario, guardContext);
    if (!gate.allowed) {
      const reason = gate.reason;
      const skipped = baseResult(scenario, reason?.includes('production') ? 'blocked' : 'skipped', reason ?? 'File action blocked.');
      await persist(job, skipped);
      results.push(skipped);
      continue;
    }

    const fixture = scenario.kind === 'export'
      ? undefined
      : materializeFixture(config.repoRoot, reportsDir, scenario);
    let uploadOk = false;
    let downloadOk = false;
    const evidence: Record<string, unknown> = {};

    if (scenario.kind === 'upload' || scenario.kind === 'import' || scenario.kind === 'round_trip') {
      if (!fixture) throw new Error(`Scenario ${scenario.key} requires a fixture.`);
      const choice = await askOrRecallDecision({
        job,
        page,
        situationKey: `upload_confirm:${job.run.product_name}:${slug(job.session.name)}`.slice(0, 191),
        question: `Upload synthetic fixture "${fixture.name}" to ${job.run.product_name} ${job.session.name}?`,
        options: [
          { id: 'approve_upload', label: 'Approve this synthetic upload', action: 'approve_upload' },
          { id: 'skip_upload', label: 'Skip file upload', action: 'skip_target' },
        ],
        context: { scenario_key: scenario.key, fixture_name: fixture.name, synthetic: true },
      });
      if (choice.option.id !== 'approve_upload') {
        const skipped = baseResult(scenario, 'skipped', 'Operator skipped upload.');
        skipped.artifact_paths.fixture = fixture.runPath;
        await persist(job, skipped);
        results.push(skipped);
        continue;
      }
      const upload = await uploadFixture(page, fixture.runPath);
      uploadOk = upload.ok;
      evidence.upload = upload;
    }

    let downloadedPath: string | undefined;
    if (scenario.kind === 'export' || scenario.kind === 'round_trip') {
      const download = await downloadArtifact(page, path.join(reportsDir, 'downloads'), scenario.key);
      downloadOk = download.ok;
      downloadedPath = download.path;
      evidence.download = download;
    }

    const workflowSucceeded = scenario.kind === 'upload' || scenario.kind === 'import' ? uploadOk : downloadOk;
    let result: FileIoTestResult = {
      scenario_key: scenario.key,
      direction: scenario.kind === 'round_trip' ? 'round_trip' : scenario.kind === 'export' ? 'download' : 'upload',
      fixture_name: fixture?.name ?? path.basename(scenario.fixture),
      upload_ok: uploadOk,
      download_ok: downloadOk,
      compare_status: workflowSucceeded
        ? (scenario.kind === 'upload' || scenario.kind === 'import' ? 'not_applicable' : 'partial')
        : 'fail',
      artifact_paths: {
        ...(fixture ? { fixture: fixture.runPath } : {}),
        ...(downloadedPath ? { downloaded: downloadedPath } : {}),
      },
      evidence: {
        ...evidence,
        workflow_status: workflowSucceeded ? 'success' : 'failed',
        comparison_performed: false,
      },
    };
    if (downloadedPath) {
      const comparison = evaluateDownloadedArtifact(scenario, fixture?.runPath ?? '', downloadedPath);
      result = { ...result, ...comparison, compare_status: comparison.status };
      result.evidence.expected_mime = scenario.expected_mime;
      result.evidence.mime_expected = scenario.expected_mime.length === 0
        || scenario.expected_mime.includes(comparison.result_mime);
      result.evidence.comparison_performed = scenario.kind === 'round_trip';
      result.evidence.validation_mode = scenario.kind === 'export' ? 'export_structure' : 'round_trip_fidelity';
      const quality = await reviewFileQuality({
        product: job.run.product_name,
        environment: job.run.environment,
        scenario,
        artifactPath: downloadedPath,
        comparison,
      }).catch(() => undefined);
      if (quality) {
        result.ai_scores = quality.scores;
        result.ai_verdict = quality.verdict;
        result.ai_recommendations = quality.recommendations;
        result.competitor_refs = quality.competitor_refs;
        result.evidence.quality_gaps = quality.gaps;
      }
    }
    await persist(job, result);
    results.push(result);
  }
  return results;
}

function requiredAction(scenario: FileIoScenario): FileAction {
  if (scenario.kind === 'upload') return 'upload_file';
  if (scenario.kind === 'import') return 'import_file';
  if (scenario.kind === 'export') return 'export_file';
  return 'upload_file';
}

export function evaluateScenarioGate(scenario: FileIoScenario, context: GuardContext): GuardDecision {
  const required: FileAction[] = [requiredAction(scenario)];
  if (scenario.kind === 'round_trip') required.push('download_file', 'compare_file');
  if (scenario.kind === 'export') required.push('compare_file');
  return evaluateFileActionContract(required, context);
}

export function shouldRunFileIoSession(sessionName: string, allowedActions: string[]): boolean {
  return /\bfile\s*i\s*\/?\s*o\b/i.test(sessionName)
    || allowedActions.some((action) => FILE_ACTIONS.includes(action as FileAction));
}

export function scenarioMatchesContext(
  scenario: FileIoScenario,
  context: FileIoExecutionContext,
): boolean {
  if (scenario.menu_hints.length === 0) return true;
  const haystack = [...context.urls, ...context.titles, ...context.inventoryLabels]
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');
  return scenario.menu_hints.some((hint) => {
    const normalizedHint = hint.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return normalizedHint !== '' && haystack.includes(normalizedHint);
  });
}

export function evaluateDownloadedArtifact(
  scenario: FileIoScenario,
  fixturePath: string,
  downloadedPath: string,
): ArtifactComparison {
  if (scenario.kind === 'export') {
    return inspectExportArtifact(downloadedPath, scenario.expected_mime);
  }
  const comparison = compareArtifacts(fixturePath, downloadedPath);
  const mimeExpected = scenario.expected_mime.length === 0 || scenario.expected_mime.includes(comparison.result_mime);
  if (!mimeExpected) {
    comparison.status = 'fail';
    comparison.structure_ok = false;
    comparison.structure_notes += ` Result MIME ${comparison.result_mime} is outside expected MIME list: ${scenario.expected_mime.join(', ')}.`;
  }
  return comparison;
}

function baseResult(scenario: FileIoScenario, status: 'skipped' | 'blocked', reason: string): FileIoTestResult {
  return {
    scenario_key: scenario.key,
    direction: scenario.kind === 'round_trip' ? 'round_trip' : scenario.kind === 'export' ? 'download' : 'upload',
    fixture_name: path.basename(scenario.fixture),
    upload_ok: false,
    download_ok: false,
    compare_status: status,
    artifact_paths: {},
    evidence: { gate_reason: reason },
  };
}

async function persist(job: Job, result: FileIoTestResult): Promise<void> {
  await recordFileIoTest({
    run_id: job.run.id,
    session_id: job.session.id,
    product_name: job.run.product_name,
    ...result,
  });
  await appendLog({
    run_id: job.run.id,
    session_id: job.session.id,
    job_id: job.job_id,
    level: result.compare_status === 'fail' || result.compare_status === 'blocked' ? 'warn' : 'info',
    message: `File I/O ${result.scenario_key}: ${result.compare_status}`,
    context: result.evidence,
  }).catch(() => {});
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
