<?php

namespace App\Services\Runner;

use Config\Database;

class WorkerStatusService
{
    /** @return array<string,mixed> */
    public function snapshot(): array
    {
        $db = Database::connect();
        $now = date('Y-m-d H:i:s');
        $since = date('Y-m-d H:i:s', time() - 300);

        $queuedJobs = (int) $db->table('smoke_session_jobs')->where('status', 'queued')->countAllResults();
        $activeLeases = (int) $db->table('smoke_session_jobs')
            ->where('status', 'leased')
            ->where('lease_expires_at >', $now)
            ->countAllResults();

        $lastWorkerLog = $db->table('smoke_run_logs')
            ->where('source', 'worker')
            ->orderBy('id', 'DESC')
            ->limit(1)
            ->get()
            ->getRowArray();

        $recentWorkerLog = $lastWorkerLog && ($lastWorkerLog['created_at'] ?? '') >= $since;

        $lastLease = $db->table('smoke_session_jobs')
            ->where('leased_by IS NOT NULL', null, false)
            ->orderBy('updated_at', 'DESC')
            ->limit(1)
            ->get()
            ->getRowArray();

        $recentLease = $lastLease && ($lastLease['updated_at'] ?? '') >= $since;

        $online = $activeLeases > 0 || $recentWorkerLog || $recentLease;
        $lastSeenAt = null;
        if ($lastWorkerLog) {
            $lastSeenAt = $lastWorkerLog['created_at'];
        } elseif ($lastLease) {
            $lastSeenAt = $lastLease['updated_at'];
        }

        $message = 'Worker idle';
        if ($online) {
            $message = $activeLeases > 0
                ? "Worker active — {$activeLeases} job(s) in progress"
                : 'Worker recently active';
        } elseif ($queuedJobs > 0) {
            $message = 'Worker offline — jobs stay queued until PM2 process aicountly-smoke-worker is online (worker/ecosystem.config.cjs)';
        }

        return [
            'online'        => $online,
            'queued_jobs'   => $queuedJobs,
            'active_leases' => $activeLeases,
            'last_seen_at'  => $lastSeenAt,
            'message'       => $message,
        ];
    }
}
