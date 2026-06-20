<?php

namespace App\Controllers;

use CodeIgniter\HTTP\ResponseInterface;
use Config\Database;
use Config\Services;

/**
 * Worker-side endpoints. Authenticated via WorkerTokenFilter (X-Worker-Token).
 * Never use JWT here. Also never include AI provider keys -- the worker calls
 * /worker/brain to delegate council inference back through PHP.
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
        Database::connect()->table('smoke_observation_results')->insert([
            'run_id'              => (int) $body['run_id'],
            'session_id'          => (int) $body['session_id'],
            'screen_url'          => (string) ($body['screen_url']     ?? ''),
            'screen_title'        => (string) ($body['screen_title']   ?? ''),
            'module_name'         => (string) ($body['module_name']    ?? ''),
            'screenshot_path'     => (string) ($body['screenshot_path']?? ''),
            'page_metadata_json'  => json_encode($body['page_metadata']  ?? []),
            'console_errors_json' => json_encode($body['console_errors']?? []),
            'network_errors_json' => json_encode($body['network_errors']?? []),
            'performance_json'    => json_encode($body['performance']   ?? []),
        ]);
        return $this->jsonOk(['id' => (int) Database::connect()->insertID()]);
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
        Database::connect()->table('smoke_reports')->insert([
            'run_id'                => (int) ($body['run_id']     ?? 0),
            'session_id'            => (int) ($body['session_id'] ?? 0) ?: null,
            'kind'                  => (string) ($body['kind']  ?? 'session'),
            'title'                 => (string) ($body['title'] ?? 'Session report'),
            'severity_summary_json' => json_encode($body['severity_summary'] ?? []),
            'metrics_json'          => json_encode($body['metrics'] ?? []),
            'maturity_score'        => isset($body['maturity_score']) ? (float) $body['maturity_score'] : null,
            'ux_score'              => isset($body['ux_score']) ? (float) $body['ux_score'] : null,
            'html_path'             => (string) ($body['html_path'] ?? ''),
            'json_path'             => (string) ($body['json_path'] ?? ''),
            'auditor_visible'       => (bool) ($body['auditor_visible'] ?? false),
        ]);
        return $this->jsonOk(['id' => (int) Database::connect()->insertID()]);
    }

    public function finalizeRun(int $runId): ResponseInterface
    {
        Services::runner()->finalizeRunIfDone($runId);
        return $this->jsonOk(['ok' => true]);
    }
}
