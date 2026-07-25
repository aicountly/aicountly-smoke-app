<?php

namespace App\Services\Planner;

/**
 * Loads master prompt samples from samples/prompts/ on the server (deployed alongside api/).
 */
class MasterPromptSampleCatalog
{
    /** @var list<array{id:string,label:string,description:string,product?:string,prompt:string}>|null */
    private ?array $cache = null;

    /**
     * @return list<array{id:string,label:string,description:string,product?:string,prompt:string}>
     */
    public function all(): array
    {
        if ($this->cache !== null) {
            return $this->cache;
        }

        $dir = $this->promptsDir();
        if ($dir === null) {
            return $this->cache = [];
        }

        $manifestPath = $dir . DIRECTORY_SEPARATOR . 'manifest.json';
        if (! is_file($manifestPath)) {
            return $this->cache = $this->legacyFromTxtFiles($dir);
        }

        $manifest = json_decode((string) file_get_contents($manifestPath), true);
        if (! is_array($manifest) || ! is_array($manifest['samples'] ?? null)) {
            return $this->cache = [];
        }

        $out = [];
        foreach ($manifest['samples'] as $entry) {
            if (! is_array($entry)) {
                continue;
            }
            $id = trim((string) ($entry['id'] ?? ''));
            $file = trim((string) ($entry['file'] ?? ''));
            if ($id === '' || $file === '') {
                continue;
            }
            $path = $dir . DIRECTORY_SEPARATOR . $file;
            if (! is_file($path)) {
                continue;
            }
            $row = [
                'id'          => $id,
                'label'       => trim((string) ($entry['label'] ?? $id)),
                'description' => trim((string) ($entry['description'] ?? '')),
                'prompt'      => trim((string) file_get_contents($path)),
            ];
            $product = trim((string) ($entry['product'] ?? ''));
            if ($product !== '') {
                $row['product'] = $product;
            }
            $out[] = $row;
        }

        return $this->cache = $out;
    }

    /**
     * @return array{recommended:list<array<string,mixed>>,other:list<array<string,mixed>>}
     */
    public function forProduct(?string $productName): array
    {
        $all = $this->all();
        if ($productName === null || $productName === '') {
            return ['recommended' => [], 'other' => $all];
        }

        $recommended = [];
        $other = [];
        foreach ($all as $sample) {
            if (($sample['product'] ?? null) === $productName) {
                $recommended[] = $sample;
            } else {
                $other[] = $sample;
            }
        }

        return ['recommended' => $recommended, 'other' => $other];
    }

    private function promptsDir(): ?string
    {
        $candidates = [
            realpath(WRITEPATH . '../../samples/prompts'),
            realpath(WRITEPATH . '../../../samples/prompts'),
        ];
        foreach ($candidates as $dir) {
            if ($dir !== false && is_dir($dir)) {
                return $dir;
            }
        }

        return null;
    }

    /**
     * Fallback when manifest.json is missing — one sample per *.txt except manifest.
     *
     * @return list<array{id:string,label:string,description:string,product?:string,prompt:string}>
     */
    private function legacyFromTxtFiles(string $dir): array
    {
        $out = [];
        foreach (glob($dir . DIRECTORY_SEPARATOR . '*.txt') ?: [] as $path) {
            $base = basename($path, '.txt');
            if (str_starts_with($base, 'generic-')) {
                continue;
            }
            $prompt = trim((string) file_get_contents($path));
            if ($prompt === '') {
                continue;
            }
            $out[] = [
                'id'          => $base . '-full',
                'label'       => ucfirst(str_replace('-', ' ', $base)) . ' — Full product intelligence',
                'description' => 'Full module walk-through and product intelligence report.',
                'product'     => $base,
                'prompt'      => $prompt,
            ];
        }

        return $out;
    }
}
