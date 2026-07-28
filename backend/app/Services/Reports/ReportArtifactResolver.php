<?php

namespace App\Services\Reports;

/**
 * Resolves report / screenshot paths written by the worker (often absolute on
 * another account or CWD) against the API host's REPORTS_DIR layout.
 */
class ReportArtifactResolver
{
    public function reportsBase(): string
    {
        $base = (string) env('REPORTS_DIR', '../smoke-reports');
        return $this->absolutize($base);
    }

    /**
     * Make a reports_dir (run-level) absolute and writable.
     */
    public function resolveReportsDir(string $reportsDir): string
    {
        $reportsDir = trim($reportsDir);
        if ($reportsDir === '') {
            return $this->reportsBase();
        }
        if ($this->isAbsolute($reportsDir)) {
            return $this->normalizeSlashes($reportsDir);
        }

        // Relative to REPORTS_DIR root when the stored value looks like product/date/run
        $underBase = rtrim($this->reportsBase(), '/\\') . '/' . ltrim($reportsDir, '/\\');
        if (is_dir($underBase) || is_dir(dirname($underBase))) {
            return $this->normalizeSlashes($underBase);
        }

        return $this->absolutize($reportsDir);
    }

    /**
     * Find an on-disk file for a stored path. Returns null when nothing matches.
     */
    public function resolveFile(?string $storedPath, ?string $runReportsDir = null): ?string
    {
        $storedPath = trim((string) $storedPath);
        if ($storedPath === '') {
            return null;
        }

        $candidates = [];
        $candidates[] = $storedPath;

        if (! $this->isAbsolute($storedPath)) {
            $candidates[] = $this->absolutize($storedPath);
            $candidates[] = rtrim($this->reportsBase(), '/\\') . '/' . ltrim($storedPath, '/\\');
            if ($runReportsDir) {
                $absRun = $this->resolveReportsDir($runReportsDir);
                $candidates[] = rtrim($absRun, '/\\') . '/' . ltrim($storedPath, '/\\');
            }
        }

        // Worker wrote /home/OTHER_USER/.../smoke-reports/product/date/run/...
        // Remap the trailing smoke-reports/... segment onto our REPORTS_DIR.
        $relative = $this->extractReportsRelative($storedPath);
        if ($relative !== null) {
            $candidates[] = rtrim($this->reportsBase(), '/\\') . '/' . $relative;
            if ($runReportsDir) {
                $absRun = $this->resolveReportsDir($runReportsDir);
                $basename = basename($storedPath);
                $candidates[] = rtrim($absRun, '/\\') . '/' . $basename;
                $candidates[] = rtrim($absRun, '/\\') . '/sessions/' . $basename;
                $candidates[] = rtrim($absRun, '/\\') . '/screenshots/' . $basename;
            }
        }

        if ($runReportsDir) {
            $absRun = $this->resolveReportsDir($runReportsDir);
            $basename = basename($storedPath);
            $candidates[] = rtrim($absRun, '/\\') . '/' . $basename;
            $candidates[] = rtrim($absRun, '/\\') . '/sessions/' . $basename;
            $candidates[] = rtrim($absRun, '/\\') . '/screenshots/' . $basename;
        }

        foreach ($candidates as $c) {
            $c = $this->normalizeSlashes($c);
            if ($c !== '' && is_file($c)) {
                return $c;
            }
        }

        return null;
    }

    /**
     * Ensure parent dirs exist for a reports path under the configured base.
     */
    public function ensureDir(string $dir): string
    {
        $dir = $this->resolveReportsDir($dir);
        if (! is_dir($dir)) {
            @mkdir($dir, 0775, true);
        }
        return $dir;
    }

    private function extractReportsRelative(string $path): ?string
    {
        $norm = str_replace('\\', '/', $path);
        if (preg_match('#/(?:smoke-reports|qa-reports)/(.+)$#i', $norm, $m)) {
            return $m[1];
        }
        // Stored as smoke-reports/product/...
        if (preg_match('#^(?:smoke-reports|qa-reports)/(.+)$#i', $norm, $m)) {
            return $m[1];
        }
        return null;
    }

    private function absolutize(string $path): string
    {
        $path = trim($path);
        if ($path === '') {
            return $path;
        }
        if ($this->isAbsolute($path)) {
            return $this->normalizeSlashes($path);
        }

        // Prefer resolving relative to backend ROOTPATH (…/backend/../smoke-reports).
        $fromRoot = $this->normalizeSlashes(rtrim(ROOTPATH, '/\\') . '/' . $path);
        $real = realpath($fromRoot);
        if ($real !== false) {
            return $this->normalizeSlashes($real);
        }

        // Collapse ../ segments without requiring the path to exist yet.
        return $this->normalizeSlashes($this->collapseDots($fromRoot));
    }

    private function isAbsolute(string $path): bool
    {
        return str_starts_with($path, '/')
            || (strlen($path) > 2 && ctype_alpha($path[0]) && $path[1] === ':' );
    }

    private function normalizeSlashes(string $path): string
    {
        return str_replace('\\', '/', $path);
    }

    private function collapseDots(string $path): string
    {
        $parts = [];
        foreach (explode('/', str_replace('\\', '/', $path)) as $part) {
            if ($part === '' || $part === '.') {
                if ($part === '' && $parts === []) {
                    $parts[] = '';
                }
                continue;
            }
            if ($part === '..') {
                if (count($parts) > 1) {
                    array_pop($parts);
                }
                continue;
            }
            $parts[] = $part;
        }
        $out = implode('/', $parts);
        return $out === '' ? '/' : $out;
    }
}
