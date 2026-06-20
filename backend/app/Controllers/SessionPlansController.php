<?php

namespace App\Controllers;

use CodeIgniter\HTTP\ResponseInterface;
use Config\Database;
use Config\Services;

class SessionPlansController extends BaseController
{
    public function show(int $id): ResponseInterface
    {
        $db = Database::connect();
        $plan = $db->table('smoke_session_plans')->where('id', $id)->get()->getRowArray();
        if (! $plan) {
            return $this->jsonError('not_found', 'Session plan not found', 404);
        }
        $sessions = $db->table('smoke_sessions')->where('plan_id', $id)->orderBy('ordinal', 'ASC')->get()->getResultArray();
        return $this->jsonOk(['data' => $plan, 'sessions' => $sessions]);
    }

    public function update(int $id): ResponseInterface
    {
        $body = $this->jsonBody();
        $patch = [];
        if (isset($body['rationale'])) {
            $patch['rationale'] = (string) $body['rationale'];
        }
        if (isset($body['plan_json']) && is_array($body['plan_json'])) {
            $patch['plan_json'] = json_encode($body['plan_json']);
        }
        if ($patch === []) {
            return $this->jsonError('invalid_request', 'No editable fields supplied.', 400);
        }
        $patch['updated_at'] = date('Y-m-d H:i:s');
        Database::connect()->table('smoke_session_plans')->where('id', $id)->update($patch);
        Services::audit()->record('session_plans.update', 'smoke_session_plans', (string) $id, $this->user()?->id, ['fields' => array_keys($patch)]);
        return $this->jsonOk(['ok' => true]);
    }

    public function addSession(int $id): ResponseInterface
    {
        $db = Database::connect();
        if ($db->table('smoke_session_plans')->where('id', $id)->countAllResults() === 0) {
            return $this->jsonError('not_found', 'Session plan not found', 404);
        }
        $body = $this->jsonBody();
        $maxOrd = (int) ($db->table('smoke_sessions')->select('COALESCE(MAX(ordinal),0) AS o')->where('plan_id', $id)->get()->getRow()->o ?? 0);

        $db->table('smoke_sessions')->insert([
            'plan_id'             => $id,
            'ordinal'             => $maxOrd + 1,
            'name'                => trim((string) ($body['name'] ?? ('Session ' . ($maxOrd + 1)))),
            'menu_path'           => (string) ($body['menu_path'] ?? ''),
            'description'         => (string) ($body['description'] ?? ''),
            'scope_json'          => json_encode($body['scope'] ?? []),
            'allowed_actions_json'=> json_encode($body['allowed_actions'] ?? []),
            'destructive_allowed' => (bool) ($body['destructive_allowed'] ?? false),
            'expected_screens'    => (int) ($body['expected_screens'] ?? 0),
            'status'              => 'pending',
        ]);
        $sid = (int) $db->insertID();
        $this->bumpSessionCount($id);
        Services::audit()->record('session_plans.add_session', 'smoke_session_plans', (string) $id, $this->user()?->id, ['session_id' => $sid]);
        return $this->jsonOk(['id' => $sid], 201);
    }

    public function reorder(int $id): ResponseInterface
    {
        $body = $this->jsonBody();
        $order = $body['order'] ?? [];
        if (! is_array($order)) {
            return $this->jsonError('invalid_request', 'order must be an array of session ids in the desired order.', 400);
        }
        $db = Database::connect();
        $ord = 1;
        foreach ($order as $sid) {
            $sid = (int) $sid;
            if ($sid <= 0) continue;
            $db->table('smoke_sessions')->where('id', $sid)->where('plan_id', $id)->update(['ordinal' => $ord]);
            $ord++;
        }
        Services::audit()->record('session_plans.reorder', 'smoke_session_plans', (string) $id, $this->user()?->id, ['count' => $ord - 1]);
        return $this->jsonOk(['ok' => true]);
    }

    public function approve(int $id): ResponseInterface
    {
        $db = Database::connect();
        $plan = $db->table('smoke_session_plans')->where('id', $id)->get()->getRow();
        if (! $plan) {
            return $this->jsonError('not_found', 'Plan not found', 404);
        }
        if ($plan->status === 'approved') {
            return $this->jsonOk(['ok' => true, 'already' => true]);
        }
        $db->table('smoke_session_plans')->where('id', $id)->update([
            'status'      => 'approved',
            'approved_by' => $this->user()?->id,
            'approved_at' => date('Y-m-d H:i:s'),
            'updated_at'  => date('Y-m-d H:i:s'),
        ]);
        Services::audit()->record('session_plans.approve', 'smoke_session_plans', (string) $id, $this->user()?->id);
        return $this->jsonOk(['ok' => true]);
    }

    public function reject(int $id): ResponseInterface
    {
        $body = $this->jsonBody();
        Database::connect()->table('smoke_session_plans')->where('id', $id)->update([
            'status'         => 'rejected',
            'rejected_reason'=> (string) ($body['reason'] ?? ''),
            'updated_at'     => date('Y-m-d H:i:s'),
        ]);
        Services::audit()->record('session_plans.reject', 'smoke_session_plans', (string) $id, $this->user()?->id, ['reason' => $body['reason'] ?? '']);
        return $this->jsonOk(['ok' => true]);
    }

    public function startRun(int $id): ResponseInterface
    {
        $db = Database::connect();
        $plan = $db->table('smoke_session_plans')->where('id', $id)->get()->getRow();
        if (! $plan) {
            return $this->jsonError('not_found', 'Plan not found', 404);
        }
        if ($plan->status !== 'approved') {
            return $this->jsonError('precondition_failed', 'Plan must be approved before starting a run.', 412);
        }
        $run = Services::runner()->startRun((int) $id, $this->user()?->id);
        return $this->jsonOk(['data' => $run], 201);
    }

    private function bumpSessionCount(int $planId): void
    {
        $db = Database::connect();
        $count = (int) ($db->table('smoke_sessions')->where('plan_id', $planId)->countAllResults());
        $db->table('smoke_session_plans')->where('id', $planId)->update([
            'session_count' => $count,
            'updated_at'    => date('Y-m-d H:i:s'),
        ]);
    }
}
