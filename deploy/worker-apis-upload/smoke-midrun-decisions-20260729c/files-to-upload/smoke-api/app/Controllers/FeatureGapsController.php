<?php

namespace App\Controllers;

use CodeIgniter\HTTP\ResponseInterface;
use Config\Database;

class FeatureGapsController extends BaseController
{
    public function index(int $runId): ResponseInterface
    {
        $db = Database::connect();
        $q  = $db->table('smoke_feature_gaps')->where('run_id', $runId);
        foreach (['severity', 'product_name', 'observed', 'partial'] as $f) {
            $v = $this->request->getGet($f);
            if ($v !== null && $v !== '') {
                if ($f === 'observed' || $f === 'partial') {
                    $q->where($f, in_array($v, ['1', 'true', 'yes'], true) ? 'true' : 'false');
                } else {
                    $q->where($f, $v);
                }
            }
        }
        $rows = $q->orderBy(
            "CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END",
            'ASC',
            false,
        )->limit(1000)->get()->getResultArray();
        foreach ($rows as &$row) {
            $row['observed'] = $this->asBool($row['observed'] ?? false);
            $row['partial'] = $this->asBool($row['partial'] ?? false);
            $row['human_summary'] = (string) ($row['human_summary'] ?? '');
            $row['developer_prompt'] = (string) ($row['developer_prompt'] ?? '');
        }
        unset($row);
        return $this->jsonOk(['data' => $rows]);
    }

    public function matrix(): ResponseInterface
    {
        $db = Database::connect();
        $sql = <<<'SQL'
WITH catalog_expanded AS (
    SELECT
        profile.product_name,
        feature.value AS display_label,
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
        feature_key,
        MIN(display_label) AS display_label
    FROM catalog_expanded
    WHERE feature_key <> ''
    GROUP BY product_name, feature_key
),
latest_runs AS (
    SELECT DISTINCT ON (product_name)
        product_name,
        id AS run_id,
        run_code
    FROM smoke_observation_runs
    WHERE status = 'completed'
    ORDER BY product_name, completed_at DESC NULLS LAST, id DESC
),
evidence AS (
    SELECT
        latest.product_name,
        gaps.expected_feature AS feature_key,
        BOOL_OR(gaps.observed) AS observed_any,
        BOOL_OR(gaps.partial AND NOT gaps.observed) AS partial_any,
        CASE MIN(
            CASE LOWER(gaps.severity)
                WHEN 'critical' THEN 1
                WHEN 'high' THEN 2
                WHEN 'medium' THEN 3
                WHEN 'low' THEN 4
                WHEN 'suggestion' THEN 5
                ELSE 6
            END
        )
            WHEN 1 THEN 'critical'
            WHEN 2 THEN 'high'
            WHEN 3 THEN 'medium'
            WHEN 4 THEN 'low'
            WHEN 5 THEN 'suggestion'
            ELSE NULL
        END AS severity
    FROM latest_runs AS latest
    INNER JOIN smoke_feature_gaps AS gaps
        ON gaps.run_id = latest.run_id
    GROUP BY latest.product_name, gaps.expected_feature
)
SELECT
    catalog.product_name,
    catalog.display_label AS expected_feature,
    CASE
        WHEN COALESCE(evidence.observed_any, FALSE) THEN 'present'
        WHEN COALESCE(evidence.partial_any, FALSE) THEN 'partial'
        ELSE 'missing'
    END AS status,
    COALESCE(evidence.observed_any, FALSE) AS observed_any,
    COALESCE(evidence.partial_any, FALSE) AS partial_any,
    CASE
        WHEN evidence.feature_key IS NULL THEN NULL
        ELSE NULLIF(evidence.severity, '')
    END AS severity,
    latest.run_id,
    latest.run_code
FROM catalog
LEFT JOIN latest_runs AS latest
    ON latest.product_name = catalog.product_name
LEFT JOIN evidence
    ON evidence.product_name = catalog.product_name
    AND evidence.feature_key = catalog.feature_key
ORDER BY catalog.product_name ASC, catalog.display_label ASC
SQL;
        $rows = $db->query($sql)->getResultArray();
        foreach ($rows as &$row) {
            $row['observed_any'] = $this->asBool($row['observed_any'] ?? false);
            $row['partial_any'] = $this->asBool($row['partial_any'] ?? false);
            // The matrix API represents absent severity evidence as JSON null.
            $row['severity'] = ($row['severity'] ?? '') === '' ? null : $row['severity'];
            $row['run_id'] = $row['run_id'] === null ? null : (int) $row['run_id'];
        }
        unset($row);
        return $this->jsonOk(['data' => $rows]);
    }

    private function asBool(mixed $value): bool
    {
        return $value === true
            || $value === 1
            || in_array($value, ['1', 't', 'true'], true);
    }
}
