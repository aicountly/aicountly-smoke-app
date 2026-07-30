<?php

namespace App\Database\Migrations;

use App\Services\Reports\MaturityScore;
use CodeIgniter\Database\BaseBuilder;
use CodeIgniter\Database\Migration;

/**
 * Session reports were written with a NULL maturity_score, which the UI showed
 * as a flat 0, and final reports were scored with a gap penalty that grew with
 * the size of the run. Both are recomputed here so every existing report sits
 * on the same scale as the ones this release will write.
 *
 * Reports whose scope observed no screens stay NULL: they have no maturity to
 * state, and the UI now says so instead of showing zero.
 */
class BackfillReportMaturityScores extends Migration
{
    public function up(): void
    {
        $reports = $this->db->table('smoke_reports')
            ->select('id, run_id, session_id, kind')
            ->get()
            ->getResultArray();

        foreach ($reports as $report) {
            $this->db->table('smoke_reports')
                ->where('id', (int) $report['id'])
                ->update(['maturity_score' => $this->score($report)]);
        }
    }

    /** A recomputed score is not schema, so there is nothing to roll back to. */
    public function down(): void
    {
    }

    /** @param array<string, mixed> $report */
    private function score(array $report): ?float
    {
        $runId     = (int) $report['run_id'];
        $sessionId = ($report['kind'] ?? '') === 'session' && ! empty($report['session_id'])
            ? (int) $report['session_id']
            : null;

        $screens = $this->scope('smoke_observation_results', $runId, $sessionId)->countAllResults();
        $gaps    = $this->scope('smoke_feature_gaps', $runId, $sessionId)
            ->select('severity, mode, observed')
            ->get()
            ->getResultArray();

        $severityCount = ['critical' => 0, 'high' => 0, 'medium' => 0, 'low' => 0, 'suggestion' => 0];
        $bySeverity = $this->scope('smoke_ux_issues', $runId, $sessionId)
            ->select('severity, COUNT(*) AS c')
            ->groupBy('severity')
            ->get()
            ->getResultArray();
        foreach ($bySeverity as $row) {
            $severity = strtolower((string) $row['severity']);
            if (isset($severityCount[$severity])) {
                $severityCount[$severity] = (int) $row['c'];
            }
        }

        return MaturityScore::forScope($severityCount, $gaps, $screens);
    }

    private function scope(string $table, int $runId, ?int $sessionId): BaseBuilder
    {
        $builder = $this->db->table($table)->where('run_id', $runId);
        if ($sessionId !== null) {
            $builder->where('session_id', $sessionId);
        }
        return $builder;
    }
}
