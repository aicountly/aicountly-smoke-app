<?php

namespace App\Controllers;

use App\Services\Brain\BrainUnavailableException;
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
    /**
     * Requested product name -> canonical samples/competitors catalog key.
     * Stored rows always carry the canonical name, so seeding and listing must
     * both resolve through this map before touching the table.
     */
    private const COMPETITOR_PRODUCT_ALIASES = [
        'smart books' => 'books',
        'erp'         => 'books',
        'accounting'  => 'books',
    ];

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

    public function createDecision(): ResponseInterface
    {
        $body = $this->jsonBody();
        $runId = (int) ($body['run_id'] ?? 0);
        $sessionId = (int) ($body['session_id'] ?? 0);
        $jobId = (int) ($body['job_id'] ?? 0);
        $situationKey = trim((string) ($body['situation_key'] ?? ''));
        $question = trim((string) ($body['question'] ?? ''));
        $options = $body['options'] ?? null;
        $source = strtolower(trim((string) ($body['source'] ?? 'user')));
        $selectedOption = trim((string) ($body['selected_option'] ?? ''));
        // A remembered choice and an autonomous one both arrive already decided:
        // they are recorded for audit, never parked for an operator.
        $preAnswered = in_array($source, ['memory', 'auto'], true);

        if ($runId <= 0 || $sessionId <= 0 || $jobId <= 0 || $situationKey === '' || $question === '') {
            return $this->jsonError(
                'invalid_request',
                'run_id, session_id, job_id, situation_key, and question are required.',
                400,
            );
        }
        if (! is_array($options) || $options === []) {
            return $this->jsonError('invalid_request', 'options must be a non-empty array.', 400);
        }
        foreach ($options as $option) {
            if (! is_array($option)
                || trim((string) ($option['id'] ?? '')) === ''
                || trim((string) ($option['label'] ?? '')) === ''
                || trim((string) ($option['action'] ?? '')) === '') {
                return $this->jsonError('invalid_request', 'Each option requires id, label, and action.', 400);
            }
        }
        if ($preAnswered && $selectedOption === '') {
            return $this->jsonError(
                'invalid_request',
                'selected_option is required when source=memory or source=auto.',
                400,
            );
        }
        if ($preAnswered) {
            $validOption = false;
            foreach ($options as $option) {
                if (is_array($option) && (string) ($option['id'] ?? '') === $selectedOption) {
                    $validOption = true;
                    break;
                }
            }
            if (! $validOption) {
                return $this->jsonError('invalid_option', 'selected_option is not one of this decision’s options.', 400);
            }
        }

        $db = Database::connect();
        $job = $db->table('smoke_session_jobs')
            ->where('id', $jobId)
            ->where('run_id', $runId)
            ->where('session_id', $sessionId)
            ->get()
            ->getRow();
        if (! $job) {
            return $this->jsonError('not_found', 'Job was not found for this run and session.', 404);
        }
        if (! in_array((string) $job->status, ['leased', 'awaiting_decision'], true)) {
            return $this->jsonError('invalid_job_state', 'Job is not actively leased.', 409);
        }

        if (! $preAnswered) {
            $existing = $db->table('smoke_run_decisions')
                ->where('job_id', $jobId)
                ->where('situation_key', $situationKey)
                ->where('status', 'pending')
                ->orderBy('id', 'DESC')
                ->get()
                ->getRowArray();
            if ($existing) {
                $db->transBegin();
                $lockedJob = $db->query(
                    'SELECT status FROM smoke_session_jobs WHERE id = ? FOR UPDATE',
                    [$jobId],
                )->getRow();
                if (! $lockedJob || ! in_array((string) $lockedJob->status, ['leased', 'awaiting_decision'], true)) {
                    $db->transRollback();
                    return $this->jsonError('invalid_job_state', 'Job is no longer actively leased.', 409);
                }
                $db->table('smoke_session_jobs')->where('id', $jobId)->update([
                    'status'     => 'awaiting_decision',
                    'updated_at' => date('Y-m-d H:i:s'),
                ]);
                $db->transCommit();
                return $this->jsonOk(['data' => $this->formatDecision($existing)]);
            }
        }

        $now = date('Y-m-d H:i:s');
        $context = is_array($body['context'] ?? null) ? $body['context'] : [];
        $context['source'] = $preAnswered ? $source : ($context['source'] ?? 'user');
        $freeText = trim((string) ($body['free_text'] ?? ''));
        $db->transBegin();
        $lockedJob = $db->query(
            'SELECT status FROM smoke_session_jobs WHERE id = ? FOR UPDATE',
            [$jobId],
        )->getRow();
        if (! $lockedJob || ! in_array((string) $lockedJob->status, ['leased', 'awaiting_decision'], true)) {
            $db->transRollback();
            return $this->jsonError('invalid_job_state', 'Job is no longer actively leased.', 409);
        }
        if (! $preAnswered) {
            $existing = $db->table('smoke_run_decisions')
                ->where('job_id', $jobId)
                ->where('situation_key', $situationKey)
                ->where('status', 'pending')
                ->orderBy('id', 'DESC')
                ->get()
                ->getRowArray();
            if ($existing) {
                $db->table('smoke_session_jobs')->where('id', $jobId)->update([
                    'status'     => 'awaiting_decision',
                    'updated_at' => $now,
                ]);
                $db->transCommit();
                return $this->jsonOk(['data' => $this->formatDecision($existing)]);
            }
        }
        $insert = [
            'run_id'          => $runId,
            'session_id'      => $sessionId,
            'job_id'          => $jobId,
            'situation_key'   => mb_substr($situationKey, 0, 191),
            'question'        => $question,
            'options_json'    => json_encode(array_values($options)),
            'context_json'    => json_encode($context),
            'screenshot_path' => ($body['screenshot_path'] ?? '') !== ''
                ? mb_substr((string) $body['screenshot_path'], 0, 512)
                : null,
            'status'          => $preAnswered ? 'answered' : 'pending',
            'remember'        => true,
            'created_at'      => $now,
            'updated_at'      => $now,
        ];
        if ($preAnswered) {
            $insert['selected_option'] = mb_substr($selectedOption, 0, 191);
            $insert['free_text'] = $freeText !== '' ? $freeText : null;
            $insert['answered_at'] = $now;
            $insert['answered_by'] = null;
        }
        $db->table('smoke_run_decisions')->insert($insert);
        $decisionId = (int) $db->insertID();
        if (! $preAnswered) {
            $db->table('smoke_session_jobs')->where('id', $jobId)->update([
                'status'     => 'awaiting_decision',
                'updated_at' => $now,
            ]);
        }
        $db->transCommit();

        if (! $db->transStatus()) {
            return $this->jsonError('decision_create_failed', 'Could not create the decision.', 500);
        }

        $chosenLabel = $selectedOption;
        foreach ($options as $option) {
            if (is_array($option) && (string) ($option['id'] ?? '') === $selectedOption) {
                $chosenLabel = trim((string) ($option['label'] ?? $selectedOption)) ?: $selectedOption;
                break;
            }
        }
        Services::runLog()->append(
            $runId,
            $sessionId,
            $jobId,
            'worker',
            'info',
            match (true) {
                $source === 'memory' => 'Reused remembered choice: ' . $chosenLabel,
                $source === 'auto'   => 'Decided without asking (autonomous): ' . $chosenLabel,
                default              => 'Worker needs a decision: ' . $question,
            },
            [
                'decision_id'     => $decisionId,
                'situation_key'   => $situationKey,
                'source'          => $preAnswered ? $source : 'user',
                'selected_option' => $preAnswered ? $selectedOption : null,
            ],
        );

        $decision = $db->table('smoke_run_decisions')->where('id', $decisionId)->get()->getRowArray();
        return $this->jsonOk(['data' => $this->formatDecision($decision ?? [])], 201);
    }

    public function listDecisions(): ResponseInterface
    {
        $runId = (int) ($this->request->getGet('run_id') ?? 0);
        $sessionId = (int) ($this->request->getGet('session_id') ?? 0);
        if ($runId <= 0) {
            return $this->jsonError('invalid_request', 'run_id query parameter is required.', 400);
        }
        $query = Database::connect()->table('smoke_run_decisions')
            ->where('run_id', $runId)
            ->orderBy('id', 'ASC');
        if ($sessionId > 0) {
            $query->where('session_id', $sessionId);
        }
        $rows = array_map(
            fn (array $row): array => $this->formatDecision($row),
            $query->get()->getResultArray(),
        );
        return $this->jsonOk(['data' => $rows]);
    }

    public function pollDecision(int $decisionId): ResponseInterface
    {
        $row = Database::connect()->table('smoke_run_decisions')
            ->where('id', $decisionId)
            ->get()
            ->getRowArray();
        if (! $row) {
            return $this->jsonError('not_found', 'Decision not found.', 404);
        }
        return $this->jsonOk(['data' => $this->formatDecision($row)]);
    }

    public function timeoutDecision(int $decisionId): ResponseInterface
    {
        $now = date('Y-m-d H:i:s');
        $db = Database::connect();
        $db->transBegin();
        $decision = $db->query(
            'SELECT * FROM smoke_run_decisions WHERE id = ? FOR UPDATE',
            [$decisionId],
        )->getRowArray();
        if (! $decision) {
            $db->transRollback();
            return $this->jsonError('not_found', 'Decision not found.', 404);
        }
        if ($decision['status'] !== 'pending') {
            $db->transCommit();
            return $this->jsonOk(['data' => $this->formatDecision($decision)]);
        }

        $db->table('smoke_run_decisions')->where('id', $decisionId)->update([
            'status'     => 'timed_out',
            'updated_at' => $now,
        ]);
        $job = $db->query(
            'SELECT id, status FROM smoke_session_jobs WHERE id = ? FOR UPDATE',
            [(int) $decision['job_id']],
        )->getRow();
        if ($job && (string) $job->status === 'awaiting_decision') {
            // Leave job awaiting_decision so markFailed / lease reclaim owns the failure path.
            $db->table('smoke_session_jobs')->where('id', (int) $job->id)->update([
                'updated_at' => $now,
            ]);
        }
        $db->transCommit();

        Services::runLog()->append(
            (int) $decision['run_id'],
            (int) $decision['session_id'],
            (int) $decision['job_id'],
            'worker',
            'warn',
            'Decision timed out waiting for an operator answer',
            ['decision_id' => $decisionId, 'situation_key' => $decision['situation_key']],
        );

        $row = $db->table('smoke_run_decisions')->where('id', $decisionId)->get()->getRowArray();
        return $this->jsonOk(['data' => $this->formatDecision($row ?? [])]);
    }

    public function decisionMemory(): ResponseInterface
    {
        $product = trim((string) ($this->request->getGet('product_name') ?? ''));
        $environment = trim((string) ($this->request->getGet('environment') ?? ''));
        $situationKey = trim((string) ($this->request->getGet('situation_key') ?? ''));
        if ($product === '' || $environment === '' || $situationKey === '') {
            return $this->jsonError(
                'invalid_request',
                'product_name, environment, and situation_key query parameters are required.',
                400,
            );
        }

        $row = Database::connect()->table('smoke_decision_memory')
            ->where('product_name', $product)
            ->where('environment', $environment)
            ->where('situation_key', $situationKey)
            ->get()
            ->getRowArray();
        if (! $row) {
            return $this->jsonOk(['data' => null]);
        }
        $row['payload'] = $this->decodeJsonObject($row['payload_json'] ?? null);
        unset($row['payload_json']);
        return $this->jsonOk(['data' => $row]);
    }

    public function forgetDecisionMemory(): ResponseInterface
    {
        $product = trim((string) ($this->request->getGet('product_name') ?? ''));
        $environment = trim((string) ($this->request->getGet('environment') ?? ''));
        $situationKey = trim((string) ($this->request->getGet('situation_key') ?? ''));
        if ($product === '' || $environment === '' || $situationKey === '') {
            return $this->jsonError(
                'invalid_request',
                'product_name, environment, and situation_key query parameters are required.',
                400,
            );
        }

        $db = Database::connect();
        $db->table('smoke_decision_memory')
            ->where('product_name', $product)
            ->where('environment', $environment)
            ->where('situation_key', $situationKey)
            ->delete();

        return $this->jsonOk([
            'data' => [
                'forgotten'     => true,
                'product_name'  => $product,
                'environment'   => $environment,
                'situation_key' => $situationKey,
            ],
        ]);
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

    public function recordFileIoTest(): ResponseInterface
    {
        $body = $this->jsonBody();
        foreach (['run_id', 'session_id', 'product_name', 'scenario_key', 'direction', 'compare_status'] as $field) {
            if (empty($body[$field])) {
                return $this->jsonError('invalid_request', "{$field} is required", 400);
            }
        }
        if (! in_array($body['direction'], ['upload', 'download', 'round_trip'], true)
            || ! in_array($body['compare_status'], ['pass', 'fail', 'partial', 'not_applicable', 'skipped', 'blocked'], true)) {
            return $this->jsonError('invalid_request', 'Invalid direction or compare_status.', 400);
        }
        $db = Database::connect();
        $row = [
            'run_id'               => (int) $body['run_id'],
            'session_id'           => (int) $body['session_id'],
            'result_id'            => (int) ($body['result_id'] ?? 0) ?: null,
            'product_name'         => (string) $body['product_name'],
            'scenario_key'         => (string) $body['scenario_key'],
            'direction'            => (string) $body['direction'],
            'fixture_name'         => (string) ($body['fixture_name'] ?? ''),
            'upload_ok'            => (bool) ($body['upload_ok'] ?? false),
            'download_ok'          => (bool) ($body['download_ok'] ?? false),
            'source_sha256'        => $body['source_sha256'] ?? null,
            'result_sha256'        => $body['result_sha256'] ?? null,
            'source_mime'          => $body['source_mime'] ?? null,
            'result_mime'          => $body['result_mime'] ?? null,
            'source_bytes'         => isset($body['source_bytes']) ? (int) $body['source_bytes'] : null,
            'result_bytes'         => isset($body['result_bytes']) ? (int) $body['result_bytes'] : null,
            'structure_ok'         => (bool) ($body['structure_ok'] ?? false),
            'structure_notes'      => (string) ($body['structure_notes'] ?? ''),
            'compare_status'       => (string) $body['compare_status'],
            'ai_scores_json'       => json_encode($body['ai_scores'] ?? []),
            'ai_verdict'           => (string) ($body['ai_verdict'] ?? ''),
            'ai_recommendations'   => json_encode($body['ai_recommendations'] ?? []),
            'competitor_refs_json' => json_encode($body['competitor_refs'] ?? []),
            'artifact_paths_json'  => json_encode($body['artifact_paths'] ?? []),
            'evidence_json'        => json_encode($body['evidence'] ?? []),
        ];
        $existing = $db->table('smoke_file_io_tests')
            ->select('id')
            ->where('run_id', $row['run_id'])
            ->where('session_id', $row['session_id'])
            ->where('scenario_key', $row['scenario_key'])
            ->get()
            ->getRow();
        if ($existing) {
            $db->table('smoke_file_io_tests')->where('id', (int) $existing->id)->update($row);
            return $this->jsonOk(['id' => (int) $existing->id, 'deduplicated' => true]);
        }
        $db->table('smoke_file_io_tests')->insert($row);
        return $this->jsonOk(['id' => (int) $db->insertID(), 'deduplicated' => false], 201);
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
            'human_summary'   => (string) ($body['human_summary'] ?? ''),
            'developer_prompt'=> (string) ($body['developer_prompt']?? ''),
            'evidence_json'   => json_encode($body['evidence'] ?? []),
        ]);
        return $this->jsonOk(['ok' => true]);
    }

    public function recordFeatureGap(): ResponseInterface
    {
        $body = $this->jsonBody();
        $confidence = in_array(($body['confidence'] ?? ''), ['high', 'medium', 'low'], true)
            ? (string) $body['confidence']
            : 'low';
        $mode = in_array(($body['mode'] ?? ''), ['implement', 'validate_first'], true)
            ? (string) $body['mode']
            : 'validate_first';
        Database::connect()->table('smoke_feature_gaps')->insert([
            'run_id'          => (int) ($body['run_id'] ?? 0),
            'session_id'      => (int) ($body['session_id'] ?? 0) ?: null,
            'product_name'    => (string) ($body['product_name']     ?? ''),
            'expected_feature'=> (string) ($body['expected_feature'] ?? ''),
            'observed'        => (bool) ($body['observed'] ?? false),
            'partial'         => (bool) ($body['partial']  ?? false),
            'competitor_ref'  => (string) ($body['competitor_ref'] ?? ''),
            'severity'        => (string) ($body['severity']       ?? 'medium'),
            'confidence'      => $confidence,
            'mode'            => $mode,
            'recommendation'  => (string) ($body['recommendation'] ?? ''),
            'human_summary'   => (string) ($body['human_summary'] ?? ''),
            'developer_prompt'=> (string) ($body['developer_prompt']?? ''),
            'notes'           => (string) ($body['notes'] ?? ''),
            'sources_json'    => json_encode($body['sources'] ?? []),
            'evidence_json'   => json_encode($body['evidence'] ?? []),
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

    public function abortRun(int $runId): ResponseInterface
    {
        $body = $this->jsonBody();
        $reason = trim((string) ($body['reason'] ?? 'worker_abort')) ?: 'worker_abort';
        $detail = trim((string) ($body['detail'] ?? ''));
        $db = Database::connect();
        $run = $db->table('smoke_observation_runs')->where('id', $runId)->get()->getRow();
        if (! $run) {
            return $this->jsonError('not_found', 'Run not found.', 404);
        }

        $now = date('Y-m-d H:i:s');
        $db->transStart();
        $db->table('smoke_session_jobs')->where('run_id', $runId)
            ->whereIn('status', ['queued', 'leased', 'awaiting_decision'])
            ->update(['status' => 'cancelled', 'updated_at' => $now]);
        $db->table('smoke_run_decisions')->where('run_id', $runId)->where('status', 'pending')
            ->update(['status' => 'cancelled', 'updated_at' => $now]);
        $db->table('smoke_observation_runs')->where('id', $runId)->update([
            'status' => 'cancelled',
            'completed_at' => $now,
            'updated_at' => $now,
        ]);
        $db->transComplete();

        Services::runLog()->append(
            $runId,
            null,
            null,
            'worker',
            'error',
            'Run aborted by worker: ' . $reason . ($detail !== '' ? ' — ' . mb_substr($detail, 0, 1000) : ''),
            ['reason' => $reason, 'detail' => mb_substr($detail, 0, 4000)],
        );
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
        $images = is_array($body['images'] ?? null) ? array_values($body['images']) : [];

        if ($sys === '' || $usr === '') {
            return $this->jsonError('invalid_request', 'system_prompt and user_prompt are required.', 400);
        }

        try {
            $result = $images !== []
                ? Services::brain()->invokeVision($task, $sys, $usr, $images, $ctx)
                : Services::brain()->invoke($task, $sys, $usr, $ctx);
            return $this->jsonOk(['data' => $result]);
        } catch (BrainUnavailableException $error) {
            return $this->response->setStatusCode(503)->setJSON([
                'error' => 'brain_unavailable',
                'provider' => $error->provider,
                'detail' => $error->responseSnippet ?: $error->getMessage(),
            ]);
        }
    }

    public function brainHealth(): ResponseInterface
    {
        $providers = Services::brain()->providerHealth();
        $available = array_values(array_filter(
            $providers,
            static fn (array $provider): bool => $provider['configured']
                && $provider['vision_capable']
                && $provider['enabled_for_vision'],
        ));
        return $this->jsonOk([
            'data' => [
                'providers' => $providers,
                'vision_available' => $available !== [],
                'vision_providers' => array_column($available, 'name'),
            ],
        ]);
    }

    /**
     * Competitor feature catalogs for heuristic gap detection.
     * JWT /competitors is not usable with X-Worker-Token — this endpoint is.
     *
     * PostgreSQL BOOLEAN has no implicit cast from integer: compare with PHP
     * booleans so the driver emits TRUE/FALSE, never 1/0.
     *
     * Escaping must stay enabled on the LOWER(product_name) comparison: the
     * builder already leaves parenthesised expressions verbatim, whereas
     * $escape = false would also inline the bound value unquoted.
     *
     * The alias is resolved once and the canonical name drives the seed check,
     * the seed insert and the list filter. Rows are echoed back under the name
     * the caller asked for: the worker filters benchmarks by the product it
     * requested (worker/src/reviewer/featureGapEngine.ts) and would discard
     * every row tagged with the canonical name instead.
     */
    public function listCompetitors(): ResponseInterface
    {
        $db = Database::connect();
        $product = strtolower(trim((string) ($this->request->getGet('product_name') ?? '')));
        $canonical = self::COMPETITOR_PRODUCT_ALIASES[$product] ?? $product;

        // Auto-seed from samples/competitors when the table has nothing for this product.
        if ($canonical !== '') {
            $count = $db->table('smoke_competitor_profiles')
                ->where('LOWER(product_name) =', $canonical)
                ->countAllResults();
            if ($count === 0) {
                $this->seedCompetitorsFromSamples($canonical);
            }
        }

        $q = $db->table('smoke_competitor_profiles');
        if ($canonical !== '') {
            $q->where('LOWER(product_name) =', $canonical);
        }
        $enabled = $this->request->getGet('enabled');
        if ($enabled !== null && $enabled !== '') {
            $want = in_array((string) $enabled, ['1', 'true', 'yes'], true);
            $q->where('enabled', $want);
        } else {
            $q->where('enabled', true);
        }
        $rows = $q->orderBy('product_name', 'ASC')->orderBy('competitor_name', 'ASC')->get()->getResultArray();
        if ($canonical !== $product) {
            foreach ($rows as &$row) {
                $row['product_name'] = $product;
            }
            unset($row);
        }
        return $this->jsonOk(['data' => $rows]);
    }

    /**
     * Insert competitor rows from samples/competitors/{product}.json when missing.
     * Expects an already canonicalised product name.
     *
     * The insert is guarded by ON CONFLICT DO NOTHING rather than a preceding
     * existence check: two workers can hit a cold table at the same time, and
     * the (product_name, competitor_name) unique key must absorb the race
     * without either request erroring. Existing rows are left untouched, which
     * preserves edits made through the portal.
     */
    private function seedCompetitorsFromSamples(string $product): void
    {
        $rootSamples = realpath(WRITEPATH . '../../samples/competitors');
        if ($rootSamples === false) {
            return;
        }
        $file = $rootSamples . DIRECTORY_SEPARATOR . $product . '.json';
        if (! is_file($file)) {
            return;
        }
        $data = json_decode((string) file_get_contents($file), true);
        if (! is_array($data) || empty($data['competitors']) || ! is_array($data['competitors'])) {
            return;
        }
        $db = Database::connect();
        foreach ($data['competitors'] as $row) {
            $name = (string) ($row['name'] ?? '');
            if ($name === '') {
                continue;
            }
            $db->table('smoke_competitor_profiles')->ignore(true)->insert([
                'product_name'      => $product,
                'competitor_name'   => $name,
                'feature_list_json' => json_encode(array_values(array_unique((array) ($row['features'] ?? [])))),
                'source_url'        => (string) ($row['source_url'] ?? ''),
                'enabled'           => true,
                'notes'             => (string) ($row['notes'] ?? ''),
            ]);
        }
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

    /** @param array<string,mixed> $row */
    private function formatDecision(array $row): array
    {
        if ($row === []) {
            return [];
        }
        $row['id'] = (int) $row['id'];
        $row['run_id'] = (int) $row['run_id'];
        $row['session_id'] = (int) $row['session_id'];
        $row['job_id'] = (int) $row['job_id'];
        $row['answered_by'] = isset($row['answered_by']) && $row['answered_by'] !== null && $row['answered_by'] !== ''
            ? (int) $row['answered_by']
            : null;
        $row['remember'] = (bool) ($row['remember'] ?? false);
        $row['options'] = $this->decodeJsonList($row['options_json'] ?? null);
        $row['context'] = $this->decodeJsonObject($row['context_json'] ?? null);
        $status = (string) ($row['status'] ?? '');
        $explicit = strtolower(trim((string) ($row['context']['source'] ?? '')));
        $row['source'] = match (true) {
            $status === 'timed_out' => 'timeout',
            $status === 'cancelled' => 'cancelled',
            $status === 'pending' => 'pending',
            in_array($explicit, ['memory', 'auto', 'user', 'timeout'], true) => $explicit,
            ($row['answered_by'] ?? null) === null && trim((string) ($row['selected_option'] ?? '')) !== '' => 'memory',
            default => 'user',
        };
        unset($row['options_json'], $row['context_json']);
        return $row;
    }

    /** @return list<mixed> */
    private function decodeJsonList(mixed $value): array
    {
        $decoded = is_array($value) ? $value : json_decode((string) $value, true);
        return is_array($decoded) ? array_values($decoded) : [];
    }

    /** @return array<string,mixed> */
    private function decodeJsonObject(mixed $value): array
    {
        $decoded = is_array($value) ? $value : json_decode((string) $value, true);
        return is_array($decoded) ? $decoded : [];
    }
}
