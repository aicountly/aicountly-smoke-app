<?php

namespace App\Services\Brain\Adapters;

/**
 * Always-available no-AI fallback. Returns a stable, rules-based plan/review
 * so the portal works end-to-end even when no API keys are configured. The
 * BrainEnsemble auto-engages this when no other provider is configured AND
 * for unit-testable deterministic flows.
 */
class DeterministicAdapter extends AbstractAdapter
{
    public function name(): string
    {
        return 'deterministic';
    }

    public function isConfigured(): bool
    {
        return true;
    }

    public function complete(string $systemPrompt, string $userPrompt, array $options = []): array
    {
        $task = (string) ($options['task'] ?? 'plan');
        $product = (string) ($options['product'] ?? 'unknown');
        $env = (string) ($options['environment'] ?? 'sandbox');

        switch ($task) {
            case 'plan':
                $output = $this->fallbackPlan($product, $env);
                break;
            case 'arbitrate':
                $output = (array) ($options['parallel_outputs'] ?? []);
                $output = ['arbiter' => 'deterministic', 'merged' => $output];
                break;
            case 'ux_review':
                $output = ['ux_issues' => [], 'note' => 'Deterministic fallback: heuristic-only UX issues are produced by the worker reviewer module.'];
                break;
            case 'feature_gap':
                $output = ['feature_gaps' => [], 'note' => 'Deterministic fallback: feature gaps come from competitor benchmarks via the worker reviewer.'];
                break;
            default:
                $output = ['note' => 'Deterministic fallback active. Configure an AI provider for richer output.'];
        }

        return [
            'provider'   => $this->name(),
            'model'      => 'rules-v1',
            'raw'        => json_encode($output, JSON_PRETTY_PRINT),
            'output'     => $output,
            'usage'      => [],
            'latency_ms' => 0,
            'sources'    => [],
        ];
    }

    private function fallbackPlan(string $product, string $env): array
    {
        $samplesDir = realpath(WRITEPATH . '../../samples/sessions');
        if ($samplesDir !== false) {
            $candidate = $samplesDir . DIRECTORY_SEPARATOR . $product . '.json';
            if (is_file($candidate)) {
                $j = json_decode((string) file_get_contents($candidate), true);
                if (is_array($j)) {
                    return $j + ['source' => 'samples/sessions/' . $product . '.json', 'environment' => $env];
                }
            }
        }
        return [
            'product_name' => $product,
            'environment'  => $env,
            'rationale'    => 'Deterministic fallback: explore main navigation menu by menu.',
            'sessions'     => [
                ['ordinal' => 1, 'name' => 'Login + Dashboard',         'menu_path' => '/',          'expected_screens' => 4],
                ['ordinal' => 2, 'name' => 'Primary Navigation Sweep',  'menu_path' => '/menu/*',    'expected_screens' => 12],
                ['ordinal' => 3, 'name' => 'Reports & Filters',         'menu_path' => '/reports/*', 'expected_screens' => 8],
                ['ordinal' => 4, 'name' => 'Settings / Configuration',  'menu_path' => '/settings/*','expected_screens' => 6],
            ],
        ];
    }
}
