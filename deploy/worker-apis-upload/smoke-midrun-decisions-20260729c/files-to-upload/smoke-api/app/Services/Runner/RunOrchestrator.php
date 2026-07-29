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

        Services::runLog()->append(
            $runId,
            null,
            null,
            'system',
            'info',
            sprintf('Run %s queued with %d session(s). Waiting for worker to lease jobs.', $runCode, count($sessions)),
            ['product' => $profile->product_name, 'environment' => $masterPrompt->environment],
        );

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
        $this->requeueExpiredLeases();
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

        $runRow = $db->table('smoke_observation_runs')->where('id', $row->run_id)->get()->getRow();
        $runUpdate = ['status' => 'running', 'updated_at' => $now];
        if ($runRow && empty($runRow->started_at)) {
            $runUpdate['started_at'] = $now;
        }
        $db->table('smoke_observation_runs')->where('id', $row->run_id)->update($runUpdate);

        $db->table('smoke_sessions')->where('id', $row->session_id)->update([
            'status'     => 'running',
            'started_at' => $now,
            'updated_at' => $now,
        ]);

        $db->transComplete();

        $session = $db->table('smoke_sessions')->where('id', $row->session_id)->get()->getRowArray();
        $run     = $db->table('smoke_observation_runs')->where('id', $row->run_id)->get()->getRowArray();
        $profile = $run ? $db->table('smoke_target_profiles')->where('id', $run['target_profile_id'])->get()->getRowArray() : null;

        Services::runLog()->append(
            (int) $row->run_id,
            (int) $row->session_id,
            (int) $row->id,
            'worker',
            'info',
            sprintf('Worker %s leased job for session "%s"', $workerId, (string) ($session['name'] ?? $row->session_id)),
            ['worker_id' => $workerId, 'expires_at' => $expiry],
        );

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
        $this->cancelPendingDecisionsForJob($jobId, $now);
        $db->table('smoke_sessions')->where('id', $job->session_id)->update([
            'status'       => 'done',
            'completed_at' => $now,
            'updated_at'   => $now,
        ]);
        Services::runLog()->append(
            (int) $job->run_id,
            (int) $job->session_id,
            $jobId,
            'worker',
            'info',
            'Session completed successfully',
        );
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
        $this->cancelPendingDecisionsForJob($jobId, $now);
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
            Services::runLog()->append(
                (int) $job->run_id,
                (int) $job->session_id,
                $jobId,
                'worker',
                'warn',
                'Session failed — re-queued for retry: ' . mb_substr($error, 0, 500),
            );
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
            Services::runLog()->append(
                (int) $job->run_id,
                (int) $job->session_id,
                $jobId,
                'worker',
                'error',
                'Session failed: ' . mb_substr($error, 0, 500),
            );
            $db->query('UPDATE smoke_observation_runs SET sessions_failed = sessions_failed + 1, updated_at = NOW() WHERE id = ?', [$job->run_id]);
            $this->finalizeRunIfDone((int) $job->run_id);
        }
    }

    private function requeueExpiredLeases(): void
    {
        $db = Database::connect();
        $now = date('Y-m-d H:i:s');
        $expired = $db->table('smoke_session_jobs')
            ->whereIn('status', ['leased', 'awaiting_decision'])
            ->where('lease_expires_at <', $now)
            ->get()
            ->getResult();

        foreach ($expired as $job) {
            $wasAwaiting = (string) $job->status === 'awaiting_decision';
            if ($wasAwaiting) {
                $this->timeoutPendingDecisionsForJob((int) $job->id, $now);
            }
            $shouldRetry = (int) $job->attempts < (int) $job->max_attempts;
            if ($shouldRetry) {
                $db->table('smoke_session_jobs')->where('id', $job->id)->update([
                    'status'           => 'queued',
                    'leased_by'        => null,
                    'leased_at'        => null,
                    'lease_expires_at' => null,
                    'last_error'       => $wasAwaiting
                        ? 'Awaiting decision lease expired — re-queued'
                        : 'Lease expired — re-queued',
                    'updated_at'       => $now,
                ]);
                Services::runLog()->append(
                    (int) $job->run_id,
                    (int) $job->session_id,
                    (int) $job->id,
                    'system',
                    'warn',
                    $wasAwaiting
                        ? 'Job awaiting decision expired — pending decisions timed out and job returned to queue'
                        : 'Job lease expired — returned to queue',
                );
            } else {
                $this->markFailed(
                    (int) $job->id,
                    $wasAwaiting
                        ? 'Awaiting decision timed out and max attempts reached'
                        : 'Lease expired and max attempts reached',
                );
            }
        }
    }

    /**
     * Re-queue a single session job so the worker picks it up again.
     *
     * @return array{ok:bool, job_id:int, session_id:int, run_id:int}
     */
    public function rerunSession(int $runId, int $sessionId, ?int $triggeredBy = null): array
    {
        $db = Database::connect();
        $run = $db->table('smoke_observation_runs')->where('id', $runId)->get()->getRow();
        if (! $run) {
            throw new RuntimeException('Run not found.');
        }

        $session = $db->table('smoke_sessions')
            ->where('id', $sessionId)
            ->where('plan_id', $run->plan_id)
            ->get()
            ->getRow();
        if (! $session) {
            throw new RuntimeException('Session does not belong to this run.');
        }

        $job = $db->table('smoke_session_jobs')
            ->where('run_id', $runId)
            ->where('session_id', $sessionId)
            ->get()
            ->getRow();
        if (! $job) {
            throw new RuntimeException('No job found for this session in the run.');
        }
        if (in_array($job->status, ['leased', 'awaiting_decision'], true)) {
            throw new RuntimeException('Session is currently active with a worker. Wait for it to finish or cancel the run.');
        }

        $prevJobStatus = (string) $job->status;
        $prevSessionStatus = (string) $session->status;
        $now = date('Y-m-d H:i:s');
        $maxAttempts = max(1, (int) env('WORKER_MAX_RETRIES', 2) + 1);

        $db->table('smoke_session_jobs')->where('id', $job->id)->update([
            'status'           => 'queued',
            'attempts'         => 0,
            'max_attempts'     => $maxAttempts,
            'leased_by'        => null,
            'leased_at'        => null,
            'lease_expires_at' => null,
            'last_error'       => null,
            'updated_at'       => $now,
        ]);

        $db->table('smoke_sessions')->where('id', $sessionId)->update([
            'status'        => 'pending',
            'started_at'    => null,
            'completed_at'  => null,
            'error_message' => null,
            'updated_at'    => $now,
        ]);

        // Adjust roll-up counters when re-running a previously finished session.
        if ($prevSessionStatus === 'done' || $prevJobStatus === 'done') {
            $db->query(
                'UPDATE smoke_observation_runs SET sessions_done = GREATEST(sessions_done - 1, 0), updated_at = ? WHERE id = ?',
                [$now, $runId],
            );
        } elseif ($prevSessionStatus === 'failed' || $prevJobStatus === 'failed') {
            $db->query(
                'UPDATE smoke_observation_runs SET sessions_failed = GREATEST(sessions_failed - 1, 0), updated_at = ? WHERE id = ?',
                [$now, $runId],
            );
        }

        $db->table('smoke_observation_runs')->where('id', $runId)->update([
            'status'       => 'running',
            'completed_at' => null,
            'updated_at'   => $now,
        ]);

        Services::runLog()->append(
            $runId,
            $sessionId,
            (int) $job->id,
            'system',
            'info',
            sprintf('Session "%s" manually re-queued for another observation pass', (string) $session->name),
            ['previous_job_status' => $prevJobStatus, 'previous_session_status' => $prevSessionStatus],
        );

        Services::audit()->record('runs.rerun_session', 'smoke_sessions', (string) $sessionId, $triggeredBy, [
            'run_id' => $runId,
            'job_id' => (int) $job->id,
        ]);

        return [
            'ok'         => true,
            'job_id'     => (int) $job->id,
            'session_id' => $sessionId,
            'run_id'     => $runId,
        ];
    }

    public function finalizeRunIfDone(int $runId): void
    {
        $db = Database::connect();
        $run = $db->table('smoke_observation_runs')->where('id', $runId)->get()->getRow();
        if (! $run) return;
        $remaining = $db->table('smoke_session_jobs')
            ->where('run_id', $runId)
            ->whereIn('status', ['queued', 'leased', 'awaiting_decision'])
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
        Services::runLog()->append(
            $runId,
            null,
            null,
            'system',
            $finalStatus === 'failed' ? 'error' : 'info',
            sprintf('Run %s %s (%d done, %d failed)', $run->run_code, $finalStatus, (int) $run->sessions_done, (int) $run->sessions_failed),
        );
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
        $resolver = new \App\Services\Reports\ReportArtifactResolver();
        $base = $resolver->reportsBase();
        $date = date('Y-m-d');
        $dir = rtrim($base, '/\\') . '/' . $product . '/' . $date . '/' . $runCode;
        return $resolver->ensureDir($dir);
    }

    private function cancelPendingDecisionsForJob(int $jobId, string $now): void
    {
        Database::connect()->table('smoke_run_decisions')
            ->where('job_id', $jobId)
            ->where('status', 'pending')
            ->update([
                'status'     => 'cancelled',
                'updated_at' => $now,
            ]);
    }

    private function timeoutPendingDecisionsForJob(int $jobId, string $now): void
    {
        Database::connect()->table('smoke_run_decisions')
            ->where('job_id', $jobId)
            ->where('status', 'pending')
            ->update([
                'status'     => 'timed_out',
                'updated_at' => $now,
            ]);
    }
}
