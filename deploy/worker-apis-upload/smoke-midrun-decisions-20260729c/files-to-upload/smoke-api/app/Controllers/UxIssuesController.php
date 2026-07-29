<?php

namespace App\Controllers;

use CodeIgniter\HTTP\ResponseInterface;
use Config\Database;

class UxIssuesController extends BaseController
{
    public function index(int $runId): ResponseInterface
    {
        $db = Database::connect();
        $q  = $db->table('smoke_ux_issues')->where('run_id', $runId);
        foreach (['severity', 'category'] as $f) {
            if ($v = $this->request->getGet($f)) $q->where($f, $v);
        }
        $rows = $q->orderBy(
            "CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END",
            'ASC',
            false,
        )->limit(1000)->get()->getResultArray();
        foreach ($rows as &$row) {
            $row['human_summary'] = (string) ($row['human_summary'] ?? '');
            $row['developer_prompt'] = (string) ($row['developer_prompt'] ?? '');
        }
        unset($row);
        return $this->jsonOk(['data' => $rows]);
    }
}
