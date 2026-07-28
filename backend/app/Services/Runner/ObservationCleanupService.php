<?php

namespace App\Services\Runner;

use App\Services\Reports\ReportArtifactResolver;
use Config\Database;

/**
 * Hard-deletes observation runs (and optionally target profiles), removing
 * DB rows plus on-disk reports, screenshots, and log-backed evidence.
 */
class ObservationCleanupService
{
    public function __construct(
        private readonly ReportArtifactResolver $resolver = new ReportArtifactResolver(),
    ) {
    }

    /**
     * Delete one observation run: files under reports_dir, then DB row
     * (CASCADE removes logs, results, reports, jobs, inventory, UX, gaps).
     *
     * @return array{ok: bool, run_id: int, run_code: string, files_removed: int, reports_dir: string|null}
     */
    public function deleteRun(int $runId): array
    {
        $db = Database::connect();
        $run = $db->table('smoke_observation_runs')->where('id', $runId)->get()->getRowArray();
        if (! $run) {
            throw new \RuntimeException('Run not found');
        }

        $filesRemoved = $this->removeRunFiles($run);
        $db->table('smoke_observation_runs')->where('id', $runId)->delete();

        return [
            'ok'            => true,
            'run_id'        => $runId,
            'run_code'      => (string) ($run['run_code'] ?? ''),
            'files_removed' => $filesRemoved,
            'reports_dir'   => $run['reports_dir'] ?? null,
        ];
    }

    /**
     * Hard-delete a target profile and all of its observation runs (logs,
     * screenshots, reports on disk + DB). Also removes credentials and
     * master prompts via FK CASCADE after runs are cleaned.
     *
     * @return array{ok: bool, profile_id: int, runs_deleted: int, files_removed: int}
     */
    public function deleteTargetProfile(int $profileId): array
    {
        $db = Database::connect();
        $profile = $db->table('smoke_target_profiles')->where('id', $profileId)->get()->getRowArray();
        if (! $profile) {
            throw new \RuntimeException('Target profile not found');
        }

        $runs = $db->table('smoke_observation_runs')
            ->where('target_profile_id', $profileId)
            ->get()
            ->getResultArray();

        $filesRemoved = 0;
        foreach ($runs as $run) {
            $filesRemoved += $this->removeRunFiles($run);
        }

        // Deleting the profile cascades: credentials, master prompts → plans →
        // sessions, and observation runs → logs/results/reports/jobs/etc.
        $db->table('smoke_target_profiles')->where('id', $profileId)->delete();

        return [
            'ok'            => true,
            'profile_id'    => $profileId,
            'runs_deleted'  => count($runs),
            'files_removed' => $filesRemoved,
        ];
    }

    /**
     * Remove screenshots, HTML/JSON reports, and the run's reports_dir tree.
     */
    private function removeRunFiles(array $run): int
    {
        $db = Database::connect();
        $runId = (int) ($run['id'] ?? 0);
        $reportsDir = (string) ($run['reports_dir'] ?? '');
        $removed = 0;

        $shotPaths = $db->table('smoke_observation_results')
            ->select('screenshot_path')
            ->where('run_id', $runId)
            ->get()
            ->getResultArray();
        foreach ($shotPaths as $row) {
            $path = $this->resolver->resolveFile((string) ($row['screenshot_path'] ?? ''), $reportsDir);
            if ($path !== null && $this->unlinkFile($path)) {
                $removed++;
            }
        }

        $reportPaths = $db->table('smoke_reports')
            ->select('html_path, json_path')
            ->where('run_id', $runId)
            ->get()
            ->getResultArray();
        foreach ($reportPaths as $row) {
            foreach (['html_path', 'json_path'] as $key) {
                $path = $this->resolver->resolveFile((string) ($row[$key] ?? ''), $reportsDir);
                if ($path !== null && $this->unlinkFile($path)) {
                    $removed++;
                }
            }
        }

        $fileRows = $db->table('smoke_report_files f')
            ->select('f.file_path')
            ->join('smoke_reports r', 'r.id = f.report_id')
            ->where('r.run_id', $runId)
            ->get()
            ->getResultArray();
        foreach ($fileRows as $row) {
            $path = $this->resolver->resolveFile((string) ($row['file_path'] ?? ''), $reportsDir);
            if ($path !== null && $this->unlinkFile($path)) {
                $removed++;
            }
        }

        if ($reportsDir !== '') {
            $dir = $this->resolver->resolveReportsDir($reportsDir);
            if (is_dir($dir) && $this->isSafeReportsPath($dir)) {
                $removed += $this->removeDirectoryTree($dir);
            }
        }

        return $removed;
    }

    private function unlinkFile(string $path): bool
    {
        if ($path === '' || ! is_file($path) || ! $this->isSafeReportsPath($path)) {
            return false;
        }
        return @unlink($path);
    }

    /**
     * Only allow deletes under the configured REPORTS_DIR (or path containing smoke-reports).
     */
    private function isSafeReportsPath(string $path): bool
    {
        $norm = str_replace('\\', '/', $path);
        $base = rtrim(str_replace('\\', '/', $this->resolver->reportsBase()), '/');
        if ($base !== '' && (str_starts_with($norm, $base . '/') || $norm === $base)) {
            return true;
        }
        // Fallback when REPORTS_DIR relative resolution differs from stored absolute paths.
        return (bool) preg_match('#/(?:smoke-reports)(/|$)#i', $norm);
    }

    private function removeDirectoryTree(string $dir): int
    {
        $removed = 0;
        $items = @scandir($dir);
        if ($items === false) {
            return 0;
        }
        foreach ($items as $item) {
            if ($item === '.' || $item === '..') {
                continue;
            }
            $full = $dir . DIRECTORY_SEPARATOR . $item;
            if (is_dir($full)) {
                $removed += $this->removeDirectoryTree($full);
            } elseif (is_file($full)) {
                if (@unlink($full)) {
                    $removed++;
                }
            }
        }
        @rmdir($dir);
        return $removed;
    }
}
