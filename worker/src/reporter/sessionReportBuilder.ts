import fs from 'node:fs';
import path from 'node:path';
import { recordReport } from '../backend.js';
import type { SessionRow, RunRow } from '../backend.js';
import type { UxIssue } from '../reviewer/uxReviewEngine.js';
import type { FeatureGap } from '../reviewer/featureGapEngine.js';

export type SessionReportInput = {
  run: RunRow;
  session: SessionRow;
  reportsDir: string;
  screensObserved: number;
  inventoryCount: number;
  uxIssues: UxIssue[];
  featureGaps: FeatureGap[];
  screenshots: string[];
  startedAt: string;
  completedAt: string;
};

/**
 * Persists per-session JSON+HTML reports under the run's reports_dir and
 * registers them with the backend.
 */
export async function buildSessionReport(input: SessionReportInput): Promise<{ html_path: string; json_path: string; report_id: number }> {
  const { run, session, reportsDir } = input;
  const sessionsDir = path.join(reportsDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });

  const sevSummary = countBy(input.uxIssues.map((i) => i.severity));

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
    severity_summary: sevSummary,
    screenshots: input.screenshots,
    generated_at: new Date().toISOString(),
  };

  const slug = session.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const base = path.join(sessionsDir, `${String(session.ordinal).padStart(2, '0')}-${slug}`);
  const jsonPath = base + '.json';
  const htmlPath = base + '.html';
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.writeFileSync(htmlPath, renderHtml(payload), 'utf8');

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
    },
    ux_score: uxScore,
    html_path: htmlPath,
    json_path: jsonPath,
    auditor_visible: false,
  });

  return { html_path: htmlPath, json_path: jsonPath, report_id: reportId };
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

function renderHtml(p: ReturnType<typeof buildPayloadShape>): string {
  const issuesRows = p.ux_issues.map(
    (i) => `<tr><td>${esc(i.severity)}</td><td>${esc(i.title)}</td><td>${esc(i.recommendation)}</td></tr>`,
  ).join('') || `<tr><td colspan="3">No UX issues recorded.</td></tr>`;
  const gapRows = p.feature_gaps.map(
    (g) => `<tr><td>${esc(g.expected_feature)}</td><td>${g.observed ? 'yes' : 'no'}</td><td>${esc(g.severity)}</td><td>${esc(g.recommendation)}</td></tr>`,
  ).join('') || `<tr><td colspan="4">No feature gaps recorded.</td></tr>`;
  const shots = p.screenshots.map((s) => `<img src="${esc(path.basename(s))}" alt="">`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(p.run_code)} / ${esc(p.session_name)}</title>
<style>body{font:14px/1.5 system-ui;color:#0f172a;background:#fff;margin:32px}
h1{color:#10B981} .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.card{border:1px solid #e5e7eb;border-radius:8px;padding:16px}.card .v{font-size:24px;font-weight:600}
table{width:100%;border-collapse:collapse;margin-top:8px}th,td{border:1px solid #e5e7eb;padding:6px 8px;text-align:left;font-size:13px}
img{max-width:300px;border:1px solid #e5e7eb;border-radius:6px;margin:6px}</style></head><body>
<h1>${esc(p.run_code)} - ${esc(p.session_name)}</h1>
<p><strong>Product:</strong> ${esc(p.product_name)} &middot; <strong>Env:</strong> ${esc(p.environment)} &middot; <strong>Status:</strong> ${esc(p.status)}<br>
<strong>Menu path:</strong> ${esc(p.menu_path)}</p>
<div class="grid">
  <div class="card"><div>Screens Observed</div><div class="v">${p.screens_observed}</div></div>
  <div class="card"><div>UI items catalogued</div><div class="v">${p.inventory_count}</div></div>
  <div class="card"><div>Critical UX</div><div class="v">${p.severity_summary.critical}</div></div>
  <div class="card"><div>High UX</div><div class="v">${p.severity_summary.high}</div></div>
</div>
<h2>UX issues</h2><table><thead><tr><th>Severity</th><th>Title</th><th>Recommendation</th></tr></thead><tbody>${issuesRows}</tbody></table>
<h2>Feature gaps</h2><table><thead><tr><th>Expected feature</th><th>Observed</th><th>Severity</th><th>Recommendation</th></tr></thead><tbody>${gapRows}</tbody></table>
<h2>Screenshots</h2>${shots}
<p style="color:#64748b;font-size:12px;margin-top:32px">Generated ${esc(p.generated_at)}.</p>
</body></html>`;
}

function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

// helper for type-only payload shape inference
function buildPayloadShape() {
  return {
    run_code: '', session_name: '', menu_path: '', product_name: '', environment: '',
    status: '', screens_observed: 0, inventory_count: 0,
    severity_summary: { critical: 0, high: 0, medium: 0, low: 0, suggestion: 0 },
    ux_issues: [] as UxIssue[],
    feature_gaps: [] as FeatureGap[],
    screenshots: [] as string[],
    generated_at: '',
  };
}
