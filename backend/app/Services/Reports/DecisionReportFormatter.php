<?php

namespace App\Services\Reports;

use Config\Database;

/**
 * Loads mid-run decisions for session/final HTML reports with human labels
 * and embedded screenshot previews when files exist on disk.
 */
class DecisionReportFormatter
{
    /**
     * @return list<array<string,mixed>>
     */
    public function forRun(int $runId, string $reportsDir, ?int $sessionId = null): array
    {
        $db = Database::connect();
        $query = $db->table('smoke_run_decisions')
            ->where('run_id', $runId)
            ->orderBy('id', 'ASC');
        if ($sessionId !== null) {
            $query->where('session_id', $sessionId);
        }
        $rows = $query->get()->getResultArray();
        $resolver = new ReportArtifactResolver();
        $cards = [];
        foreach ($rows as $row) {
            $cards[] = $this->formatRow($row, $reportsDir, $resolver);
        }
        return $cards;
    }

    /**
     * @param array<string,mixed> $row
     * @return array<string,mixed>
     */
    public function formatRow(array $row, string $reportsDir, ?ReportArtifactResolver $resolver = null): array
    {
        $resolver ??= new ReportArtifactResolver();
        $options = $this->decodeJsonList($row['options_json'] ?? null);
        $context = $this->decodeJsonObject($row['context_json'] ?? null);
        $selectedId = trim((string) ($row['selected_option'] ?? ''));
        $chosenLabel = $selectedId;
        foreach ($options as $option) {
            if (is_array($option) && (string) ($option['id'] ?? '') === $selectedId) {
                $chosenLabel = trim((string) ($option['label'] ?? $selectedId)) ?: $selectedId;
                break;
            }
        }

        $status = (string) ($row['status'] ?? '');
        $source = $this->resolveSource($status, $context, $row);
        $screenshotPath = (string) ($row['screenshot_path'] ?? '');
        $resolved = $screenshotPath !== ''
            ? $resolver->resolveFile($screenshotPath, $reportsDir)
            : null;
        $imageDataUri = $resolved && is_file($resolved) && filesize($resolved) > 0
            ? $this->imageDataUri($resolved)
            : '';

        return [
            'id'                   => (int) ($row['id'] ?? 0),
            'session_id'           => (int) ($row['session_id'] ?? 0),
            'situation_key'        => (string) ($row['situation_key'] ?? ''),
            'situation_label'      => $this->situationLabel((string) ($row['situation_key'] ?? '')),
            'question'             => (string) ($row['question'] ?? ''),
            'status'               => $status,
            'source'               => $source,
            'source_label'         => $this->sourceLabel($source),
            'selected_option'      => $selectedId,
            'chosen_label'         => $chosenLabel !== '' ? $chosenLabel : '—',
            'free_text'            => trim((string) ($row['free_text'] ?? '')),
            'has_note'             => trim((string) ($row['free_text'] ?? '')) !== '',
            'remember'             => (bool) ($row['remember'] ?? false),
            'remember_label'       => (bool) ($row['remember'] ?? false) ? 'Yes' : 'No',
            'answered_at'          => (string) ($row['answered_at'] ?? $row['updated_at'] ?? ''),
            'screenshot_path'      => $screenshotPath,
            'image_data_uri'       => $imageDataUri,
            'has_screenshot'       => $imageDataUri !== '',
            'context_url'          => trim((string) ($context['url'] ?? '')),
            'context_title'        => trim((string) ($context['title'] ?? '')),
        ];
    }

    /**
     * @param array<string,mixed> $context
     * @param array<string,mixed> $row
     */
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
        if (in_array($explicit, ['memory', 'auto', 'user', 'timeout'], true)) {
            return $explicit;
        }
        if (($row['answered_by'] ?? null) === null && trim((string) ($row['selected_option'] ?? '')) !== '') {
            return 'memory';
        }
        return 'user';
    }

    private function sourceLabel(string $source): string
    {
        return match ($source) {
            'memory' => 'Reused from memory',
            'auto' => 'Decided by the run',
            'user' => 'Answered by operator',
            'timeout' => 'Timed out waiting',
            'cancelled' => 'Cancelled',
            'pending' => 'Awaiting answer',
            default => ucfirst($source),
        };
    }

    private function situationLabel(string $key): string
    {
        if ($key === '') {
            return 'Decision';
        }
        if (str_starts_with($key, 'click_intercepted:')) {
            $label = trim(substr($key, strlen('click_intercepted:')));
            return $label !== '' ? 'Click blocked: ' . $label : 'Click blocked';
        }
        return match ($key) {
            'company_picker_empty' => 'No companies found',
            'company_picker_ambiguous' => 'Multiple companies found',
            'company_picker_click_blocked' => 'Company picker blocked',
            default => str_replace('_', ' ', $key),
        };
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

    private function imageDataUri(string $path): string
    {
        $extension = strtolower(pathinfo($path, PATHINFO_EXTENSION));
        $mime = match ($extension) {
            'jpg', 'jpeg' => 'image/jpeg',
            'webp' => 'image/webp',
            default => 'image/png',
        };
        return 'data:' . $mime . ';base64,' . base64_encode((string) file_get_contents($path));
    }
}
