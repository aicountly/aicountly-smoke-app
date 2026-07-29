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
        $featureGapRow  = $db->query(<<<'SQL'
WITH catalog_expanded AS (
    SELECT
        profile.product_name,
        BTRIM(
            REGEXP_REPLACE(
                REGEXP_REPLACE(LOWER(feature.value), '[^a-z0-9 ]+', ' ', 'g'),
                ' +',
                ' ',
                'g'
            )
        ) AS feature_key
    FROM smoke_competitor_profiles AS profile
    CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS_TEXT(
        CASE
            WHEN JSONB_TYPEOF(profile.feature_list_json) = 'array'
                THEN profile.feature_list_json
            ELSE '[]'::jsonb
        END
    ) AS feature(value)
    WHERE profile.enabled = TRUE
),
catalog AS (
    SELECT
        product_name,
        feature_key
    FROM catalog_expanded
    WHERE feature_key <> ''
    GROUP BY product_name, feature_key
),
latest_runs AS (
    SELECT DISTINCT ON (product_name)
        product_name,
        id AS run_id
    FROM smoke_observation_runs
    WHERE status = 'completed'
    ORDER BY product_name, completed_at DESC NULLS LAST, id DESC
),
evidence AS (
    SELECT
        latest.product_name,
        gaps.expected_feature AS feature_key,
        BOOL_OR(gaps.observed) AS observed_any,
        BOOL_OR(gaps.partial AND NOT gaps.observed) AS partial_any
    FROM latest_runs AS latest
    INNER JOIN smoke_feature_gaps AS gaps
        ON gaps.run_id = latest.run_id
    GROUP BY latest.product_name, gaps.expected_feature
),
missing_by_product AS (
    SELECT
        catalog.product_name,
        COUNT(*) AS missing_count
    FROM catalog
    LEFT JOIN evidence
        ON evidence.product_name = catalog.product_name
        AND evidence.feature_key = catalog.feature_key
    WHERE NOT COALESCE(evidence.observed_any, FALSE)
        AND NOT COALESCE(evidence.partial_any, FALSE)
    GROUP BY catalog.product_name
)
SELECT COALESCE(SUM(missing_count), 0) AS feature_gaps
FROM missing_by_product
SQL)->getRowArray();
        $featureGaps    = (int) ($featureGapRow['feature_gaps'] ?? 0);
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
            ->select('run.product_name AS product_name, AVG(COALESCE(r.maturity_score,0)) AS maturity_avg, AVG(COALESCE(r.ux_score,0)) AS ux_avg, COUNT(*) AS reports', false)
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
