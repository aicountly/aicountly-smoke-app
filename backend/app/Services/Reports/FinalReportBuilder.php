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
    public function build(int $runId): array
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
        ];

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

        $quickWins = $db->table('smoke_ux_issues')->where('run_id', $runId)->whereIn('severity', ['low', 'suggestion'])->limit(20)->get()->getResultArray();

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
            ];
        }

        $maturity = $this->maturityScore($severityCount, $totals);
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
            'ux_score'         => $uxAvg,
            'sessions'         => $perSession,
            'quick_wins'       => $quickWins,
            'missing_features' => $missingFeatures,
            'old_ui'           => $oldUi,
            'broken_screens'   => $brokenScreens,
            'generated_at'     => date(DATE_ATOM),
        ];

        $dir = $this->ensureDir($run['reports_dir']);
        $jsonPath = $dir . '/report.json';
        $htmlPath = $dir . '/index.html';
        file_put_contents($jsonPath, json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));

        $tplPath = realpath(WRITEPATH . '../../samples/reports/final.html.tpl');
        $tpl = $tplPath !== false && is_file($tplPath) ? (string) file_get_contents($tplPath) : (new SessionReportBuilder())->fallbackTemplate('final');
        $html = (new ReportRenderer())->render($tpl, $payload);
        file_put_contents($htmlPath, $html);

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

        return ['report_id' => $reportId, 'html_path' => $htmlPath, 'json_path' => $jsonPath];
    }

    private function maturityScore(array $severity, array $totals): float
    {
        $screens = max(1, (int) $totals['screens']);
        $weighted = 5 * (int) $severity['critical']
                  + 3 * (int) $severity['high']
                  + 1.5 * (int) $severity['medium']
                  + 0.5 * (int) $severity['low']
                  + 0.1 * (int) $severity['suggestion'];
        $gapPenalty = (int) $totals['gaps'];
        $score = 100 - ($weighted * 100 / ($screens * 5)) - ($gapPenalty * 0.5);
        return round(max(0, min(100, $score)), 2);
    }

    private function ensureDir(string $path): string
    {
        if (! is_dir($path)) {
            @mkdir($path, 0775, true);
        }
        return $path;
    }
}
