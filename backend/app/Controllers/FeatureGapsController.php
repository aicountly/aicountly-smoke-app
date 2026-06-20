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
        return $this->jsonOk(['data' => $rows]);
    }

    public function matrix(): ResponseInterface
    {
        $db = Database::connect();
        $rows = $db->table('smoke_feature_gaps')
            ->select('product_name, expected_feature, BOOL_OR(observed) AS observed_any, MAX(severity) AS severity')
            ->groupBy(['product_name', 'expected_feature'])
            ->orderBy('product_name', 'ASC')
            ->orderBy('expected_feature', 'ASC')
            ->limit(2000)
            ->get()
            ->getResultArray();
        return $this->jsonOk(['data' => $rows]);
    }
}
