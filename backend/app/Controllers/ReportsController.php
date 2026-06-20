<?php

namespace App\Controllers;

use CodeIgniter\HTTP\ResponseInterface;
use Config\Database;

class ReportsController extends BaseController
{
    public function index(): ResponseInterface
    {
        $db = Database::connect();
        $q  = $db->table('smoke_reports r')
            ->select('r.id, r.run_id, r.session_id, r.kind, r.title, r.maturity_score, r.ux_score, r.html_path, r.json_path, r.auditor_visible, r.created_at, run.run_code, run.product_name, run.environment')
            ->join('smoke_observation_runs run', 'run.id = r.run_id', 'left')
            ->orderBy('r.created_at', 'DESC');

        $req = $this->request;
        foreach (['kind'] as $f) {
            $v = $req->getGet($f);
            if ($v) $q->where("r.{$f}", $v);
        }
        if ($p = $req->getGet('product_name')) {
            $q->where('run.product_name', $p);
        }
        if ($e = $req->getGet('environment')) {
            $q->where('run.environment', $e);
        }

        // Auditor viewer can only see auditor_visible reports
        $roles = $this->userRoles();
        if (! in_array('owner', $roles, true) && ! in_array('product_reviewer', $roles, true) && ! in_array('developer_viewer', $roles, true)) {
            $q->where('r.auditor_visible', true);
        }

        return $this->jsonOk(['data' => $q->limit(200)->get()->getResultArray()]);
    }

    public function show(int $id): ResponseInterface
    {
        $db = Database::connect();
        $row = $db->table('smoke_reports')->where('id', $id)->get()->getRowArray();
        if (! $row) {
            return $this->jsonError('not_found', 'Report not found', 404);
        }
        return $this->jsonOk(['data' => $row]);
    }

    public function html(int $id): ResponseInterface
    {
        $row = Database::connect()->table('smoke_reports')->where('id', $id)->get()->getRowArray();
        if (! $row || ! is_file((string) $row['html_path'])) {
            return $this->jsonError('not_found', 'HTML report file missing', 404);
        }
        return $this->response
            ->setStatusCode(200)
            ->setHeader('Content-Type', 'text/html; charset=utf-8')
            ->setBody((string) file_get_contents($row['html_path']));
    }

    public function json(int $id): ResponseInterface
    {
        $row = Database::connect()->table('smoke_reports')->where('id', $id)->get()->getRowArray();
        if (! $row || ! is_file((string) $row['json_path'])) {
            return $this->jsonError('not_found', 'JSON report file missing', 404);
        }
        return $this->response
            ->setStatusCode(200)
            ->setHeader('Content-Type', 'application/json')
            ->setBody((string) file_get_contents($row['json_path']));
    }

    public function files(int $id): ResponseInterface
    {
        $files = Database::connect()->table('smoke_report_files')->where('report_id', $id)->get()->getResultArray();
        return $this->jsonOk(['data' => $files]);
    }
}
