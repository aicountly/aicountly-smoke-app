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
            ->select('s.*, j.status AS job_status, j.attempts, j.last_error')
            ->join('smoke_session_jobs j', 'j.session_id = s.id AND j.run_id = ' . (int) $id, 'left')
            ->where('s.plan_id', $run['plan_id'])
            ->orderBy('s.ordinal', 'ASC')
            ->get()
            ->getResultArray();
        $reports = $db->table('smoke_reports')->where('run_id', $id)->get()->getResultArray();
        return $this->jsonOk(['data' => $run, 'sessions' => $sessions, 'reports' => $reports]);
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
        $db->table('smoke_session_jobs')->where('run_id', $id)->whereIn('status', ['queued', 'leased'])->update([
            'status'     => 'cancelled',
            'updated_at' => date('Y-m-d H:i:s'),
        ]);
        $db->table('smoke_observation_runs')->where('id', $id)->update([
            'status'       => 'cancelled',
            'completed_at' => date('Y-m-d H:i:s'),
            'updated_at'   => date('Y-m-d H:i:s'),
        ]);
        Services::audit()->record('runs.cancel', 'smoke_observation_runs', (string) $id, $this->user()?->id);
        return $this->jsonOk(['ok' => true]);
    }
}
