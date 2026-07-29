<?php

namespace App\Controllers;

use CodeIgniter\HTTP\ResponseInterface;
use Config\Database;
use Config\Services;

/**
 * Worker-side endpoints. Authenticated via WorkerTokenFilter (X-Worker-Token).
 * Never use JWT here. Also never include AI provider keys -- the worker calls
 * /worker/brain/invoke to delegate council inference back through PHP.
 */
class WorkerController extends BaseController
{
    public function lease(): ResponseInterface
    {
        $body = $this->jsonBody();
        $workerId = (string) ($body['worker_id'] ?? '');
        $leaseSec = max(60, min(3600, (int) ($body['lease_seconds'] ?? 600)));
        if ($workerId === '') {
            return $this->jsonError('invalid_request', 'worker_id is required.', 400);
        }
        $job = Services::runner()->leaseNextJob($workerId, $leaseSec);
        if (! $job) {
            return $this->jsonOk(['data' => null]);
        }
        return $this->jsonOk(['data' => $job]);
    }

    public function heartbeat(int $jobId): ResponseInterface
    {
        $db  = Database::connect();
        $sec = max(60, min(3600, (int) ($this->jsonBody()['lease_seconds'] ?? 600)));
        $db->table('smoke_session_jobs')->where('id', $jobId)->update([
            'lease_expires_at' => date('Y-m-d H:i:s', time() + $sec),
            'updated_at'       => date('Y-m-d H:i:s'),
        ]);
        return $this->jsonOk(['ok' => true]);
    }

    public function complete(int $jobId): ResponseInterface
    {
        Services::runner()->markComplete($jobId, $this->jsonBody());
        return $this->jsonOk(['ok' => true]);
    }

    public function fail(int $jobId): ResponseInterface
    {
        $body = $this->jsonBody();
        $err  = (string) ($body['error'] ?? 'unspecified worker error');
        Services::runner()->markFailed($jobId, $err);
        return $this->jsonOk(['ok' => true]);
    }

    public function decryptCredential(int $profileId): ResponseInterface
    {
        $plain = Services::vault()->decryptForProfile($profileId);
        if ($plain === null) {
            return $this->jsonError('not_found', 'No credential stored for that profile', 404);
        }
        Services::audit()->record('worker.credential_decrypt', 'smoke_credentials', (string) $profileId, null, [
            'requester' => 'worker',
        ]);
        return $this->jsonOk([
            'plaintext' => $plain,
            'expires_in_seconds' => 60,
        ]);
    }

    public function recordResult(): ResponseInterface
    {
        $body = $this->jsonBody();
        $required = ['run_id', 'session_id'];
        foreach ($required as $f) {
            if (empty($body[$f])) {
                return $this->jsonError('invalid_request', "{$f} is required", 400);
            }
        }
        $db = Database::connect();
        $runId = (int) $body['run_id'];
        $run = $db->table('smoke_observation_runs')->where('id', $runId)->get()->getRowArray();
        $resolver = new \App\Services\Reports\ReportArtifactResolver();
        $shot = (string) ($body['screenshot_path'] ?? '');
        $shot = $resolver->resolveFile($shot, (string) ($run['reports_dir'] ?? '')) ?? $shot;

        $db->table('smoke_observation_results')->insert([
            'run_id'              => $runId,
            'session_id'          => (int) $body['session_id'],
            'screen_url'          => (string) ($body['screen_url']     ?? ''),
            'screen_title'        => (string) ($body['screen_title']   ?? ''),
            'module_name'         => (string) ($body['module_name']    ?? ''),
            'screenshot_path'     => $shot,
            'page_metadata_json'  => json_encode($body['page_metadata']  ?? []),
            'console_errors_json' => json_encode($body['console_errors']?? []),
            'network_errors_json' => json_encode($body['network_errors']?? []),
            'performance_json'    => json_encode($body['performance']   ?? []),
            // Explicit Asia/Kolkata wall-clock (app.appTimezone), not DB server UTC.
            'captured_at'         => date('Y-m-d H:i:s'),
        ]);
        return $this->jsonOk(['id' => (int) $db->insertID()]);
    }

    public function recordInventory(): ResponseInterface
    {
        $body = $this->jsonBody();
        Database::connect()->table('smoke_ui_inventory')->insert([
            'run_id'      => (int) ($body['run_id']    ?? 0),
            'session_id'  => (int) ($body['session_id']?? 0),
            'result_id'   => (int) ($body['result_id'] ?? 0) ?: null,
            'kind'        => (string) ($body['kind']    ?? 'unknown'),
            'label'       => (string) ($body['label']   ?? ''),
            'selector'    => (string) ($body['selector']?? ''),
            'url'         => (string) ($body['url']     ?? ''),
            'payload_json'=> json_encode($body['payload'] ?? []),
        ]);
        return $this->jsonOk(['ok' => true]);
    }

    public function recordUxIssue(): ResponseInterface
    {
        $body = $this->jsonBody();
        Database::connect()->table('smoke_ux_issues')->insert([
            'run_id'          => (int) ($body['run_id']    ?? 0),
            'session_id'      => (int) ($body['session_id']?? 0),
            'result_id'       => (int) ($body['result_id'] ?? 0) ?: null,
            'category'        => (string) ($body['category'] ?? 'general'),
            'severity'        => (string) ($body['severity'] ?? 'low'),
            'title'           => (string) ($body['title']    ?? ''),
            'description'     => (string) ($body['description']    ?? ''),
            'recommendation'  => (string) ($body['recommendation'] ?? ''),
            'developer_prompt'=> (string) ($body['developer_prompt']?? ''),
            'evidence_json'   => json_encode($body['evidence'] ?? []),
        ]);
        return $this->jsonOk(['ok' => true]);
    }

    public function recordFeatureGap(): ResponseInterface
    {
        $body = $this->jsonBody();
        Database::connect()->table('smoke_feature_gaps')->insert([
            'run_id'          => (int) ($body['run_id'] ?? 0),
            'session_id'      => (int) ($body['session_id'] ?? 0) ?: null,
            'product_name'    => (string) ($body['product_name']     ?? ''),
            'expected_feature'=> (string) ($body['expected_feature'] ?? ''),
            'observed'        => (bool) ($body['observed'] ?? false),
            'partial'         => (bool) ($body['partial']  ?? false),
            'competitor_ref'  => (string) ($body['competitor_ref'] ?? ''),
            'severity'        => (string) ($body['severity']       ?? 'medium'),
            'recommendation'  => (string) ($body['recommendation'] ?? ''),
            'developer_prompt'=> (string) ($body['developer_prompt']?? ''),
            'notes'           => (string) ($body['notes'] ?? ''),
            'sources_json'    => json_encode($body['sources'] ?? []),
        ]);
        return $this->jsonOk(['ok' => true]);
    }

    public function recordReport(): ResponseInterface
    {
        $body = $this->jsonBody();
        $db = Database::connect();
        $runId = (int) ($body['run_id'] ?? 0);
        $run = $runId > 0
            ? $db->table('smoke_observation_runs')->where('id', $runId)->get()->getRowArray()
            : null;
        $resolver = new \App\Services\Reports\ReportArtifactResolver();
        $reportsDir = (string) ($run['reports_dir'] ?? '');
        $htmlPath = (string) ($body['html_path'] ?? '');
        $jsonPath = (string) ($body['json_path'] ?? '');
        $htmlPath = $resolver->resolveFile($htmlPath, $reportsDir) ?? $htmlPath;
        $jsonPath = $resolver->resolveFile($jsonPath, $reportsDir) ?? $jsonPath;

        $db->table('smoke_reports')->insert([
            'run_id'                => $runId,
            'session_id'            => (int) ($body['session_id'] ?? 0) ?: null,
            'kind'                  => (string) ($body['kind']  ?? 'session'),
            'title'                 => (string) ($body['title'] ?? 'Session report'),
            'severity_summary_json' => json_encode($body['severity_summary'] ?? []),
            'metrics_json'          => json_encode($body['metrics'] ?? []),
            'maturity_score'        => isset($body['maturity_score']) ? (float) $body['maturity_score'] : null,
            'ux_score'              => isset($body['ux_score']) ? (float) $body['ux_score'] : null,
            'html_path'             => $htmlPath,
            'json_path'             => $jsonPath,
            'auditor_visible'       => (bool) ($body['auditor_visible'] ?? false),
        ]);
        return $this->jsonOk(['id' => (int) $db->insertID()]);
    }

    public function finalizeRun(int $runId): ResponseInterface
    {
        Services::runner()->finalizeRunIfDone($runId);
        return $this->jsonOk(['ok' => true]);
    }

    public function appendLog(): ResponseInterface
    {
        $body = $this->jsonBody();
        $message = trim((string) ($body['message'] ?? ''));
        if ($message === '') {
            return $this->jsonError('invalid_request', 'message is required.', 400);
        }
        Services::runLog()->append(
            isset($body['run_id']) ? (int) $body['run_id'] : null,
            isset($body['session_id']) ? (int) $body['session_id'] : null,
            isset($body['job_id']) ? (int) $body['job_id'] : null,
            (string) ($body['source'] ?? 'worker'),
            (string) ($body['level'] ?? 'info'),
            $message,
            is_array($body['context'] ?? null) ? $body['context'] : [],
        );
        return $this->jsonOk(['ok' => true]);
    }

    /**
     * Delegate council inference so the worker never holds provider API keys.
     */
    public function brainInvoke(): ResponseInterface
    {
        $body = $this->jsonBody();
        $task = (string) ($body['task'] ?? 'plan');
        $sys  = (string) ($body['system_prompt'] ?? '');
        $usr  = (string) ($body['user_prompt']   ?? '');
        $ctx  = (array)  ($body['context']       ?? []);

        if ($sys === '' || $usr === '') {
            return $this->jsonError('invalid_request', 'system_prompt and user_prompt are required.', 400);
        }

        $result = Services::brain()->invoke($task, $sys, $usr, $ctx);
        return $this->jsonOk(['data' => $result]);
    }

    /**
     * Competitor feature catalogs for heuristic gap detection.
     * JWT /competitors is not usable with X-Worker-Token — this endpoint is.
     */
    public function listCompetitors(): ResponseInterface
    {
        $db = Database::connect();
        $q  = $db->table('smoke_competitor_profiles');
        if ($p = $this->request->getGet('product_name')) {
            $q->where('LOWER(product_name) =', strtolower((string) $p), false);
        }
        $enabled = $this->request->getGet('enabled');
        if ($enabled !== null && $enabled !== '') {
            $q->where('enabled', in_array((string) $enabled, ['1', 'true', 'yes'], true) ? 'true' : 'false');
        } else {
            $q->where('enabled', 'true');
        }
        $rows = $q->orderBy('product_name', 'ASC')->orderBy('competitor_name', 'ASC')->get()->getResultArray();
        return $this->jsonOk(['data' => $rows]);
    }

    /**
     * CLI convenience: find the latest approved session plan for a product
     * (active target profile) and start an observation run.
     */
    public function enqueue(): ResponseInterface
    {
        $body = $this->jsonBody();
        $product = strtolower(trim((string) ($body['product'] ?? '')));
        $planId  = (int) ($body['plan_id'] ?? 0);
        $db = Database::connect();

        if ($planId <= 0) {
            if ($product === '') {
                return $this->jsonError('invalid_request', 'product or plan_id is required.', 400);
            }
            $row = $db->table('smoke_session_plans sp')
                ->select('sp.id')
                ->join('smoke_master_prompts mp', 'mp.id = sp.master_prompt_id')
                ->join('smoke_target_profiles tp', 'tp.id = mp.target_profile_id')
                ->where('sp.status', 'approved')
                ->where('tp.status', 'active')
                ->where('tp.product_name', $product)
                ->orderBy('sp.approved_at', 'DESC')
                ->orderBy('sp.id', 'DESC')
                ->limit(1)
                ->get()
                ->getRow();
            if (! $row) {
                return $this->jsonError(
                    'not_found',
                    "No approved session plan found for active product=\"{$product}\". Approve a plan in the portal first.",
                    404,
                );
            }
            $planId = (int) $row->id;
        } else {
            $plan = $db->table('smoke_session_plans')->where('id', $planId)->get()->getRow();
            if (! $plan) {
                return $this->jsonError('not_found', 'Session plan not found', 404);
            }
            if ($plan->status !== 'approved') {
                return $this->jsonError('precondition_failed', 'Plan must be approved before starting a run.', 412);
            }
        }

        $run = Services::runner()->startRun($planId, null);
        Services::audit()->record('worker.enqueue', 'smoke_observation_runs', (string) ($run['id'] ?? ''), null, [
            'plan_id' => $planId,
            'product' => $product,
        ]);
        return $this->jsonOk(['data' => $run], 201);
    }
}
