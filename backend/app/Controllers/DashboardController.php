<?php

namespace App\Controllers;

use CodeIgniter\HTTP\ResponseInterface;
use Config\Database;

class DashboardController extends BaseController
{
    public function summary(): ResponseInterface
    {
        $db = Database::connect();

        $totalRuns      = (int) $db->table('smoke_observation_runs')->countAllResults();
        $screensScanned = (int) $db->table('smoke_observation_results')->countAllResults();
        $featureGaps    = (int) $db->table('smoke_feature_gaps')->where('observed', false)->countAllResults();
        $uxIssues       = (int) $db->table('smoke_ux_issues')->countAllResults();

        $oldThemePages  = (int) $db->table('smoke_ux_issues')->where('category', 'old_theme')->countAllResults();
        $criticalUI     = (int) $db->table('smoke_ux_issues')->where('severity', 'critical')->countAllResults();

        $lastRun = $db->table('smoke_observation_runs')
            ->select('id, run_code, product_name, environment, status, started_at, completed_at, sessions_total, sessions_done, sessions_failed')
            ->orderBy('created_at', 'DESC')
            ->limit(1)
            ->get()
            ->getRowArray();

        $byProduct = $db->table('smoke_reports r')
            ->select('run.product_name AS product_name, AVG(COALESCE(r.maturity_score,0)) AS maturity_avg, AVG(COALESCE(r.ux_score,0)) AS ux_avg, COUNT(*) AS reports')
            ->join('smoke_observation_runs run', 'run.id = r.run_id')
            ->where('r.kind', 'final')
            ->groupBy('run.product_name')
            ->get()
            ->getResultArray();

        $recentReports = $db->table('smoke_reports r')
            ->select('r.id, r.kind, r.title, r.maturity_score, r.ux_score, r.created_at, run.run_code, run.product_name, run.environment')
            ->join('smoke_observation_runs run', 'run.id = r.run_id')
            ->orderBy('r.created_at', 'DESC')
            ->limit(10)
            ->get()
            ->getResultArray();

        return $this->jsonOk([
            'cards' => [
                'total_observations' => $totalRuns,
                'screens_scanned'    => $screensScanned,
                'feature_gaps'       => $featureGaps,
                'ux_issues'          => $uxIssues,
                'old_theme_pages'    => $oldThemePages,
                'critical_ui_issues' => $criticalUI,
            ],
            'last_run'         => $lastRun,
            'product_scores'   => $byProduct,
            'recent_reports'   => $recentReports,
        ]);
    }
}
