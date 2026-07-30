<?php

namespace App\Services\Reports;

use Config\Database;

/**
 * Builds the consolidated final report for a run after all session jobs are
 * either done, failed, or cancelled. Aggregates UI inventory, UX issues, and
 * feature gaps across the run.
 */
class FinalReportBuilder
{
    /**
     * @param bool $persistReport When false, only writes files (for rebuild of an existing row).
     */
    public function build(int $runId, bool $persistReport = true): array
    {
        $db  = Database::connect();
        $run = $db->table('smoke_observation_runs')->where('id', $runId)->get()->getRowArray();
        if (! $run) {
            throw new \RuntimeException('Run not found');
        }
        $sessions = $db->table('smoke_sessions')->where('plan_id', $run['plan_id'])->orderBy('ordinal', 'ASC')->get()->getResultArray();

        $totals = [
            'screens'   => (int) $db->table('smoke_observation_results')->where('run_id', $runId)->countAllResults(),
            'inventory' => (int) $db->table('smoke_ui_inventory')->where('run_id', $runId)->countAllResults(),
            'ux'        => (int) $db->table('smoke_ux_issues')->where('run_id', $runId)->countAllResults(),
            'gaps'      => (int) $db->table('smoke_feature_gaps')->where('run_id', $runId)->countAllResults(),
            'file_io'   => (int) $db->table('smoke_file_io_tests')->where('run_id', $runId)->countAllResults(),
        ];
        $fileIo = $db->table('smoke_file_io_tests')->where('run_id', $runId)->orderBy('id', 'ASC')->get()->getResultArray();
        $fileIoPassed = 0;
        $fileIoComparable = 0;
        $lowFileQuality = [];
        foreach ($fileIo as &$test) {
            $compareStatus = (string) ($test['compare_status'] ?? '');
            if (in_array($compareStatus, ['pass', 'fail', 'partial'], true)) $fileIoComparable++;
            if ($compareStatus === 'pass') $fileIoPassed++;
            $test['status_label'] = $compareStatus === 'not_applicable'
                ? (! empty($test['upload_ok']) ? 'Workflow passed (not comparable)' : 'Not comparable')
                : $compareStatus;
            $scores = json_decode((string) ($test['ai_scores_json'] ?? '{}'), true);
            $test['ai_overall'] = is_array($scores) ? (int) ($scores['overall'] ?? 0) : 0;
            if ($test['ai_overall'] > 0 && $test['ai_overall'] < 70) $lowFileQuality[] = $test;
        }
        unset($test);
        $fileIoPassRate = $fileIoComparable > 0 ? round($fileIoPassed * 100 / $fileIoComparable, 1) : 0;

        $severityCount = ['critical' => 0, 'high' => 0, 'medium' => 0, 'low' => 0, 'suggestion' => 0];
        $bySeverity = $db->table('smoke_ux_issues')
            ->select('severity, COUNT(*) AS c')
            ->where('run_id', $runId)
            ->groupBy('severity')
            ->get()->getResultArray();
        foreach ($bySeverity as $row) {
            $key = strtolower((string) $row['severity']);
            if (isset($severityCount[$key])) $severityCount[$key] = (int) $row['c'];
        }

        $missingFeatures = $db->table('smoke_feature_gaps')->where('run_id', $runId)->where('observed', false)->orderBy('severity', 'DESC')->limit(50)->get()->getResultArray();
        $oldUi           = $db->table('smoke_ux_issues')->where('run_id', $runId)->where('category', 'old_theme')->limit(50)->get()->getResultArray();
        $brokenScreens   = $db->table('smoke_observation_results')->where('run_id', $runId)->where("(jsonb_array_length(COALESCE(console_errors_json,'[]'::jsonb)) > 0 OR jsonb_array_length(COALESCE(network_errors_json,'[]'::jsonb)) > 0)")->limit(50)->get()->getResultArray();
        $results         = $db->table('smoke_observation_results')->where('run_id', $runId)->orderBy('captured_at', 'ASC')->get()->getResultArray();
        $resolver        = new ReportArtifactResolver();
        $screenshotCards = $this->buildScreenshotCards($results, (string) ($run['reports_dir'] ?? ''), $resolver);

        $reportsDir = (string) ($run['reports_dir'] ?? '');
        $decisions = (new DecisionReportFormatter())->forRun($runId, $reportsDir);

        $quickWins = $db->table('smoke_ux_issues')->where('run_id', $runId)->whereIn('severity', ['low', 'suggestion'])->limit(20)->get()->getResultArray();
        foreach ($quickWins as &$row) {
            $row = $this->prepareFinding($row, $screenshotCards, false, $reportsDir, $resolver);
        }
        unset($row);
        foreach ($missingFeatures as &$row) {
            $row = $this->prepareFinding($row, $screenshotCards, true, $reportsDir, $resolver);
        }
        unset($row);
        foreach ($oldUi as &$row) {
            $row = $this->prepareFinding($row, $screenshotCards, false, $reportsDir, $resolver);
        }
        unset($row);

        $topUx = $db->table('smoke_ux_issues')
            ->where('run_id', $runId)
            ->whereIn('severity', ['critical', 'high'])
            ->orderBy("CASE severity WHEN 'critical' THEN 1 ELSE 2 END", 'ASC', false)
            ->limit(12)->get()->getResultArray();
        $topGaps = $db->table('smoke_feature_gaps')
            ->where('run_id', $runId)
            ->where('observed', false)
            ->where('mode', 'implement')
            ->where('confidence', 'high')
            ->limit(12)->get()->getResultArray();
        $topIssues = [];
        foreach ($topUx as $row) {
            $row = $this->prepareFinding($row, $screenshotCards, false, $reportsDir, $resolver);
            $row['finding_type'] = 'UX issue';
            $topIssues[] = $row;
        }
        foreach ($topGaps as $row) {
            $row = $this->prepareFinding($row, $screenshotCards, true, $reportsDir, $resolver);
            $row['finding_type'] = 'Missing feature';
            $row['title'] = (string) ($row['expected_feature'] ?? 'Missing feature');
            $topIssues[] = $row;
        }
        $cursorUx = $db->table('smoke_ux_issues')
            ->where('run_id', $runId)
            ->whereIn('severity', ['critical', 'high', 'medium'])
            ->orderBy("CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 ELSE 3 END", 'ASC', false)
            ->limit(50)->get()->getResultArray();
        $cursorGaps = $db->table('smoke_feature_gaps')
            ->where('run_id', $runId)
            ->where('mode', 'implement')
            ->where('observed', false)
            ->limit(50)->get()->getResultArray();
        $cursorQuickWins = array_values(array_filter(
            array_merge($cursorUx, $cursorGaps),
            static fn (array $row): bool => trim((string) ($row['developer_prompt'] ?? '')) !== '',
        ));

        // The master prompt covers every finding in the run (not just the quick-wins
        // subset above), grouped by how much cursorHandoff trusts its own detection.
        $allUxForMaster = $db->table('smoke_ux_issues')
            ->where('run_id', $runId)
            ->orderBy("CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END", 'ASC', false)
            ->get()->getResultArray();
        $allGapsForMaster = $db->table('smoke_feature_gaps')->where('run_id', $runId)->get()->getResultArray();
        $allInventoryLabels = array_values(array_filter(array_column(
            $db->table('smoke_ui_inventory')->select('DISTINCT label')->where('run_id', $runId)->where("label <> ''")->limit(2000)->get()->getResultArray(),
            'label',
        )));

        // Per-session metrics
        $perSession = [];
        foreach ($sessions as $s) {
            $reportRow = $db->table('smoke_reports')->where('run_id', $runId)->where('session_id', $s['id'])->where('kind', 'session')->orderBy('id', 'DESC')->get()->getRowArray();
            $perSession[] = [
                'ordinal'   => (int) $s['ordinal'],
                'name'      => $s['name'],
                'screens'   => (int) $db->table('smoke_observation_results')->where('run_id', $runId)->where('session_id', $s['id'])->countAllResults(),
                'ux_score'  => (float) ($reportRow['ux_score'] ?? 0),
                'html_path' => $reportRow['html_path'] ?? '',
                'report_id' => (int) ($reportRow['id'] ?? 0),
                'report_url'=> ! empty($reportRow['id']) ? '/reports?id=' . (int) $reportRow['id'] : '',
                'has_report'=> ! empty($reportRow['id']),
            ];
        }

        $gapRows = $db->table('smoke_feature_gaps')->select('severity, mode, observed')->where('run_id', $runId)->get()->getResultArray();
        $maturity = MaturityScore::forScope($severityCount, $gapRows, (int) $totals['screens']);
        $uxAvg = count($perSession) > 0 ? round(array_sum(array_column($perSession, 'ux_score')) / count($perSession), 2) : 0;

        $payload = [
            'run_code'         => $run['run_code'],
            'run_id'           => $runId,
            'product_name'     => $run['product_name'],
            'environment'      => $run['environment'],
            'sessions_total'   => $run['sessions_total'],
            'sessions_done'    => $run['sessions_done'],
            'sessions_failed'  => $run['sessions_failed'],
            'totals'           => $totals,
            'severity_summary' => $severityCount,
            'maturity_score'   => $maturity,
            'maturity_label'   => MaturityScore::label($maturity),
            'ux_score'         => $uxAvg,
            'sessions'         => $perSession,
            'quick_wins'       => $quickWins,
            'cursor_quick_wins'=> $cursorQuickWins,
            'missing_features' => $missingFeatures,
            'top_issues_with_visual_evidence' => $topIssues,
            'decisions'        => $decisions,
            'has_decisions'    => $decisions !== [],
            'old_ui'           => $oldUi,
            'broken_screens'   => $brokenScreens,
            'file_io_tests'    => $fileIo,
            'file_io_pass_rate'=> $fileIoPassRate,
            'low_file_quality' => $lowFileQuality,
            'generated_at'     => date(DATE_ATOM),
        ];

        $dir = $resolver->ensureDir($reportsDir);
        $jsonPath = $dir . '/report.json';
        $htmlPath = $dir . '/index.html';
        $cursorPromptsPath = $dir . '/cursor-master-prompt.md';
        $cursorPrompts = CursorHandoff::assembleMasterPrompt(
            [
                'run_code'     => $run['run_code'],
                'product_name' => $run['product_name'],
                'environment'  => $run['environment'],
            ],
            $this->decodeEvidenceRows($allUxForMaster),
            $this->decodeEvidenceRows($allGapsForMaster),
            $allInventoryLabels,
        );
        $payload['cursor_prompts_path'] = $cursorPromptsPath;
        $payload['cursor_prompts'] = $cursorPrompts;
        file_put_contents($jsonPath, json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
        file_put_contents($cursorPromptsPath, $cursorPrompts);

        $tplPath = realpath(WRITEPATH . '../../samples/reports/final.html.tpl');
        $tpl = $tplPath !== false && is_file($tplPath) ? (string) file_get_contents($tplPath) : (new SessionReportBuilder())->fallbackTemplate('final');
        $html = (new ReportRenderer())->render($tpl, $payload);
        file_put_contents($htmlPath, $html);

        $reportId = 0;
        if ($persistReport) {
            $db->table('smoke_reports')->insert([
                'run_id'                => $runId,
                'session_id'            => null,
                'kind'                  => 'final',
                'title'                 => 'Final consolidated report: ' . $run['run_code'],
                'severity_summary_json' => json_encode($severityCount),
                'metrics_json'          => json_encode($totals),
                'maturity_score'        => $maturity,
                'ux_score'              => $uxAvg,
                'html_path'             => $htmlPath,
                'json_path'             => $jsonPath,
                'auditor_visible'       => true,
            ]);
            $reportId = (int) $db->insertID();
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
            $cards[] = [
                'result_id'       => (int) ($result['id'] ?? 0),
                'screen_title'    => trim((string) ($result['screen_title'] ?? '')) ?: 'Untitled screen',
                'screen_url'      => (string) ($result['screen_url'] ?? ''),
                'captured_at'     => (string) ($result['captured_at'] ?? ''),
                'screenshot_path' => (string) ($result['screenshot_path'] ?? ''),
                'image_data_uri'  => $resolved && is_file($resolved) && filesize($resolved) > 0
                    ? $this->imageDataUri($resolved)
                    : '',
            ];
        }
        return $cards;
    }

    private function prepareFinding(array $row, array $screenshotCards, bool $isGap, string $reportsDir, ReportArtifactResolver $resolver): array
    {
        $evidence = json_decode((string) ($row['evidence_json'] ?? ''), true);
        $evidence = is_array($evidence) ? $evidence : [];
        $related = $this->matchScreenshot($row, $evidence, $screenshotCards);
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
        $row['human_summary'] = trim((string) ($row['human_summary'] ?? ''))
            ?: trim((string) ($row['recommendation'] ?? ''))
            ?: (string) ($row['description'] ?? '');
        $row['display_recommendation'] = $row['human_summary'];
        $row['technical_recommendation'] = trim((string) ($row['recommendation'] ?? ''));
        $row['has_technical_recommendation'] = $row['technical_recommendation'] !== ''
            && $row['technical_recommendation'] !== $row['human_summary'];
        $row['developer_prompt'] = (string) ($row['developer_prompt'] ?? '');
        $row['validate_first'] = $isGap && ($row['mode'] ?? '') === 'validate_first';
        $row['evidence_image_data_uri'] = (string) ($related['image_data_uri'] ?? '');
        $row['evidence_screen_title'] = (string) ($related['screen_title'] ?? '');
        $row['evidence_screen_url'] = (string) ($related['screen_url'] ?? '');
        $row['evidence_captured_at'] = (string) ($related['captured_at'] ?? '');
        $inventory = $evidence['inventory_samples'] ?? $evidence['nearby_inventory'] ?? [];
        $inventory = is_array($inventory) ? $inventory : [];
        $first = is_array($inventory[0] ?? null) ? $inventory[0] : [];
        $selectors = $this->stringList($evidence['target_selectors'] ?? []);
        $row['evidence_target'] = (string) ($first['label'] ?? $first['selector'] ?? $selectors[0] ?? 'Affected screen region');
        $row['evidence_selector'] = (string) ($first['selector'] ?? $selectors[0] ?? 'Not captured');
        $row['evidence_expectation'] = $isGap && ($row['mode'] ?? '') === 'validate_first'
            ? 'Confirm existing coverage and product scope before implementation.'
            : (string) ($row['recommendation'] ?? '');
        // Template aliases used by older callouts / fallbacks.
        $row['visual_target'] = $row['evidence_target'];
        $row['visual_selector'] = $row['evidence_selector'];
        $row['visual_screen'] = $row['evidence_screen_url'] !== ''
            ? $row['evidence_screen_url']
            : ($row['evidence_screen_title'] !== '' ? $row['evidence_screen_title'] : 'See session context');
        $row['has_evidence_image'] = $row['evidence_image_data_uri'] !== '';
        $row['evidence_items'] = $this->readableEvidenceItems($evidence, $related);
        return $row;
    }

    private function readableEvidenceItems(array $evidence, ?array $related): array
    {
        $urls = $this->stringList($evidence['affected_urls'] ?? $evidence['screens_checked'] ?? $evidence['url'] ?? []);
        $titles = $this->stringList($evidence['screen_titles'] ?? []);
        $items = [];
        $count = max(count($urls), count($titles));
        for ($i = 0; $i < $count; $i++) {
            $items[] = [
                'screen_title' => $titles[$i] ?? 'Affected screen',
                'screen_url'   => $urls[$i] ?? '',
            ];
        }
        if ($related && ! in_array((string) ($related['screen_url'] ?? ''), $urls, true)) {
            array_unshift($items, [
                'screen_title' => (string) ($related['screen_title'] ?? 'Related screen'),
                'screen_url'   => (string) ($related['screen_url'] ?? ''),
            ]);
        }
        return $items;
    }

    private function matchScreenshot(array $finding, array $evidence, array $cards): ?array
    {
        $resultId = (int) ($finding['result_id'] ?? 0);
        $paths = $this->stringList($evidence['screenshot_paths'] ?? []);
        $urls = $this->stringList($evidence['affected_urls'] ?? $evidence['screens_checked'] ?? $evidence['url'] ?? []);
        $titles = $this->stringList($evidence['screen_titles'] ?? []);
        foreach ($cards as $card) {
            if ($resultId > 0 && $resultId === (int) ($card['result_id'] ?? 0)) return $card;
        }
        foreach ($cards as $card) {
            $cardPath = (string) ($card['screenshot_path'] ?? '');
            foreach ($paths as $path) {
                if ($path === $cardPath || ($path !== '' && basename($path) === basename($cardPath))) return $card;
            }
        }
        foreach ($cards as $card) {
            $cardUrl = rtrim((string) ($card['screen_url'] ?? ''), '/');
            foreach ($urls as $url) {
                if ($cardUrl !== '' && $cardUrl === rtrim($url, '/')) return $card;
            }
        }
        foreach ($cards as $card) {
            foreach ($titles as $title) {
                if ($title !== '' && strcasecmp($title, (string) ($card['screen_title'] ?? '')) === 0) return $card;
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

}
