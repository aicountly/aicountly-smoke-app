<?php

namespace App\Controllers;

use App\Services\Reports\ReportArtifactResolver;
use CodeIgniter\HTTP\ResponseInterface;
use Config\Database;
use Config\Services;

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
        $body = $this->loadReportBody($id, 'html');
        if ($body === null) {
            return $this->jsonError('not_found', 'HTML report file missing', 404);
        }
        return $this->response
            ->setStatusCode(200)
            ->setHeader('Content-Type', 'text/html; charset=utf-8')
            ->setBody($body);
    }

    public function json(int $id): ResponseInterface
    {
        $body = $this->loadReportBody($id, 'json');
        if ($body === null) {
            return $this->jsonError('not_found', 'JSON report file missing', 404);
        }
        return $this->response
            ->setStatusCode(200)
            ->setHeader('Content-Type', 'application/json')
            ->setBody($body);
    }

    public function files(int $id): ResponseInterface
    {
        $files = Database::connect()->table('smoke_report_files')->where('report_id', $id)->get()->getResultArray();
        return $this->jsonOk(['data' => $files]);
    }

    /**
     * Load report file contents, remapping worker paths onto REPORTS_DIR.
     * If the file is still missing, rebuild session/final content from DB.
     */
    private function loadReportBody(int $id, string $format): ?string
    {
        $db = Database::connect();
        $row = $db->table('smoke_reports')->where('id', $id)->get()->getRowArray();
        if (! $row) {
            return null;
        }

        $run = null;
        if (! empty($row['run_id'])) {
            $run = $db->table('smoke_observation_runs')->where('id', (int) $row['run_id'])->get()->getRowArray();
        }
        $reportsDir = $run['reports_dir'] ?? null;
        $resolver = new ReportArtifactResolver();
        $pathKey = $format === 'html' ? 'html_path' : 'json_path';
        $resolved = $resolver->resolveFile((string) ($row[$pathKey] ?? ''), $reportsDir);

        if ($resolved !== null) {
            if ($resolved !== (string) $row[$pathKey]) {
                $db->table('smoke_reports')->where('id', $id)->update([$pathKey => $resolved]);
            }
            return (string) file_get_contents($resolved);
        }

        // Rebuild from DB so HTML/JSON buttons work even when worker paths are unreachable.
        try {
            if (($row['kind'] ?? '') === 'session' && ! empty($row['session_id']) && ! empty($row['run_id'])) {
                $built = Services::sessionReport()->build((int) $row['run_id'], (int) $row['session_id'], [], false);
                $builtPath = $format === 'html' ? ($built['html_path'] ?? '') : ($built['json_path'] ?? '');
                if ($builtPath !== '' && is_file($builtPath)) {
                    $db->table('smoke_reports')->where('id', $id)->update([
                        'html_path' => $built['html_path'],
                        'json_path' => $built['json_path'],
                    ]);
                    return (string) file_get_contents($builtPath);
                }
            }
            if (($row['kind'] ?? '') === 'final' && ! empty($row['run_id'])) {
                // Prefer regenerating payload without inserting a duplicate final report.
                $built = Services::finalReport()->build((int) $row['run_id'], false);
                $builtPath = $format === 'html' ? ($built['html_path'] ?? '') : ($built['json_path'] ?? '');
                if ($builtPath !== '' && is_file($builtPath)) {
                    $db->table('smoke_reports')->where('id', $id)->update([
                        'html_path' => $built['html_path'],
                        'json_path' => $built['json_path'],
                    ]);
                    return (string) file_get_contents($builtPath);
                }
            }
        } catch (\Throwable $e) {
            log_message('error', 'Report rebuild failed for #{id}: {msg}', [
                'id'  => $id,
                'msg' => $e->getMessage(),
            ]);
        }

        return $this->syntheticReportBody($row, $format);
    }

    /**
     * Last-resort body from smoke_reports row columns so the UI never hard-fails.
     */
    private function syntheticReportBody(array $row, string $format): string
    {
        $metrics = json_decode((string) ($row['metrics_json'] ?? '{}'), true) ?: [];
        $severity = json_decode((string) ($row['severity_summary_json'] ?? '{}'), true) ?: [];
        $payload = [
            'id'               => (int) ($row['id'] ?? 0),
            'run_id'           => (int) ($row['run_id'] ?? 0),
            'session_id'       => $row['session_id'] ?? null,
            'kind'             => $row['kind'] ?? 'session',
            'title'            => $row['title'] ?? 'Report',
            'ux_score'         => $row['ux_score'] ?? null,
            'maturity_score'   => $row['maturity_score'] ?? null,
            'metrics'          => $metrics,
            'severity_summary' => $severity,
            'note'             => 'Rebuilt from database because the original report file was not found on this host.',
            'generated_at'     => date(DATE_ATOM),
        ];

        if ($format === 'json') {
            return (string) json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        }

        $title = htmlspecialchars((string) $payload['title'], ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
        $ux = htmlspecialchars((string) ($payload['ux_score'] ?? '—'), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
        $mat = htmlspecialchars((string) ($payload['maturity_score'] ?? '—'), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
        $metricsHtml = htmlspecialchars((string) json_encode($metrics, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
        return '<!doctype html><html><head><meta charset="utf-8"><title>' . $title . '</title>'
            . '<style>body{font:14px/1.5 system-ui;margin:32px;color:#0f172a}pre{background:#f8fafc;padding:12px;border-radius:8px}</style>'
            . '</head><body><h1>' . $title . '</h1>'
            . '<p>UX score: <strong>' . $ux . '</strong> &middot; Maturity: <strong>' . $mat . '</strong></p>'
            . '<p style="color:#64748b">' . htmlspecialchars((string) $payload['note'], ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '</p>'
            . '<h2>Metrics</h2><pre>' . $metricsHtml . '</pre></body></html>';
    }
}
