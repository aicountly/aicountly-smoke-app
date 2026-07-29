import fs from 'node:fs';
import path from 'node:path';
import { backend, recordReport } from '../backend.js';
import type { SessionRow, RunRow } from '../backend.js';
import type { UxIssue } from '../reviewer/uxReviewEngine.js';
import type { FeatureGap } from '../reviewer/featureGapEngine.js';
import { buildCursorPromptPack, type CursorPromptContext } from './cursorPromptBuilder.js';

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
  decisions?: SessionDecision[];
  startedAt: string;
  completedAt: string;
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
    status: 'done',
    screens_observed: input.screensObserved,
    inventory_count: input.inventoryCount,
    ux_issues: input.uxIssues,
    feature_gaps: input.featureGaps,
    decisions: decisionCards,
    severity_summary: sevSummary,
    screenshots: input.screenshots,
    screenshot_data_uris: shotDataUris,
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
      inventory_count: input.inventoryCount,
      ux_issues: input.uxIssues.length,
      feature_gaps: input.featureGaps.length,
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
  screens_observed: number;
  inventory_count: number;
  severity_summary: SeveritySummary;
  ux_issues: UxIssue[];
  feature_gaps: FeatureGap[];
  decisions?: ReturnType<typeof formatDecisionCard>[];
  screenshot_data_uris: string[];
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
  const shots = p.screenshot_data_uris.length
    ? p.screenshot_data_uris.map((src) => `<img src="${src}" alt="screenshot">`).join('')
    : `<p style="color:#64748b">No screenshots available (files missing on disk or capture failed).</p>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(p.run_code)} / ${esc(p.session_name)}</title>
<style>body{font:14px/1.55 system-ui;color:#0f172a;background:#f8fafc;margin:0;padding:32px}main{max-width:1100px;margin:auto}
h1{color:#059669}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.findings{display:grid;gap:16px}
.card,.finding{border:1px solid #e2e8f0;border-radius:12px;padding:18px;background:#fff;position:relative}.card .v{font-size:24px;font-weight:700}
.finding h3{margin:4px 0}.summary{white-space:pre-wrap}.badge{display:inline-block;padding:2px 8px;border-radius:999px;background:#ecfdf5;color:#065f46;font-size:12px}
.ribbon{position:absolute;right:0;top:0;padding:5px 12px;border-radius:0 12px 0 10px;background:#fef3c7;color:#92400e;font-weight:700}
.visual{display:grid;grid-template-columns:minmax(180px,320px) 1fr;gap:14px;margin-top:14px;padding:12px;border-left:4px solid #10b981;background:#f0fdf4;border-radius:8px}
.visual img,.shots img{max-width:100%;border:1px solid #cbd5e1;border-radius:7px}.visual p{margin:3px 0}.muted{color:#64748b}
details{margin-top:14px}summary{cursor:pointer;font-weight:650}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#0f172a;color:#e2e8f0;border-radius:8px;padding:14px}
.shots{display:flex;flex-wrap:wrap;gap:8px}@media(max-width:760px){.grid{grid-template-columns:repeat(2,1fr)}.visual{grid-template-columns:1fr}}</style></head><body><main>
<h1>${esc(p.run_code)} - ${esc(p.session_name)}</h1>
<p><strong>Product:</strong> ${esc(p.product_name)} &middot; <strong>Env:</strong> ${esc(p.environment)} &middot; <strong>Status:</strong> ${esc(p.status)}<br>
<strong>Menu path:</strong> ${esc(p.menu_path)}</p>
<div class="grid">
  <div class="card"><div>Screens Observed</div><div class="v">${p.screens_observed}</div></div>
  <div class="card"><div>UI items catalogued</div><div class="v">${p.inventory_count}</div></div>
  <div class="card"><div>Critical UX</div><div class="v">${p.severity_summary.critical}</div></div>
  <div class="card"><div>High UX</div><div class="v">${p.severity_summary.high}</div></div>
</div>
<h2>Decisions taken</h2><p class="muted">Choices made while the worker was blocked, including remembered answers applied automatically.</p>
<div class="findings">${decisionCards}</div>
<h2>What to fix now</h2><p class="muted">Start with the plain-language recommendation in each card. Technical prompts are collapsed until needed.</p>
<h2>UX issues</h2><div class="findings">${issueCards}</div>
<h2>Feature gaps</h2><div class="findings">${gapCards}</div>
<details><summary>Technical details (for developers)</summary><pre><code>${esc(p.cursor_prompts)}</code></pre></details>
<h2>Screenshots</h2><div class="shots">${shots}</div>
<p style="color:#64748b;font-size:12px;margin-top:32px">Generated ${esc(p.generated_at)}.</p>
</main></body></html>`;
}

async function fetchSessionDecisions(runId: number, sessionId: number): Promise<SessionDecision[]> {
  const response = await backend.get<{ data: SessionDecision[] }>('/worker/decisions', {
    params: { run_id: runId, session_id: sessionId },
  });
  return Array.isArray(response.data.data) ? response.data.data : [];
}

function formatDecisionCard(decision: SessionDecision) {
  const options = Array.isArray(decision.options) ? decision.options : [];
  const selectedId = String(decision.selected_option ?? '');
  const chosen = options.find((option) => String(option.id ?? '') === selectedId);
  const source = String(decision.source ?? (decision.status === 'timed_out' ? 'timeout' : 'user'));
  const sourceLabel = source === 'memory'
    ? 'Reused from memory'
    : source === 'timeout'
      ? 'Timed out waiting'
      : source === 'cancelled'
        ? 'Cancelled'
        : 'Answered by operator';
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
    company_picker_ambiguous: 'Multiple companies found',
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
