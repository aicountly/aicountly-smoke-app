<?php

namespace App\Controllers;

use CodeIgniter\HTTP\ResponseInterface;
use Config\Database;
use Config\Services;

class ObservationRunsController extends BaseController
{
    public function index(): ResponseInterface
    {
        $db = Database::connect();
        $q  = $db->table('smoke_observation_runs r')
            ->select('r.id, r.run_code, r.product_name, r.environment, r.status, r.sessions_total, r.sessions_done, r.sessions_failed, r.started_at, r.completed_at, r.created_at, p.profile_name')
            ->join('smoke_target_profiles p', 'p.id = r.target_profile_id', 'left')
            ->orderBy('r.created_at', 'DESC');

        // Optional filters
        $req = $this->request;
        foreach (['product_name', 'environment', 'status'] as $f) {
            $v = $req->getGet($f);
            if ($v !== null && $v !== '') {
                $q->where("r.{$f}", $v);
            }
        }
        if ($code = $req->getGet('run_code')) {
            $q->like('r.run_code', $code, 'both');
        }
        if ($from = $req->getGet('date_from')) {
            $q->where('r.created_at >=', $from);
        }
        if ($to = $req->getGet('date_to')) {
            $q->where('r.created_at <=', $to);
        }

        $rows = $q->limit(200)->get()->getResultArray();
        return $this->jsonOk(['data' => $rows]);
    }

    public function show(int $id): ResponseInterface
    {
        $db = Database::connect();
        $run = $db->table('smoke_observation_runs')->where('id', $id)->get()->getRowArray();
        if (! $run) {
            return $this->jsonError('not_found', 'Run not found', 404);
        }
        $sessions = $db->table('smoke_sessions s')
            ->select('s.*, j.id AS job_id, j.status AS job_status, j.attempts, j.last_error, j.leased_by, j.leased_at, j.lease_expires_at')
            ->join('smoke_session_jobs j', 'j.session_id = s.id AND j.run_id = ' . (int) $id, 'left')
            ->where('s.plan_id', $run['plan_id'])
            ->orderBy('s.ordinal', 'ASC')
            ->get()
            ->getResultArray();
        $reports = $db->table('smoke_reports')->where('run_id', $id)->get()->getResultArray();
        $worker = Services::workerStatus()->snapshot();
        return $this->jsonOk(['data' => $run, 'sessions' => $sessions, 'reports' => $reports, 'worker' => $worker]);
    }

    public function logs(int $id): ResponseInterface
    {
        $db = Database::connect();
        $run = $db->table('smoke_observation_runs')->where('id', $id)->get()->getRowArray();
        if (! $run) {
            return $this->jsonError('not_found', 'Run not found', 404);
        }
        $afterId = (int) ($this->request->getGet('after_id') ?? 0);
        $logs = Services::runLog()->forRun($id, $afterId > 0 ? $afterId : null);
        return $this->jsonOk(['data' => $logs]);
    }

    public function showByCode(string $code): ResponseInterface
    {
        $db = Database::connect();
        $run = $db->table('smoke_observation_runs')->where('run_code', $code)->get()->getRowArray();
        if (! $run) {
            return $this->jsonError('not_found', 'Run not found', 404);
        }
        return $this->show((int) $run['id']);
    }

    public function cancel(int $id): ResponseInterface
    {
        $db = Database::connect();
        $now = date('Y-m-d H:i:s');
        $db->transStart();
        $db->table('smoke_session_jobs')->where('run_id', $id)->whereIn('status', ['queued', 'leased', 'awaiting_decision'])->update([
            'status'     => 'cancelled',
            'updated_at' => $now,
        ]);
        $db->table('smoke_run_decisions')->where('run_id', $id)->where('status', 'pending')->update([
            'status'     => 'cancelled',
            'updated_at' => $now,
        ]);
        $db->table('smoke_observation_runs')->where('id', $id)->update([
            'status'       => 'cancelled',
            'completed_at' => $now,
            'updated_at'   => $now,
        ]);
        $db->transComplete();
        Services::audit()->record('runs.cancel', 'smoke_observation_runs', (string) $id, $this->user()?->id);
        return $this->jsonOk(['ok' => true]);
    }

    /**
     * Hard-delete a run and its logs, screenshots, and report files (DB + disk).
     */
    public function delete(int $id): ResponseInterface
    {
        try {
            $result = Services::observationCleanup()->deleteRun($id);
            Services::audit()->record(
                'runs.delete',
                'smoke_observation_runs',
                (string) $id,
                $this->user()?->id,
                $result,
            );
            return $this->jsonOk(['data' => $result]);
        } catch (\RuntimeException $e) {
            return $this->jsonError('not_found', $e->getMessage(), 404);
        }
    }

    /**
     * Full session log: worker log lines + captured screens/results + session reports.
     */
    public function sessionDetail(int $id, int $sessionId): ResponseInterface
    {
        $db = Database::connect();
        $run = $db->table('smoke_observation_runs')->where('id', $id)->get()->getRowArray();
        if (! $run) {
            return $this->jsonError('not_found', 'Run not found', 404);
        }
        $session = $db->table('smoke_sessions s')
            ->select('s.*, j.id AS job_id, j.status AS job_status, j.attempts, j.last_error, j.leased_by, j.leased_at, j.lease_expires_at')
            ->join('smoke_session_jobs j', 'j.session_id = s.id AND j.run_id = ' . (int) $id, 'left')
            ->where('s.id', $sessionId)
            ->where('s.plan_id', $run['plan_id'])
            ->get()
            ->getRowArray();
        if (! $session) {
            return $this->jsonError('not_found', 'Session not found on this run', 404);
        }

        $logs = Services::runLog()->forSession($id, $sessionId);
        $results = $db->table('smoke_observation_results')
            ->where('run_id', $id)
            ->where('session_id', $sessionId)
            ->orderBy('id', 'ASC')
            ->get()
            ->getResultArray();

        $resolver = new \App\Services\Reports\ReportArtifactResolver();
        $runReportsDir = (string) ($run['reports_dir'] ?? '');
        foreach ($results as &$row) {
            $path = (string) ($row['screenshot_path'] ?? '');
            $resolved = $path !== '' ? $resolver->resolveFile($path, $runReportsDir) : null;
            if ($resolved !== null && $resolved !== $path) {
                Database::connect()->table('smoke_observation_results')
                    ->where('id', (int) $row['id'])
                    ->update(['screenshot_path' => $resolved]);
                $path = $resolved;
            }
            $row['has_screenshot'] = $resolved !== null;
            $row['screenshot_url'] = $row['has_screenshot']
                ? "/runs/{$id}/results/{$row['id']}/screenshot"
                : null;
            // Never expose absolute server paths to the browser.
            unset($row['screenshot_path']);
        }
        unset($row);

        $reports = $db->table('smoke_reports')
            ->where('run_id', $id)
            ->where('session_id', $sessionId)
            ->orderBy('id', 'DESC')
            ->get()
            ->getResultArray();

        return $this->jsonOk([
            'session' => $session,
            'logs'    => $logs,
            'results' => $results,
            'reports' => $reports,
        ]);
    }

    public function resultScreenshot(int $id, int $resultId): ResponseInterface
    {
        $db = Database::connect();
        $row = $db->table('smoke_observation_results')
            ->where('id', $resultId)
            ->where('run_id', $id)
            ->get()
            ->getRowArray();
        if (! $row) {
            return $this->jsonError('not_found', 'Result not found', 404);
        }
        $run = $db->table('smoke_observation_runs')->where('id', $id)->get()->getRowArray();
        $resolver = new \App\Services\Reports\ReportArtifactResolver();
        $path = (string) ($row['screenshot_path'] ?? '');
        $resolved = $path !== '' ? $resolver->resolveFile($path, (string) ($run['reports_dir'] ?? '')) : null;
        if ($resolved === null) {
            return $this->jsonError('not_found', 'Screenshot file missing', 404);
        }
        if ($resolved !== $path) {
            $db->table('smoke_observation_results')->where('id', $resultId)->update(['screenshot_path' => $resolved]);
        }

        $mime = 'image/png';
        $ext = strtolower(pathinfo($resolved, PATHINFO_EXTENSION));
        if ($ext === 'jpg' || $ext === 'jpeg') {
            $mime = 'image/jpeg';
        } elseif ($ext === 'webp') {
            $mime = 'image/webp';
        }

        return $this->response
            ->setStatusCode(200)
            ->setHeader('Content-Type', $mime)
            ->setHeader('Cache-Control', 'private, max-age=300')
            ->setBody((string) file_get_contents($resolved));
    }

    public function rerunSession(int $id, int $sessionId): ResponseInterface
    {
        try {
            $result = Services::runner()->rerunSession($id, $sessionId, $this->user()?->id);
            return $this->jsonOk(['data' => $result]);
        } catch (\RuntimeException $e) {
            $msg = $e->getMessage();
            $code = str_contains($msg, 'not found') || str_contains($msg, 'does not belong') ? 404 : 409;
            return $this->jsonError('rerun_failed', $msg, $code);
        }
    }
}
