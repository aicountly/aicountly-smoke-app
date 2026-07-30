import fs from 'node:fs';
import path from 'node:path';
import { backend, recordReport } from '../backend.js';
import type { SessionRow, RunRow } from '../backend.js';
import type { UxIssue } from '../reviewer/uxReviewEngine.js';
import type { FeatureGap } from '../reviewer/featureGapEngine.js';
import { buildCursorPromptPack, type CursorPromptContext } from './cursorPromptBuilder.js';
import type { FileIoTestResult } from '../fileIo/types.js';
import type { SessionCoverage } from '../utils/sessionCoverage.js';
import type { AgentStepRecord } from '../agent/actions.js';

export type SessionDecision = {
  id?: number;
  situation_key?: string;
  question?: string;
  status?: string;
  source?: string;
  selected_option?: string | null;
  free_text?: string | null;
  remember?: boolean;
  answered_at?: string | null;
  screenshot_path?: string | null;
  options?: Array<{ id?: string; label?: string }>;
  context?: Record<string, unknown>;
};

export type SessionReportInput = {
  run: RunRow;
  session: SessionRow;
  reportsDir: string;
  screensObserved: number;
  inventoryCount: number;
  uxIssues: UxIssue[];
  featureGaps: FeatureGap[];
  screenshots: string[];
  /** Parallel to `screenshots` by index; screen URL captured alongside each shot, when known. */
  screenshotUrls?: string[];
  /** Parallel to `screenshots` by index; screen/module title captured alongside each shot, when known. */
  screenshotTitles?: string[];
  /** Parallel to `screenshots` by index; ISO capture timestamp, when known. */
  screenshotCapturedAt?: string[];
  decisions?: SessionDecision[];
  fileIoTests?: FileIoTestResult[];
  startedAt: string;
  completedAt: string;
  coverage?: SessionCoverage;
  agentSteps?: AgentStepRecord[];
  createsVerified?: number;
  loopStatus?: string;
};

export type ScreenshotCard = {
  screen_title: string;
  screen_url: string;
  captured_at: string;
  image_data_uri: string;
};

/**
 * Persists per-session JSON+HTML reports under the run's reports_dir and
 * registers them with the backend.
 *
 * Screenshots are embedded as data URIs in HTML so the Reports page iframe
 * (srcDoc) can display them without a file base URL.
 */
export async function buildSessionReport(input: SessionReportInput): Promise<{ html_path: string; json_path: string; cursor_prompts_path: string; report_id: number }> {
  const { run, session, reportsDir } = input;
  const sessionsDir = path.join(reportsDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });

  const sevSummary = countBy(input.uxIssues.map((i) => i.severity));
  const shotDataUris = input.screenshots
    .map((s) => toDataUri(s))
    .filter((s): s is string => Boolean(s));
  const screenshotCards: ScreenshotCard[] = input.screenshots.map((shotPath, i) => ({
    screen_title: input.screenshotTitles?.[i]?.trim() || `Screen ${i + 1}`,
    screen_url: input.screenshotUrls?.[i] ?? '',
    captured_at: input.screenshotCapturedAt?.[i] ?? '',
    image_data_uri: toDataUri(shotPath) ?? '',
  })).filter((card) => card.image_data_uri !== '');

  const promptContext: CursorPromptContext = {
    product_name: run.product_name,
    environment: run.environment,
    run_code: run.run_code,
    session_name: session.name,
    menu_path: session.menu_path,
  };
  const cursorPrompts = buildCursorPromptPack(promptContext, input.uxIssues, input.featureGaps);
  const decisions = input.decisions
    ?? await fetchSessionDecisions(run.id, session.id).catch(() => [] as SessionDecision[]);
  const decisionCards = decisions.map((decision) => formatDecisionCard(decision));
  const payload = {
    run_code: run.run_code,
    session_id: session.id,
    session_name: session.name,
    menu_path: session.menu_path,
    product_name: run.product_name,
    environment: run.environment,
    started_at: input.startedAt,
    completed_at: input.completedAt,
    status: input.coverage?.status === 'blocked'
      ? 'blocked'
      : input.coverage?.status === 'partial'
        ? 'partial'
        : 'done',
    coverage_reason: input.coverage?.reason ?? '',
    screens_observed: input.screensObserved,
    estimated_screens: session.expected_screens,
    inventory_count: input.inventoryCount,
    ux_issues: input.uxIssues,
    feature_gaps: input.featureGaps,
    file_io_tests: input.fileIoTests ?? [],
    decisions: decisionCards,
    agent_steps: input.agentSteps ?? [],
    creates_verified: input.createsVerified ?? 0,
    loop_status: input.loopStatus ?? '',
    severity_summary: sevSummary,
    screenshots: input.screenshots,
    screenshot_data_uris: shotDataUris,
    screenshot_cards: screenshotCards,
    cursor_prompts: cursorPrompts,
    generated_at: new Date().toISOString(),
  };

  const slug = session.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const base = path.join(sessionsDir, `${String(session.ordinal).padStart(2, '0')}-${slug}`);
  const jsonPath = base + '.json';
  const htmlPath = base + '.html';
  const cursorPromptsPath = base + '.cursor-prompts.md';
  const payloadWithArtifact = { ...payload, cursor_prompts_path: cursorPromptsPath };
  fs.writeFileSync(jsonPath, JSON.stringify(payloadWithArtifact, null, 2), 'utf8');
  fs.writeFileSync(htmlPath, renderSessionHtml(payloadWithArtifact), 'utf8');
  fs.writeFileSync(cursorPromptsPath, cursorPrompts, 'utf8');

  const uxScore = scoreUx(sevSummary, Math.max(1, input.screensObserved));

  const reportId = await recordReport({
    run_id: run.id,
    session_id: session.id,
    kind: 'session',
    title: `Session report: ${session.name}`,
    severity_summary: sevSummary,
    metrics: {
      screens_observed: input.screensObserved,
      estimated_screens: session.expected_screens,
      inventory_count: input.inventoryCount,
      ux_issues: input.uxIssues.length,
      feature_gaps: input.featureGaps.length,
      file_io_tests: input.fileIoTests?.length ?? 0,
      cursor_prompts_path: cursorPromptsPath,
    },
    ux_score: uxScore,
    html_path: htmlPath,
    json_path: jsonPath,
    auditor_visible: false,
  });

  return { html_path: htmlPath, json_path: jsonPath, cursor_prompts_path: cursorPromptsPath, report_id: reportId };
}

type SeveritySummary = { critical: number; high: number; medium: number; low: number; suggestion: number };

function countBy(arr: string[]): SeveritySummary {
  const o: SeveritySummary = { critical: 0, high: 0, medium: 0, low: 0, suggestion: 0 };
  for (const v of arr) {
    if (v in o) (o as Record<string, number>)[v] = (o as Record<string, number>)[v] + 1;
  }
  return o;
}

function scoreUx(sev: SeveritySummary, denom: number): number {
  const w = { critical: 5, high: 3, medium: 1.5, low: 0.5, suggestion: 0.1 } as Record<string, number>;
  let p = 0;
  for (const [k, n] of Object.entries(sev)) p += (w[k] ?? 0) * (n as number);
  const score = 100 - (p * 100) / Math.max(1, denom * 5);
  return Math.round(Math.max(0, Math.min(100, score)) * 100) / 100;
}

function toDataUri(filePath: string): string | null {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const buf = fs.readFileSync(filePath);
    if (buf.length === 0) return null;
    const ext = path.extname(filePath).toLowerCase();
    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

export function renderSessionHtml(p: {
  run_code: string;
  session_name: string;
  menu_path: string;
  product_name: string;
  environment: string;
  status: string;
  coverage_reason?: string;
  screens_observed: number;
  estimated_screens: number;
  inventory_count: number;
  severity_summary: SeveritySummary;
  ux_issues: UxIssue[];
  feature_gaps: FeatureGap[];
  file_io_tests: FileIoTestResult[];
  decisions?: ReturnType<typeof formatDecisionCard>[];
  agent_steps?: AgentStepRecord[];
  creates_verified?: number;
  loop_status?: string;
  screenshot_data_uris: string[];
  screenshot_cards?: ScreenshotCard[];
  cursor_prompts: string;
  generated_at: string;
}): string {
  const issueCards = p.ux_issues.map((issue) => findingCard({
    title: issue.title,
    severity: issue.severity,
    meta: issue.category,
    humanSummary: issue.human_summary || issue.recommendation,
    technicalRecommendation: issue.recommendation,
    developerPrompt: issue.developer_prompt,
    evidence: issue.evidence,
    expectation: issue.recommendation,
  })).join('') || emptyCard('No UX issues recorded.');
  const gapCards = p.feature_gaps.map((gap) => findingCard({
    title: gap.expected_feature,
    severity: gap.severity,
    meta: `${gap.mode} · ${gap.confidence} confidence`,
    humanSummary: gap.human_summary || gap.recommendation,
    technicalRecommendation: gap.recommendation,
    developerPrompt: gap.developer_prompt,
    evidence: gap.evidence,
    expectation: gap.mode === 'validate_first'
      ? 'Confirm existing coverage and product scope before implementation.'
      : gap.recommendation,
    validateFirst: gap.mode === 'validate_first',
  })).join('') || emptyCard('No feature gaps recorded.');
  const decisionCards = (p.decisions ?? []).map(decisionCard).join('')
    || emptyCard('No mid-run decisions were required for this session.');
  const fileIoRows = p.file_io_tests.map((test) => `<tr><td>${esc(test.scenario_key)}</td><td>${esc(test.direction)}</td><td>${esc(fileIoStatusLabel(test))}</td><td>${esc(test.ai_scores?.overall ?? '—')}</td><td>${esc(test.ai_verdict ?? '')}</td></tr>`).join('');
  const cards: ScreenshotCard[] = p.screenshot_cards && p.screenshot_cards.length
    ? p.screenshot_cards
    : p.screenshot_data_uris.map((src, i) => ({
        screen_title: `Screen ${i + 1}`,
        screen_url: '',
        captured_at: '',
        image_data_uri: src,
      }));
  const shots = cards.length
    ? cards.map(screenshotCard).join('')
    : `<p style="color:#64748b">No screenshots available (files missing on disk or capture failed).</p>`;
  const timeline = (p.agent_steps ?? []).map(agentStepCard).join('')
    || emptyCard('No vision-agent steps were recorded.');
  const uxPrompts = p.ux_issues.map((issue) => `<h4>${esc(issue.title)}</h4><pre><code>${esc(issue.developer_prompt || 'No developer prompt available.')}</code></pre>`).join('')
    || '<p>No UX issue prompts recorded.</p>';
  const gapPrompts = p.feature_gaps.map((gap) => `<h4>${esc(gap.expected_feature)}</h4><pre><code>${esc(gap.developer_prompt || 'No developer prompt available.')}</code></pre>`).join('')
    || '<p>No feature gap prompts recorded.</p>';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(p.run_code)} / ${esc(p.session_name)}</title>
<style>body{font:14px/1.55 system-ui;color:#0f172a;background:#f8fafc;margin:0;padding:32px}main{max-width:1100px;margin:auto}
h1{color:#059669}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.findings{display:grid;gap:16px}
.card,.finding{border:1px solid #e2e8f0;border-radius:12px;padding:18px;background:#fff;position:relative}.card .v{font-size:24px;font-weight:700}
.finding h3{margin:4px 0}.summary{white-space:pre-wrap}.badge{display:inline-block;padding:2px 8px;border-radius:999px;background:#ecfdf5;color:#065f46;font-size:12px}
.ribbon{position:absolute;right:0;top:0;padding:5px 12px;border-radius:0 12px 0 10px;background:#fef3c7;color:#92400e;font-weight:700}
.visual{display:grid;grid-template-columns:minmax(180px,320px) 1fr;gap:14px;margin-top:14px;padding:12px;border-left:4px solid #10b981;background:#f0fdf4;border-radius:8px}
.visual img,.shots img{max-width:100%;border:1px solid #cbd5e1;border-radius:7px}.visual p{margin:3px 0}.muted{color:#64748b}
details{margin-top:14px}summary{cursor:pointer;font-weight:650}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#0f172a;color:#e2e8f0;border-radius:8px;padding:14px}
.shots{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}
.shot{margin:0;padding:10px;border:1px solid #e2e8f0;border-radius:10px;background:#fff}
.shot img{display:block;width:100%;border:1px solid #cbd5e1;border-radius:7px}
.shot figcaption{margin-top:8px;overflow-wrap:anywhere;font-size:13px}
.timeline{display:grid;gap:14px}.step{display:grid;grid-template-columns:52px minmax(220px,360px) 1fr;gap:14px;align-items:start}
.step-no{width:38px;height:38px;border-radius:999px;background:#059669;color:white;display:grid;place-items:center;font-weight:700}
.step img{width:100%;border:1px solid #cbd5e1;border-radius:7px}.step p{margin:3px 0}
.blocked{border:1px solid #f0c36d;background:#fdf6e3;border-radius:8px;padding:10px 12px}
@media(max-width:760px){.grid{grid-template-columns:repeat(2,1fr)}.visual{grid-template-columns:1fr}}</style></head><body><main>
<h1>${esc(p.run_code)} - ${esc(p.session_name)}</h1>
<p><strong>Product:</strong> ${esc(p.product_name)} &middot; <strong>Env:</strong> ${esc(p.environment)} &middot; <strong>Status:</strong> ${esc(p.status)}<br>
<strong>Menu path:</strong> ${esc(p.menu_path)}</p>
${p.status === 'blocked'
  ? `<p class="blocked"><strong>No coverage:</strong> this session never tested its scope${
      p.coverage_reason ? ` — ${esc(p.coverage_reason)}` : ''
    }. Treat the findings below as incomplete.</p>`
  : p.status === 'partial'
    ? `<p class="blocked"><strong>Partial coverage:</strong> this session saw in-scope screens but did not finish cleanly${
        p.coverage_reason ? ` — ${esc(p.coverage_reason)}` : ''
      }.</p>`
    : ''}
<div class="grid">
  <div class="card"><div>Screens</div><div class="v">Observed ${p.screens_observed} (est. ${p.estimated_screens})</div></div>
  <div class="card"><div>UI items catalogued</div><div class="v">${p.inventory_count}</div></div>
  <div class="card"><div>Critical UX</div><div class="v">${p.severity_summary.critical}</div></div>
  <div class="card"><div>High UX</div><div class="v">${p.severity_summary.high}</div></div>
  <div class="card"><div>Creates verified</div><div class="v">${p.creates_verified ?? 0}</div></div>
  <div class="card"><div>Loop status</div><div class="v">${esc(p.loop_status || '—')}</div></div>
</div>
<h2>Decisions taken</h2><p class="muted">Choices made while the worker was blocked, including remembered answers applied automatically.</p>
<div class="findings">${decisionCards}</div>
<h2>Agent step timeline</h2><p class="muted">Every action, safety verdict, model rationale, and resulting screen.</p>
<div class="timeline">${timeline}</div>
<h2>What to fix now</h2><p class="muted">Start with the plain-language recommendation in each card. Technical prompts are collapsed until needed.</p>
<h2>UX issues</h2><div class="findings">${issueCards}</div>
<h2>Feature gaps</h2><div class="findings">${gapCards}</div>
<h2>File I/O tests</h2><table><thead><tr><th>Scenario</th><th>Direction</th><th>Result</th><th>AI quality</th><th>Verdict</th></tr></thead><tbody>${fileIoRows || '<tr><td colspan="5">No File I/O tests ran.</td></tr>'}</tbody></table>
<h2>Export quality vs competitors</h2><p class="muted">Quality scores are produced from file fidelity evidence and configured competitor standards.</p>
<details><summary>Technical details (for developers)</summary>
<h3>UX issue implementation prompts</h3>${uxPrompts}
<h3>Feature gap implementation prompts</h3>${gapPrompts}
<h3>Complete Cursor prompt pack</h3><pre><code>${esc(p.cursor_prompts)}</code></pre>
</details>
<h2>Observed screens</h2><div class="shots">${shots}</div>
<p style="color:#64748b;font-size:12px;margin-top:32px">Generated ${esc(p.generated_at)}.</p>
</main></body></html>`;
}

export function fileIoStatusLabel(test: Pick<FileIoTestResult, 'compare_status' | 'upload_ok'>): string {
  if (test.compare_status === 'not_applicable') {
    return test.upload_ok ? 'Workflow passed (not comparable)' : 'Not comparable';
  }
  return test.compare_status;
}

async function fetchSessionDecisions(runId: number, sessionId: number): Promise<SessionDecision[]> {
  const response = await backend.get<{ data: SessionDecision[] }>('/worker/decisions', {
    params: { run_id: runId, session_id: sessionId },
  });
  return Array.isArray(response.data.data) ? response.data.data : [];
}

const DECISION_SOURCE_LABELS: Record<string, string> = {
  memory: 'Reused from memory',
  auto: 'Decided by the run',
  timeout: 'Timed out waiting',
  cancelled: 'Cancelled',
  user: 'Answered by operator',
};

function formatDecisionCard(decision: SessionDecision) {
  const options = Array.isArray(decision.options) ? decision.options : [];
  const selectedId = String(decision.selected_option ?? '');
  const chosen = options.find((option) => String(option.id ?? '') === selectedId);
  const source = String(decision.source ?? (decision.status === 'timed_out' ? 'timeout' : 'user'));
  const sourceLabel = DECISION_SOURCE_LABELS[source] ?? 'Answered by operator';
  return {
    situation_label: situationLabel(String(decision.situation_key ?? '')),
    question: String(decision.question ?? ''),
    chosen_label: String(chosen?.label ?? (selectedId || '—')),
    source,
    source_label: sourceLabel,
    remember_label: decision.remember ? 'Yes' : 'No',
    free_text: String(decision.free_text ?? ''),
    has_note: Boolean(String(decision.free_text ?? '').trim()),
    answered_at: String(decision.answered_at ?? ''),
    context_title: String(decision.context?.title ?? ''),
    context_url: String(decision.context?.url ?? ''),
    image_data_uri: toDataUri(String(decision.screenshot_path ?? '')) ?? '',
    has_screenshot: Boolean(toDataUri(String(decision.screenshot_path ?? ''))),
  };
}

function situationLabel(key: string): string {
  if (!key) return 'Decision';
  if (key.startsWith('click_intercepted:')) {
    const label = key.slice('click_intercepted:'.length).trim();
    return label ? `Click blocked: ${label}` : 'Click blocked';
  }
  const labels: Record<string, string> = {
    company_picker_empty: 'No companies found',
    company_picker_ambiguous: 'Company not identified on picker',
    company_picker_unreadable: 'Companies listed but not identifiable',
    company_picker_click_blocked: 'Company picker blocked',
  };
  return labels[key] ?? key.replace(/_/g, ' ');
}

function decisionCard(decision: ReturnType<typeof formatDecisionCard>): string {
  return `<article class="finding">
<span class="badge">${esc(decision.source_label)}</span>
<h3>${esc(decision.situation_label)}</h3>
<p class="summary"><strong>Question:</strong> ${esc(decision.question)}</p>
<p><strong>Chosen:</strong> ${esc(decision.chosen_label)}</p>
<p class="muted">Remember for later: ${esc(decision.remember_label)}${decision.has_note ? ` · Note: ${esc(decision.free_text)}` : ''}${decision.answered_at ? ` · ${esc(decision.answered_at)}` : ''}</p>
<section class="visual"><div>${decision.has_screenshot
  ? `<img src="${decision.image_data_uri}" alt="Decision screenshot for ${esc(decision.situation_label)}">`
  : '<div class="muted">Screenshot unavailable for this decision.</div>'}</div>
<div><strong>Context</strong><p><b>Screen:</b> ${esc(decision.context_title)}</p><p><b>URL:</b> ${esc(decision.context_url)}</p></div></section>
</article>`;
}

function findingCard(input: {
  title: string;
  severity: string;
  meta: string;
  humanSummary: string;
  technicalRecommendation?: string;
  developerPrompt: string;
  evidence: Record<string, unknown>;
  expectation: string;
  validateFirst?: boolean;
}): string {
  const technical = String(input.technicalRecommendation ?? '').trim();
  const showTechnical = technical !== '' && technical !== String(input.humanSummary ?? '').trim();
  return `<article class="finding">${input.validateFirst ? '<div class="ribbon">Validate first</div>' : ''}
<span class="badge">${esc(input.severity)}</span><h3>${esc(input.title)}</h3><div class="muted">${esc(input.meta)}</div>
<p class="summary"><strong>Recommendation:</strong> ${esc(input.humanSummary)}</p>
${showTechnical ? `<details><summary>Technical recommendation</summary><p>${esc(technical)}</p></details>` : ''}
${visualMockup(input.evidence, input.expectation)}
<details><summary>Developer prompt</summary><pre><code>${esc(input.developerPrompt || 'No developer prompt available.')}</code></pre></details></article>`;
}

function visualMockup(evidence: Record<string, unknown>, expectation: string): string {
  const screenshots = stringList(evidence.screenshot_paths);
  const inventory = Array.isArray(evidence.inventory_samples)
    ? evidence.inventory_samples as Array<Record<string, unknown>>
    : Array.isArray(evidence.nearby_inventory)
      ? evidence.nearby_inventory as Array<Record<string, unknown>>
      : [];
  const selectors = [
    ...stringList(evidence.target_selectors),
    ...inventory.map((item) => String(item.selector ?? '')).filter(Boolean),
  ];
  const labels = inventory.map((item) => String(item.label ?? '')).filter(Boolean);
  const urls = stringList(evidence.affected_urls ?? evidence.screens_checked ?? evidence.url);
  const image = screenshots.map(toDataUri).find((value): value is string => Boolean(value));
  return `<section class="visual"><div>${image
    ? `<img src="${image}" alt="Visual evidence for ${esc(labels[0] ?? 'finding')}">`
    : '<div class="muted">Screenshot unavailable; use the captured selector and screen context.</div>'}</div>
<div><strong>Visual mockup</strong><p><b>Target:</b> ${esc(labels[0] || selectors[0] || 'Affected screen region')}</p>
<p><b>Selector:</b> <code>${esc(selectors[0] || 'Not captured')}</code></p>
<p><b>Screen:</b> ${esc(urls[0] || 'See session context')}</p><p><b>Expected:</b> ${esc(expectation)}</p></div></section>`;
}

function screenshotCard(card: ScreenshotCard): string {
  return `<figure class="shot">
${card.image_data_uri ? `<img src="${card.image_data_uri}" alt="${esc(card.screen_title)}">` : '<div class="muted">Screenshot file unavailable.</div>'}
<figcaption><strong>${esc(card.screen_title)}</strong>${card.screen_url ? `<br><code>${esc(card.screen_url)}</code>` : ''}${card.captured_at ? `<br><span class="muted">Captured ${esc(card.captured_at)}</span>` : ''}</figcaption>
</figure>`;
}

function agentStepCard(step: AgentStepRecord): string {
  const image = toDataUri(step.screenshot) ?? '';
  const typed = step.typed_value ? `<p><strong>Typed:</strong> ${esc(step.typed_value)}</p>` : '';
  return `<article class="card step"><div class="step-no">${step.ordinal}</div>
<div>${image ? `<img src="${image}" alt="Agent step ${step.ordinal}">` : '<div class="muted">Screenshot unavailable.</div>'}</div>
<div><span class="badge">${esc(step.outcome)}</span><h3>${esc(actionLabel(step))}</h3>
<p><strong>Observed:</strong> ${esc(step.observation)}</p>
<p><strong>Reasoning:</strong> ${esc(step.reasoning)}</p>
<p><strong>Outcome:</strong> ${esc(step.outcome_observation)}</p>
${typed}
<p><strong>Guard:</strong> ${esc(step.guard.allowed ? 'allowed' : step.guard.reason || 'refused')}</p>
<p><strong>Goal progress:</strong> ${esc(step.goal_progress)}</p>
<p class="muted">Signature ${step.signature_changed ? 'changed' : 'unchanged'} · ${esc(step.signature_after.url)}</p></div></article>`;
}

function actionLabel(step: AgentStepRecord): string {
  const action = step.action;
  if ('mark' in action) {
    return step.target_label
      ? `${action.type} "${step.target_label}" (mark ${action.mark})`
      : `${action.type} mark ${action.mark}`;
  }
  if (action.type === 'navigate') return `${action.type} ${action.url}`;
  return action.type;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return [...new Set(value.map(String).filter(Boolean))];
  return value ? [String(value)] : [];
}

function emptyCard(message: string): string {
  return `<div class="card muted">${esc(message)}</div>`;
}

function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
