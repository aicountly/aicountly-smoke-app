<?php

namespace App\Controllers;

use CodeIgniter\HTTP\ResponseInterface;
use Config\Database;
use Config\Services;

class DecisionsController extends BaseController
{
    public function index(int $runId): ResponseInterface
    {
        $db = Database::connect();
        if ($db->table('smoke_observation_runs')->where('id', $runId)->countAllResults() === 0) {
            return $this->jsonError('not_found', 'Run not found.', 404);
        }

        $query = $db->table('smoke_run_decisions')
            ->where('run_id', $runId)
            ->orderBy('id', 'DESC');
        $status = trim((string) ($this->request->getGet('status') ?? ''));
        if ($status !== '') {
            if (! in_array($status, ['pending', 'answered', 'timed_out', 'cancelled'], true)) {
                return $this->jsonError('invalid_request', 'Invalid decision status.', 400);
            }
            $query->where('status', $status);
        }

        $rows = array_map(
            fn (array $row): array => $this->formatDecision($row),
            $query->get()->getResultArray(),
        );
        return $this->jsonOk(['data' => $rows]);
    }

    public function screenshot(int $runId, int $decisionId): ResponseInterface
    {
        $db = Database::connect();
        $decision = $db->table('smoke_run_decisions')
            ->where('id', $decisionId)
            ->where('run_id', $runId)
            ->get()
            ->getRowArray();
        if (! $decision) {
            return $this->jsonError('not_found', 'Decision not found on this run.', 404);
        }
        $path = trim((string) ($decision['screenshot_path'] ?? ''));
        if ($path === '') {
            return $this->jsonError('not_found', 'No screenshot was stored for this decision.', 404);
        }
        $run = $db->table('smoke_observation_runs')->where('id', $runId)->get()->getRowArray();
        $resolver = new \App\Services\Reports\ReportArtifactResolver();
        $resolved = $resolver->resolveFile($path, (string) ($run['reports_dir'] ?? ''));
        if ($resolved === null || ! is_file($resolved)) {
            return $this->jsonError('not_found', 'Screenshot file missing', 404);
        }
        if ($resolved !== $path) {
            $db->table('smoke_run_decisions')->where('id', $decisionId)->update([
                'screenshot_path' => mb_substr($resolved, 0, 512),
                'updated_at'      => date('Y-m-d H:i:s'),
            ]);
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

    public function answer(int $runId, int $decisionId): ResponseInterface
    {
        $body = $this->jsonBody();
        $selectedOption = trim((string) ($body['selected_option'] ?? ''));
        if ($selectedOption === '') {
            return $this->jsonError('invalid_request', 'selected_option is required.', 400);
        }
        $remember = array_key_exists('remember', $body) ? (bool) $body['remember'] : true;
        $freeText = trim((string) ($body['free_text'] ?? ''));
        $userId = $this->user()?->id;
        $now = date('Y-m-d H:i:s');
        $db = Database::connect();

        $db->transBegin();
        $decision = $db->query(
            'SELECT * FROM smoke_run_decisions WHERE id = ? AND run_id = ? FOR UPDATE',
            [$decisionId, $runId],
        )->getRowArray();
        if (! $decision) {
            $db->transRollback();
            return $this->jsonError('not_found', 'Decision not found on this run.', 404);
        }
        if ($decision['status'] !== 'pending') {
            $db->transRollback();
            return $this->jsonError('decision_not_pending', 'Decision has already been resolved.', 409);
        }

        $options = $this->decodeJsonList($decision['options_json'] ?? null);
        $chosen = null;
        foreach ($options as $option) {
            if (is_array($option) && (string) ($option['id'] ?? '') === $selectedOption) {
                $chosen = $option;
                break;
            }
        }
        if ($chosen === null) {
            $db->transRollback();
            return $this->jsonError('invalid_option', 'selected_option is not one of this decision’s options.', 400);
        }

        $job = $db->query(
            'SELECT status FROM smoke_session_jobs WHERE id = ? FOR UPDATE',
            [(int) $decision['job_id']],
        )->getRowArray();
        if (! $job || $job['status'] !== 'awaiting_decision') {
            $db->transRollback();
            return $this->jsonError('invalid_job_state', 'Job is no longer awaiting a decision.', 409);
        }

        $context = $this->decodeJsonObject($decision['context_json'] ?? null);
        $context['source'] = 'user';
        $db->table('smoke_run_decisions')->where('id', $decisionId)->update([
            'status'          => 'answered',
            'selected_option' => mb_substr($selectedOption, 0, 191),
            'free_text'       => $freeText !== '' ? $freeText : null,
            'answered_by'     => $userId,
            'answered_at'     => $now,
            'remember'        => $remember,
            'context_json'    => json_encode($context),
            'updated_at'      => $now,
        ]);
        $db->table('smoke_session_jobs')->where('id', (int) $decision['job_id'])->update([
            'status'     => 'leased',
            'updated_at' => $now,
        ]);

        if ($remember) {
            $run = $db->table('smoke_observation_runs')->where('id', $runId)->get()->getRowArray();
            if (! $run) {
                $db->transRollback();
                return $this->jsonError('not_found', 'Run not found.', 404);
            }
            $memoryData = [
                'product_name'    => $run['product_name'],
                'environment'     => $run['environment'],
                'situation_key'   => $decision['situation_key'],
                'selected_option' => mb_substr($selectedOption, 0, 191),
                'payload_json'    => json_encode([
                    'selected_option' => $selectedOption,
                    'free_text'       => $freeText !== '' ? $freeText : null,
                    'option'          => $chosen,
                ]),
                'source_run_id'   => $runId,
                'updated_by'      => $userId,
                'updated_at'      => $now,
            ];
            $db->table('smoke_decision_memory')->upsert($memoryData);
        }

        $db->transCommit();
        if (! $db->transStatus()) {
            return $this->jsonError('decision_answer_failed', 'Could not save the decision answer.', 500);
        }

        $label = trim((string) ($chosen['label'] ?? $selectedOption));
        Services::runLog()->append(
            $runId,
            (int) $decision['session_id'],
            (int) $decision['job_id'],
            'user',
            'info',
            'User decided: ' . $label,
            [
                'decision_id'    => $decisionId,
                'selected_option'=> $selectedOption,
                'action'         => $chosen['action'] ?? null,
                'remember'       => $remember,
            ],
        );
        Services::audit()->record(
            'runs.answer_decision',
            'smoke_run_decisions',
            (string) $decisionId,
            $userId,
            ['run_id' => $runId, 'selected_option' => $selectedOption, 'remember' => $remember],
        );

        $answered = $db->table('smoke_run_decisions')->where('id', $decisionId)->get()->getRowArray();
        return $this->jsonOk(['data' => $this->formatDecision($answered ?? [])]);
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
        $row['source'] = $this->resolveSource((string) ($row['status'] ?? ''), $row['context'], $row);
        $row['has_screenshot'] = trim((string) ($row['screenshot_path'] ?? '')) !== '';
        unset($row['options_json'], $row['context_json']);
        return $row;
    }

    /** @param array<string,mixed> $context @param array<string,mixed> $row */
    private function resolveSource(string $status, array $context, array $row): string
    {
        if ($status === 'timed_out') {
            return 'timeout';
        }
        if ($status === 'cancelled') {
            return 'cancelled';
        }
        if ($status === 'pending') {
            return 'pending';
        }
        $explicit = strtolower(trim((string) ($context['source'] ?? '')));
        if (in_array($explicit, ['memory', 'user', 'timeout'], true)) {
            return $explicit;
        }
        if (($row['answered_by'] ?? null) === null && trim((string) ($row['selected_option'] ?? '')) !== '') {
            return 'memory';
        }
        return 'user';
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
