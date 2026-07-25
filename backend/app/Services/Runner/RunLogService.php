<?php

namespace App\Services\Runner;

use Config\Database;

class RunLogService
{
    /**
     * @param array<string,mixed> $context
     */
    public function append(
        ?int $runId,
        ?int $sessionId,
        ?int $jobId,
        string $source,
        string $level,
        string $message,
        array $context = [],
    ): void {
        $db = Database::connect();
        $db->table('smoke_run_logs')->insert([
            'run_id'       => $runId,
            'session_id'   => $sessionId,
            'job_id'       => $jobId,
            'source'       => mb_substr($source, 0, 32),
            'level'        => mb_substr($level, 0, 16),
            'message'      => $message,
            'context_json' => $context === [] ? null : json_encode($context),
            'created_at'   => date('Y-m-d H:i:s'),
        ]);
    }

    /**
     * @return list<array<string,mixed>>
     */
    public function forRun(int $runId, ?int $afterId = null, int $limit = 200): array
    {
        $db = Database::connect();
        $q = $db->table('smoke_run_logs')
            ->where('run_id', $runId)
            ->orderBy('id', 'ASC')
            ->limit(max(1, min(500, $limit)));

        if ($afterId !== null && $afterId > 0) {
            $q->where('id >', $afterId);
        }

        return $q->get()->getResultArray();
    }
}
