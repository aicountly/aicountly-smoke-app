<?php

namespace App\Services\Reports;

use Config\Database;

/**
 * Builds a single session report (HTML + JSON) from the data the worker has
 * already recorded in the DB. Worker may also pass an enriched payload via
 * /api/v1/worker/reports if it ran in-process review.
 */
class SessionReportBuilder
{
    public function build(int $runId, int $sessionId, array $extra = []): array
    {
        $db   = Database::connect();
        $run  = $db->table('smoke_observation_runs')->where('id', $runId)->get()->getRowArray();
        $sess = $db->table('smoke_sessions')->where('id', $sessionId)->get()->getRowArray();
        if (! $run || ! $sess) {
            throw new \RuntimeException('Run or session not found');
        }
        $results = $db->table('smoke_observation_results')->where('run_id', $runId)->where('session_id', $sessionId)->orderBy('captured_at', 'ASC')->get()->getResultArray();
        $inv     = $db->table('smoke_ui_inventory')->where('run_id', $runId)->where('session_id', $sessionId)->get()->getResultArray();
        $ux      = $db->table('smoke_ux_issues')->where('run_id', $runId)->where('session_id', $sessionId)->get()->getResultArray();
        $gaps    = $db->table('smoke_feature_gaps')->where('run_id', $runId)->where('session_id', $sessionId)->get()->getResultArray();

        $severityCount = ['critical' => 0, 'high' => 0, 'medium' => 0, 'low' => 0, 'suggestion' => 0];
        foreach ($ux as $i) {
            $s = strtolower((string) $i['severity']);
            if (isset($severityCount[$s])) $severityCount[$s]++;
        }

        $reportData = [
            'run_code'          => $run['run_code'],
            'session_id'        => $sessionId,
            'session_name'      => $sess['name'],
            'menu_path'         => $sess['menu_path'],
            'product_name'      => $run['product_name'],
            'environment'       => $run['environment'],
            'started_at'        => $sess['started_at'],
            'completed_at'      => $sess['completed_at'],
            'status'            => $sess['status'],
            'screens_observed'  => count($results),
            'inventory_count'   => count($inv),
            'ux_issues'         => $ux,
            'feature_gaps'      => $gaps,
            'severity_summary'  => $severityCount,
            'screenshots'       => array_map(static fn(array $r): string => (string) ($r['screenshot_path'] ?? ''), $results),
            'extra'             => $extra,
            'generated_at'      => date(DATE_ATOM),
        ];

        $dir = $this->ensureDir($run['reports_dir'] . '/sessions');
        $base = $dir . '/' . sprintf('%02d', (int) $sess['ordinal']) . '-' . $this->slug($sess['name']);
        $jsonPath = $base . '.json';
        $htmlPath = $base . '.html';

        file_put_contents($jsonPath, json_encode($reportData, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));

        $tplPath = realpath(WRITEPATH . '../../samples/reports/session.html.tpl');
        $tpl = $tplPath !== false && is_file($tplPath) ? (string) file_get_contents($tplPath) : $this->fallbackTemplate('session');
        $html = (new ReportRenderer())->render($tpl, $reportData);
        file_put_contents($htmlPath, $html);

        $reportId = $this->insertReport([
            'run_id'                => $runId,
            'session_id'            => $sessionId,
            'kind'                  => 'session',
            'title'                 => 'Session report: ' . $sess['name'],
            'severity_summary_json' => json_encode($severityCount),
            'metrics_json'          => json_encode([
                'screens_observed' => count($results),
                'inventory_count'  => count($inv),
                'ux_issues'        => count($ux),
                'feature_gaps'     => count($gaps),
            ]),
            'maturity_score' => null,
            'ux_score'       => $this->uxScore($severityCount, count($results) ?: 1),
            'html_path'      => $htmlPath,
            'json_path'      => $jsonPath,
        ]);

        return ['report_id' => $reportId, 'html_path' => $htmlPath, 'json_path' => $jsonPath];
    }

    private function ensureDir(string $path): string
    {
        if (! is_dir($path)) {
            @mkdir($path, 0775, true);
        }
        return $path;
    }

    private function slug(string $s): string
    {
        $s = strtolower(preg_replace('/[^a-zA-Z0-9]+/', '-', $s) ?? '');
        return trim($s, '-') ?: 'session';
    }

    private function uxScore(array $severityCount, int $denominator): float
    {
        $weights = ['critical' => 5, 'high' => 3, 'medium' => 1.5, 'low' => 0.5, 'suggestion' => 0.1];
        $penalty = 0.0;
        foreach ($severityCount as $k => $v) {
            $penalty += ($weights[$k] ?? 0) * (int) $v;
        }
        $score = max(0.0, 100.0 - ($penalty * 100.0 / max(1.0, $denominator * 5.0)));
        return round($score, 2);
    }

    private function insertReport(array $row): int
    {
        $db = Database::connect();
        $db->table('smoke_reports')->insert($row);
        return (int) $db->insertID();
    }

    public function fallbackTemplate(string $kind): string
    {
        if ($kind === 'final') {
            return <<<'HTML'
<!doctype html><html><head><meta charset="utf-8"><title>{{run_code}} - Final Report</title>
<style>body{font:14px/1.5 system-ui, sans-serif;color:#0f172a;background:#fff;margin:32px;}
h1{color:#10B981} h2{margin-top:32px} .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.card{border:1px solid #e5e7eb;border-radius:8px;padding:16px} .card .v{font-size:24px;font-weight:600}
table{width:100%;border-collapse:collapse;margin-top:8px} th,td{border:1px solid #e5e7eb;padding:6px 8px;text-align:left;font-size:13px}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;background:#ecfdf5;color:#065f46}
.crit{background:#fee2e2;color:#7f1d1d}.high{background:#fef3c7;color:#78350f}.med{background:#e0f2fe;color:#0c4a6e}
</style></head><body>
<h1>{{run_code}} - Final Consolidated Report</h1>
<p><strong>Product:</strong> {{product_name}} &nbsp; <strong>Environment:</strong> {{environment}}<br>
<strong>Sessions:</strong> {{sessions_total}} (done {{sessions_done}}, failed {{sessions_failed}})<br>
<strong>Maturity Score:</strong> {{maturity_score}}/100 &nbsp; <strong>UX Score:</strong> {{ux_score}}/100</p>

<h2>Summary cards</h2><div class="grid">
<div class="card"><div>Screens Observed</div><div class="v">{{totals.screens}}</div></div>
<div class="card"><div>UI Inventory Items</div><div class="v">{{totals.inventory}}</div></div>
<div class="card"><div>UX Issues</div><div class="v">{{totals.ux}}</div></div>
<div class="card"><div>Feature Gaps</div><div class="v">{{totals.gaps}}</div></div>
<div class="card"><div>Critical</div><div class="v">{{severity_summary.critical}}</div></div>
<div class="card"><div>High</div><div class="v">{{severity_summary.high}}</div></div></div>

<h2>Quick wins</h2><ul>{{#quick_wins}}<li>{{title}} <span class="badge">{{severity}}</span></li>{{/quick_wins}}</ul>
<h2>Missing features</h2><ul>{{#missing_features}}<li>{{expected_feature}} (vs {{competitor_ref}})</li>{{/missing_features}}</ul>
<h2>Old / inconsistent UI pages</h2><ul>{{#old_ui}}<li>{{screen_url}}</li>{{/old_ui}}</ul>
<h2>Per-session reports</h2><table><thead><tr><th>#</th><th>Session</th><th>Screens</th><th>UX</th><th>HTML</th></tr></thead><tbody>
{{#sessions}}<tr><td>{{ordinal}}</td><td>{{name}}</td><td>{{screens}}</td><td>{{ux_score}}</td><td><a href="{{html_path}}">open</a></td></tr>{{/sessions}}
</tbody></table>
<p style="margin-top:32px;color:#64748b;font-size:12px">Generated {{generated_at}} by smoke.aicountly.org</p>
</body></html>
HTML;
        }
        return <<<'HTML'
<!doctype html><html><head><meta charset="utf-8"><title>{{run_code}} / {{session_name}}</title>
<style>body{font:14px/1.5 system-ui;color:#0f172a;background:#fff;margin:32px}
h1{color:#10B981}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.card{border:1px solid #e5e7eb;border-radius:8px;padding:16px} .card .v{font-size:24px;font-weight:600}
table{width:100%;border-collapse:collapse;margin-top:8px} th,td{border:1px solid #e5e7eb;padding:6px 8px;text-align:left;font-size:13px}
img{max-width:300px;border:1px solid #e5e7eb;border-radius:6px;margin:6px}
</style></head><body>
<h1>{{run_code}} - {{session_name}}</h1>
<p><strong>Product:</strong> {{product_name}} &nbsp; <strong>Env:</strong> {{environment}} &nbsp; <strong>Status:</strong> {{status}}<br>
<strong>Menu path:</strong> {{menu_path}}</p>

<div class="grid">
<div class="card"><div>Screens Observed</div><div class="v">{{screens_observed}}</div></div>
<div class="card"><div>UI Items Catalogued</div><div class="v">{{inventory_count}}</div></div>
<div class="card"><div>Critical UX</div><div class="v">{{severity_summary.critical}}</div></div>
<div class="card"><div>High UX</div><div class="v">{{severity_summary.high}}</div></div>
</div>

<h2>UX issues</h2><table><thead><tr><th>Severity</th><th>Title</th><th>Recommendation</th></tr></thead><tbody>
{{#ux_issues}}<tr><td>{{severity}}</td><td>{{title}}</td><td>{{recommendation}}</td></tr>{{/ux_issues}}
{{^ux_issues}}<tr><td colspan="3">No UX issues recorded.</td></tr>{{/ux_issues}}
</tbody></table>

<h2>Feature gaps</h2><table><thead><tr><th>Expected feature</th><th>Observed</th><th>Severity</th><th>Recommendation</th></tr></thead><tbody>
{{#feature_gaps}}<tr><td>{{expected_feature}}</td><td>{{observed}}</td><td>{{severity}}</td><td>{{recommendation}}</td></tr>{{/feature_gaps}}
{{^feature_gaps}}<tr><td colspan="4">No feature gaps recorded.</td></tr>{{/feature_gaps}}
</tbody></table>

<h2>Screenshots</h2>{{#screenshots}}<img src="{{value}}" alt="">{{/screenshots}}
<p style="color:#64748b;font-size:12px;margin-top:32px">Generated {{generated_at}}.</p>
</body></html>
HTML;
    }
}
