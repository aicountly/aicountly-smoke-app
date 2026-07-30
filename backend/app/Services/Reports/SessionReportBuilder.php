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
    /**
     * @param bool $persistReport When false, only writes files (for rebuild of an existing row).
     */
    public function build(int $runId, int $sessionId, array $extra = [], bool $persistReport = true): array
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
        $fileIo  = $db->table('smoke_file_io_tests')->where('run_id', $runId)->where('session_id', $sessionId)->orderBy('id', 'ASC')->get()->getResultArray();
        foreach ($fileIo as &$test) {
            $scores = json_decode((string) ($test['ai_scores_json'] ?? '{}'), true);
            $test['ai_overall'] = is_array($scores) ? ($scores['overall'] ?? '') : '';
            $test['status_label'] = ($test['compare_status'] ?? '') === 'not_applicable'
                ? (! empty($test['upload_ok']) ? 'Workflow passed (not comparable)' : 'Not comparable')
                : (string) ($test['compare_status'] ?? '');
        }
        unset($test);
        $allInventoryLabels = array_values(array_unique(array_filter(array_column($inv, 'label'))));
        $cursorPrompts = CursorHandoff::assembleMasterPrompt(
            [
                'run_code'     => $run['run_code'],
                'product_name' => $run['product_name'],
                'environment'  => $run['environment'],
            ],
            $this->decodeEvidenceRows($ux),
            $this->decodeEvidenceRows($gaps),
            $allInventoryLabels,
        );

        $severityCount = ['critical' => 0, 'high' => 0, 'medium' => 0, 'low' => 0, 'suggestion' => 0];
        foreach ($ux as $i) {
            $s = strtolower((string) $i['severity']);
            if (isset($severityCount[$s])) $severityCount[$s]++;
        }

        // Scored before prepareFinding() rewrites the rows for display.
        $uxScore  = MaturityScore::ux($severityCount, count($results));
        $maturity = MaturityScore::forScope($severityCount, $gaps, count($results));

        $resolver = new ReportArtifactResolver();
        $screenshotCards = $this->buildScreenshotCards(
            $results,
            (string) ($run['reports_dir'] ?? ''),
            $resolver,
        );
        foreach ($ux as &$finding) {
            $finding = $this->prepareFinding($finding, $screenshotCards, false, (string) ($run['reports_dir'] ?? ''), $resolver);
        }
        unset($finding);
        foreach ($gaps as &$finding) {
            $finding = $this->prepareFinding($finding, $screenshotCards, true, (string) ($run['reports_dir'] ?? ''), $resolver);
        }
        unset($finding);
        // Embed as data URIs so Reports iframe (srcDoc) can render without a file base URL.
        $shotDataUris = array_values(array_filter(array_column($screenshotCards, 'image_data_uri')));
        $decisions = (new DecisionReportFormatter())->forRun(
            $runId,
            (string) ($run['reports_dir'] ?? ''),
            $sessionId,
        );

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
            'file_io_tests'     => $fileIo,
            'decisions'         => $decisions,
            'has_decisions'     => $decisions !== [],
            'severity_summary'  => $severityCount,
            'ux_score'          => $uxScore,
            'maturity_score'    => $maturity,
            'maturity_label'    => MaturityScore::label($maturity),
            'screenshots'       => $shotDataUris,
            'screenshot_data_uris' => $shotDataUris,
            'screenshot_cards'  => $screenshotCards,
            'cursor_prompts'    => $cursorPrompts,
            'extra'             => $extra,
            'generated_at'      => date(DATE_ATOM),
        ];

        $dir = $resolver->ensureDir(rtrim((string) $run['reports_dir'], '/\\') . '/sessions');
        $base = $dir . '/' . sprintf('%02d', (int) $sess['ordinal']) . '-' . $this->slug($sess['name']);
        $jsonPath = $base . '.json';
        $htmlPath = $base . '.html';
        $cursorPromptsPath = $base . '.cursor-prompts.md';
        $reportData['cursor_prompts_path'] = $cursorPromptsPath;

        file_put_contents($jsonPath, json_encode($reportData, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
        file_put_contents($cursorPromptsPath, $cursorPrompts);

        $tplPath = realpath(WRITEPATH . '../../samples/reports/session.html.tpl');
        $tpl = $tplPath !== false && is_file($tplPath) ? (string) file_get_contents($tplPath) : $this->fallbackTemplate('session');
        $html = (new ReportRenderer())->render($tpl, $reportData);
        file_put_contents($htmlPath, $html);

        $reportId = 0;
        if ($persistReport) {
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
                    'file_io_tests'    => count($fileIo),
                    'cursor_prompts_path' => $cursorPromptsPath,
                ]),
                'maturity_score' => $maturity,
                'ux_score'       => $uxScore,
                'html_path'      => $htmlPath,
                'json_path'      => $jsonPath,
            ]);
        }

        return ['report_id' => $reportId, 'html_path' => $htmlPath, 'json_path' => $jsonPath, 'cursor_prompts_path' => $cursorPromptsPath];
    }

    /**
     * CursorHandoff reads a decoded 'evidence' array, not the raw evidence_json
     * column text every smoke_ux_issues/smoke_feature_gaps row carries.
     *
     * @param list<array<string, mixed>> $rows
     * @return list<array<string, mixed>>
     */
    private function decodeEvidenceRows(array $rows): array
    {
        foreach ($rows as &$row) {
            $decoded = json_decode((string) ($row['evidence_json'] ?? ''), true);
            $row['evidence'] = is_array($decoded) ? $decoded : [];
        }
        unset($row);
        return $rows;
    }

    private function buildScreenshotCards(array $results, string $reportsDir, ReportArtifactResolver $resolver): array
    {
        $cards = [];
        foreach ($results as $result) {
            $resolved = $resolver->resolveFile((string) ($result['screenshot_path'] ?? ''), $reportsDir);
            $imageDataUri = $resolved && is_file($resolved) && filesize($resolved) > 0
                ? $this->imageDataUri($resolved)
                : '';
            $cards[] = [
                'result_id'       => (int) ($result['id'] ?? 0),
                'screen_title'    => trim((string) ($result['screen_title'] ?? '')) ?: 'Untitled screen',
                'screen_url'      => (string) ($result['screen_url'] ?? ''),
                'captured_at'     => (string) ($result['captured_at'] ?? ''),
                'screenshot_path' => (string) ($result['screenshot_path'] ?? ''),
                'image_data_uri'  => $imageDataUri,
            ];
        }
        return $cards;
    }

    private function prepareFinding(array $finding, array $screenshotCards, bool $isGap, string $reportsDir, ReportArtifactResolver $resolver): array
    {
        $evidence = json_decode((string) ($finding['evidence_json'] ?? ''), true);
        $evidence = is_array($evidence) ? $evidence : [];
        $related = $this->matchScreenshot($finding, $evidence, $screenshotCards);
        if (! $related) {
            foreach ($this->stringList($evidence['screenshot_paths'] ?? []) as $path) {
                $resolved = $resolver->resolveFile($path, $reportsDir);
                if ($resolved && is_file($resolved) && filesize($resolved) > 0) {
                    $related = [
                        'screen_title' => $this->stringList($evidence['screen_titles'] ?? [])[0] ?? 'Related screen',
                        'screen_url' => $this->stringList($evidence['affected_urls'] ?? $evidence['screens_checked'] ?? $evidence['url'] ?? [])[0] ?? '',
                        'captured_at' => '',
                        'image_data_uri' => $this->imageDataUri($resolved),
                    ];
                    break;
                }
            }
        }
        $finding['human_summary'] = trim((string) ($finding['human_summary'] ?? ''))
            ?: trim((string) ($finding['recommendation'] ?? ''))
            ?: (string) ($finding['description'] ?? '');
        $finding['display_recommendation'] = $finding['human_summary'];
        $finding['technical_recommendation'] = trim((string) ($finding['recommendation'] ?? ''));
        $finding['has_technical_recommendation'] = $finding['technical_recommendation'] !== ''
            && $finding['technical_recommendation'] !== $finding['human_summary'];
        $finding['developer_prompt'] = (string) ($finding['developer_prompt'] ?? '');
        $finding['validate_first'] = $isGap && ($finding['mode'] ?? '') === 'validate_first';
        $finding['evidence_image_data_uri'] = (string) ($related['image_data_uri'] ?? '');
        $finding['evidence_screen_title'] = (string) ($related['screen_title'] ?? '');
        $finding['evidence_screen_url'] = (string) ($related['screen_url'] ?? '');
        $finding['evidence_captured_at'] = (string) ($related['captured_at'] ?? '');
        $inventory = $evidence['inventory_samples'] ?? $evidence['nearby_inventory'] ?? [];
        $inventory = is_array($inventory) ? $inventory : [];
        $first = is_array($inventory[0] ?? null) ? $inventory[0] : [];
        $selectors = $this->stringList($evidence['target_selectors'] ?? []);
        $finding['evidence_target'] = (string) ($first['label'] ?? $first['selector'] ?? $selectors[0] ?? 'Affected screen region');
        $finding['evidence_selector'] = (string) ($first['selector'] ?? $selectors[0] ?? 'Not captured');
        $finding['evidence_expectation'] = $isGap && ($finding['mode'] ?? '') === 'validate_first'
            ? 'Confirm existing coverage and product scope before implementation.'
            : (string) ($finding['recommendation'] ?? '');
        $finding['visual_target'] = $finding['evidence_target'];
        $finding['visual_selector'] = $finding['evidence_selector'];
        $finding['visual_screen'] = $finding['evidence_screen_url'] !== ''
            ? $finding['evidence_screen_url']
            : ($finding['evidence_screen_title'] !== '' ? $finding['evidence_screen_title'] : 'See session context');
        $finding['has_evidence_image'] = $finding['evidence_image_data_uri'] !== '';
        return $finding;
    }

    private function matchScreenshot(array $finding, array $evidence, array $cards): ?array
    {
        $resultId = (int) ($finding['result_id'] ?? 0);
        $paths = $this->stringList($evidence['screenshot_paths'] ?? []);
        $urls = $this->stringList($evidence['affected_urls'] ?? $evidence['screens_checked'] ?? $evidence['url'] ?? []);
        $titles = $this->stringList($evidence['screen_titles'] ?? []);

        foreach ($cards as $card) {
            if ($resultId > 0 && $resultId === (int) ($card['result_id'] ?? 0)) {
                return $card;
            }
        }
        foreach ($cards as $card) {
            $cardPath = (string) ($card['screenshot_path'] ?? '');
            foreach ($paths as $path) {
                if ($path === $cardPath || ($path !== '' && basename($path) === basename($cardPath))) {
                    return $card;
                }
            }
        }
        foreach ($cards as $card) {
            $cardUrl = rtrim((string) ($card['screen_url'] ?? ''), '/');
            foreach ($urls as $url) {
                if ($cardUrl !== '' && $cardUrl === rtrim($url, '/')) {
                    return $card;
                }
            }
        }
        foreach ($cards as $card) {
            foreach ($titles as $title) {
                if ($title !== '' && strcasecmp($title, (string) ($card['screen_title'] ?? '')) === 0) {
                    return $card;
                }
            }
        }
        return null;
    }

    private function stringList($value): array
    {
        $values = is_array($value) ? $value : ($value === null || $value === '' ? [] : [$value]);
        return array_values(array_unique(array_filter(array_map(
            static fn ($item): string => is_scalar($item) ? trim((string) $item) : '',
            $values,
        ))));
    }

    private function imageDataUri(string $path): string
    {
        $extension = strtolower(pathinfo($path, PATHINFO_EXTENSION));
        $mime = match ($extension) {
            'jpg', 'jpeg' => 'image/jpeg',
            'webp' => 'image/webp',
            default => 'image/png',
        };
        return 'data:' . $mime . ';base64,' . base64_encode((string) file_get_contents($path));
    }

    private function slug(string $s): string
    {
        $s = strtolower(preg_replace('/[^a-zA-Z0-9]+/', '-', $s) ?? '');
        return trim($s, '-') ?: 'session';
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
<style>body{font:14px/1.5 system-ui,sans-serif;color:#0f172a;background:#f8fafc;margin:32px}
h1{color:#10B981} h2{margin-top:32px} .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.card,.finding{border:1px solid #e5e7eb;border-radius:10px;padding:16px;background:#fff;position:relative}.card .v{font-size:24px;font-weight:600}.findings{display:grid;gap:14px}
table{width:100%;border-collapse:collapse;margin-top:8px} th,td{border:1px solid #e5e7eb;padding:6px 8px;text-align:left;font-size:13px}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;background:#ecfdf5;color:#065f46}
.crit{background:#fee2e2;color:#7f1d1d}.high{background:#fef3c7;color:#78350f}.med{background:#e0f2fe;color:#0c4a6e}
.ribbon{position:absolute;right:0;top:0;padding:5px 10px;background:#fef3c7;color:#92400e;font-weight:700}.summary{white-space:pre-wrap}details{margin-top:12px}summary{cursor:pointer;font-weight:600}pre{white-space:pre-wrap;background:#0f172a;color:#e2e8f0;padding:12px;border-radius:8px}
</style></head><body>
<h1>{{run_code}} - Final Consolidated Report</h1>
<p><strong>Product:</strong> {{product_name}} &nbsp; <strong>Environment:</strong> {{environment}}<br>
<strong>Sessions:</strong> {{sessions_total}} (done {{sessions_done}}, failed {{sessions_failed}})<br>
<strong>Maturity Score:</strong> {{maturity_label}} &nbsp; <strong>UX Score:</strong> {{ux_score}}/100</p>

<h2>Summary cards</h2><div class="grid">
<div class="card"><div>Screens Observed</div><div class="v">{{totals.screens}}</div></div>
<div class="card"><div>UI Inventory Items</div><div class="v">{{totals.inventory}}</div></div>
<div class="card"><div>UX Issues</div><div class="v">{{totals.ux}}</div></div>
<div class="card"><div>Feature Gaps</div><div class="v">{{totals.gaps}}</div></div>
<div class="card"><div>Critical</div><div class="v">{{severity_summary.critical}}</div></div>
<div class="card"><div>High</div><div class="v">{{severity_summary.high}}</div></div></div>

<h2>Decisions taken</h2><div class="findings">{{#decisions}}<article class="finding"><strong>{{situation_label}}</strong> · {{source_label}}<div class="summary">{{question}}</div><div>Chosen: {{chosen_label}}</div>{{#has_screenshot}}<img src="{{image_data_uri}}" alt="decision">{{/has_screenshot}}</article>{{/decisions}}{{^decisions}}<div class="card">No mid-run decisions were required.</div>{{/decisions}}</div>
<h2>What to fix now</h2><div class="findings">{{#quick_wins}}<article class="finding"><strong>{{title}} <span class="badge">{{severity}}</span></strong><div class="summary">{{display_recommendation}}</div><details><summary>Developer prompt</summary><pre>{{developer_prompt}}</pre></details></article>{{/quick_wins}}</div>
<h2>Missing features</h2><div class="findings">{{#missing_features}}<article class="finding">{{#validate_first}}<div class="ribbon">Validate first</div>{{/validate_first}}<strong>{{expected_feature}}</strong><div class="summary">{{display_recommendation}}</div>{{#has_evidence_image}}<img src="{{evidence_image_data_uri}}" alt="evidence">{{/has_evidence_image}}<details><summary>Developer prompt</summary><pre>{{developer_prompt}}</pre></details></article>{{/missing_features}}</div>
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
<style>body{font:14px/1.5 system-ui;color:#0f172a;background:#f8fafc;margin:32px}
h1{color:#10B981}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.card,.finding{border:1px solid #e5e7eb;border-radius:10px;padding:16px;background:#fff;position:relative}.card .v{font-size:24px;font-weight:600}
.findings{display:grid;gap:14px}.summary{white-space:pre-wrap}.visual{margin-top:12px;padding:12px;border-left:4px solid #10b981;background:#f0fdf4}
.ribbon{position:absolute;right:0;top:0;padding:5px 10px;background:#fef3c7;color:#92400e;font-weight:700}details{margin-top:12px}summary{cursor:pointer;font-weight:600}
img{max-width:300px;border:1px solid #e5e7eb;border-radius:6px;margin:6px}pre{white-space:pre-wrap;background:#0f172a;color:#e2e8f0;padding:12px;border-radius:8px}
</style></head><body>
<h1>{{run_code}} - {{session_name}}</h1>
<p><strong>Product:</strong> {{product_name}} &nbsp; <strong>Env:</strong> {{environment}} &nbsp; <strong>Status:</strong> {{status}}<br>
<strong>Menu path:</strong> {{menu_path}}<br>
<strong>Maturity Score:</strong> {{maturity_label}} &nbsp; <strong>UX Score:</strong> {{ux_score}}/100</p>

<div class="grid">
<div class="card"><div>Screens Observed</div><div class="v">{{screens_observed}}</div></div>
<div class="card"><div>UI Items Catalogued</div><div class="v">{{inventory_count}}</div></div>
<div class="card"><div>Critical UX</div><div class="v">{{severity_summary.critical}}</div></div>
<div class="card"><div>High UX</div><div class="v">{{severity_summary.high}}</div></div>
</div>

<h2>Decisions taken</h2><div class="findings">{{#decisions}}<article class="finding"><strong>{{situation_label}}</strong> · {{source_label}}<div class="summary">{{question}}</div><div>Chosen: {{chosen_label}}</div>{{#has_screenshot}}<img src="{{image_data_uri}}" alt="decision">{{/has_screenshot}}</article>{{/decisions}}{{^decisions}}<div class="card">No mid-run decisions were required.</div>{{/decisions}}</div>
<h2>What to fix now</h2><p>Read the recommendation first; open technical details only when needed.</p>
<h2>UX issues</h2><div class="findings">{{#ux_issues}}<article class="finding"><strong>{{severity}} · {{title}}</strong><div class="summary">{{display_recommendation}}</div>
{{#has_evidence_image}}<div class="visual"><img src="{{evidence_image_data_uri}}" alt="evidence"><div>Target: {{visual_target}} · Selector: {{visual_selector}} · Screen: {{visual_screen}}</div></div>{{/has_evidence_image}}
<details><summary>Developer prompt</summary><pre>{{developer_prompt}}</pre></details></article>{{/ux_issues}}
{{^ux_issues}}<div class="card">No UX issues recorded.</div>{{/ux_issues}}</div>

<h2>Feature gaps</h2><div class="findings">{{#feature_gaps}}<article class="finding">{{#validate_first}}<div class="ribbon">Validate first</div>{{/validate_first}}<strong>{{severity}} · {{expected_feature}}</strong><div class="summary">{{display_recommendation}}</div>
{{#has_evidence_image}}<div class="visual"><img src="{{evidence_image_data_uri}}" alt="evidence"><div>Target: {{visual_target}} · Selector: {{visual_selector}} · Screen: {{visual_screen}}</div></div>{{/has_evidence_image}}
<details><summary>Developer prompt</summary><pre>{{developer_prompt}}</pre></details></article>{{/feature_gaps}}
{{^feature_gaps}}<div class="card">No feature gaps recorded.</div>{{/feature_gaps}}</div>

<h2>Screenshots</h2><div class="shots">{{#screenshots}}<img src="{{value}}" alt="screenshot">{{/screenshots}}{{^screenshots}}<p style="color:#64748b">No screenshots available (files missing on disk or capture failed).</p>{{/screenshots}}</div>
<p style="color:#64748b;font-size:12px;margin-top:32px">Generated {{generated_at}}.</p>
</body></html>
HTML;
    }
}
