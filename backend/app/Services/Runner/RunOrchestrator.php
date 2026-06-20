<?php

namespace App\Services\Runner;

use Config\Database;
use Config\Services;
use RuntimeException;

/**
 * Orchestrates an observation run:
 *   1. Allocate a unique run_code (SMOKE-RUN-YYYYMMDD-NNNN, atomic)
 *   2. Insert smoke_observation_runs
 *   3. Enqueue all sessions of the plan into smoke_session_jobs (sequential, ordinal-ordered)
 *
 * Worker leases jobs with FOR UPDATE SKIP LOCKED via the WorkerController.
 */
class RunOrchestrator
{
    public function startRun(int $planId, ?int $triggeredBy): array
    {
        $db = Database::connect();
        $plan = $db->table('smoke_session_plans')->where('id', $planId)->get()->getRow();
        if (! $plan || $plan->status !== 'approved') {
            throw new RuntimeException('Plan is not approved.');
        }
        $masterPrompt = $db->table('smoke_master_prompts')->where('id', $plan->master_prompt_id)->get()->getRow();
        if (! $masterPrompt) {
            throw new RuntimeException('Master prompt missing for this plan.');
        }
        $profile = $db->table('smoke_target_profiles')->where('id', $masterPrompt->target_profile_id)->get()->getRow();
        if (! $profile) {
            throw new RuntimeException('Target profile missing.');
        }

        $sessions = $db->table('smoke_sessions')
            ->where('plan_id', $planId)
            ->orderBy('ordinal', 'ASC')
            ->get()
            ->getResult();
        if (! $sessions) {
            throw new RuntimeException('Plan has no sessions to run.');
        }

        $runCode = $this->allocateRunCode();
        $reportsDir = $this->reportsDir($profile->product_name, $runCode);

        $db->table('smoke_observation_runs')->insert([
            'run_code'          => $runCode,
            'plan_id'           => $planId,
            'target_profile_id' => $profile->id,
            'product_name'      => $profile->product_name,
            'environment'       => $masterPrompt->environment,
            'status'            => 'queued',
            'sessions_total'    => count($sessions),
            'sessions_done'     => 0,
            'sessions_failed'   => 0,
            'triggered_by'      => $triggeredBy,
            'reports_dir'       => $reportsDir,
        ]);
        $runId = (int) $db->insertID();

        foreach ($sessions as $s) {
            $db->table('smoke_session_jobs')->insert([
                'run_id'       => $runId,
                'session_id'   => $s->id,
                'ordinal'      => (int) $s->ordinal,
                'status'       => 'queued',
                'attempts'     => 0,
                'max_attempts' => (int) env('WORKER_MAX_RETRIES', 2) + 1,
            ]);
        }

        Services::audit()->record('runs.start', 'smoke_observation_runs', (string) $runId, $triggeredBy, [
            'run_code'   => $runCode,
            'plan_id'    => $planId,
            'sessions'   => count($sessions),
            'environment'=> $masterPrompt->environment,
        ]);

        return [
            'id'             => $runId,
            'run_code'       => $runCode,
            'plan_id'        => $planId,
            'sessions_total' => count($sessions),
            'reports_dir'    => $reportsDir,
            'status'         => 'queued',
        ];
    }

    public function leaseNextJob(string $workerId, int $leaseSeconds = 600): ?array
    {
        $db = Database::connect();
        $db->transStart();

        $row = $db->query(
            'SELECT * FROM smoke_session_jobs '
            . "WHERE status = 'queued' "
            . 'ORDER BY run_id ASC, ordinal ASC '
            . 'LIMIT 1 FOR UPDATE SKIP LOCKED'
        )->getRow();

        if (! $row) {
            $db->transComplete();
            return null;
        }

        $now    = date('Y-m-d H:i:s');
        $expiry = date('Y-m-d H:i:s', time() + $leaseSeconds);

        $db->table('smoke_session_jobs')->where('id', $row->id)->update([
            'status'           => 'leased',
            'leased_by'        => $workerId,
            'leased_at'        => $now,
            'lease_expires_at' => $expiry,
            'attempts'         => (int) $row->attempts + 1,
            'updated_at'       => $now,
        ]);

        $db->table('smoke_observation_runs')->where('id', $row->run_id)->update([
            'status'     => 'running',
            'started_at' => 'COALESCE(started_at, NOW())',
            'updated_at' => $now,
        ]);

        $db->transComplete();

        $session = $db->table('smoke_sessions')->where('id', $row->session_id)->get()->getRowArray();
        $run     = $db->table('smoke_observation_runs')->where('id', $row->run_id)->get()->getRowArray();
        $profile = $run ? $db->table('smoke_target_profiles')->where('id', $run['target_profile_id'])->get()->getRowArray() : null;

        return [
            'job_id'    => (int) $row->id,
            'run_id'    => (int) $row->run_id,
            'run_code'  => $run['run_code']    ?? null,
            'session'   => $session,
            'run'       => $run,
            'profile'   => $profile,
            'expires_at'=> $expiry,
        ];
    }

    public function markComplete(int $jobId, array $payload = []): void
    {
        $db = Database::connect();
        $job = $db->table('smoke_session_jobs')->where('id', $jobId)->get()->getRow();
        if (! $job) {
            return;
        }
        $now = date('Y-m-d H:i:s');
        $db->table('smoke_session_jobs')->where('id', $jobId)->update([
            'status'     => 'done',
            'updated_at' => $now,
        ]);
        $db->table('smoke_sessions')->where('id', $job->session_id)->update([
            'status'       => 'done',
            'completed_at' => $now,
            'updated_at'   => $now,
        ]);
        $db->query('UPDATE smoke_observation_runs SET sessions_done = sessions_done + 1, updated_at = NOW() WHERE id = ?', [$job->run_id]);
        $this->finalizeRunIfDone((int) $job->run_id);
    }

    public function markFailed(int $jobId, string $error): void
    {
        $db = Database::connect();
        $job = $db->table('smoke_session_jobs')->where('id', $jobId)->get()->getRow();
        if (! $job) {
            return;
        }
        $now = date('Y-m-d H:i:s');
        $shouldRetry = (int) $job->attempts < (int) $job->max_attempts;
        if ($shouldRetry) {
            $db->table('smoke_session_jobs')->where('id', $jobId)->update([
                'status'     => 'queued',
                'leased_by'  => null,
                'leased_at'  => null,
                'lease_expires_at' => null,
                'last_error' => mb_substr($error, 0, 4000),
                'updated_at' => $now,
            ]);
        } else {
            $db->table('smoke_session_jobs')->where('id', $jobId)->update([
                'status'     => 'failed',
                'last_error' => mb_substr($error, 0, 4000),
                'updated_at' => $now,
            ]);
            $db->table('smoke_sessions')->where('id', $job->session_id)->update([
                'status'       => 'failed',
                'completed_at' => $now,
                'error_message'=> mb_substr($error, 0, 4000),
                'updated_at'   => $now,
            ]);
            $db->query('UPDATE smoke_observation_runs SET sessions_failed = sessions_failed + 1, updated_at = NOW() WHERE id = ?', [$job->run_id]);
            $this->finalizeRunIfDone((int) $job->run_id);
        }
    }

    public function finalizeRunIfDone(int $runId): void
    {
        $db = Database::connect();
        $run = $db->table('smoke_observation_runs')->where('id', $runId)->get()->getRow();
        if (! $run) return;
        $remaining = $db->table('smoke_session_jobs')
            ->where('run_id', $runId)
            ->whereIn('status', ['queued', 'leased'])
            ->countAllResults();
        if ($remaining > 0) {
            return;
        }
        $finalStatus = ((int) $run->sessions_failed > 0 && (int) $run->sessions_done === 0) ? 'failed' : 'completed';
        $db->table('smoke_observation_runs')->where('id', $runId)->update([
            'status'       => $finalStatus,
            'completed_at' => date('Y-m-d H:i:s'),
            'updated_at'   => date('Y-m-d H:i:s'),
        ]);
        try {
            Services::finalReport()->build($runId);
        } catch (\Throwable $e) {
            log_message('error', 'FinalReportBuilder failed for run ' . $runId . ': ' . $e->getMessage());
        }
    }

    private function allocateRunCode(): string
    {
        $db = Database::connect();
        $today = date('Ymd');

        $db->transStart();
        $row = $db->table('smoke_settings')->where('key', 'run_counter.last_date')->get()->getRow();
        $seqRow = $db->table('smoke_settings')->where('key', 'run_counter.last_seq')->get()->getRow();
        if (! $row || ! $seqRow) {
            $db->transComplete();
            throw new RuntimeException('run_counter settings not seeded -- run InitialSeeder first.');
        }
        $lastDate = trim((string) json_decode((string) $row->value_json, true), '"');
        $lastSeq  = (int) (json_decode((string) $seqRow->value_json, true) ?? 0);

        $newSeq = $lastDate === $today ? $lastSeq + 1 : 1;

        $db->table('smoke_settings')->where('key', 'run_counter.last_date')->update([
            'value_json' => json_encode($today),
            'updated_at' => date('Y-m-d H:i:s'),
        ]);
        $db->table('smoke_settings')->where('key', 'run_counter.last_seq')->update([
            'value_json' => json_encode($newSeq),
            'updated_at' => date('Y-m-d H:i:s'),
        ]);
        $db->transComplete();

        return sprintf('SMOKE-RUN-%s-%04d', $today, $newSeq);
    }

    private function reportsDir(string $product, string $runCode): string
    {
        $base = (string) env('REPORTS_DIR', '../smoke-reports');
        $date = date('Y-m-d');
        return rtrim($base, '/\\') . '/' . $product . '/' . $date . '/' . $runCode;
    }
}
