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
            case 'file_quality':
                $fidelity = (array) (($options['context']['fidelity'] ?? null) ?: []);
                $status = (string) ($fidelity['status'] ?? 'fail');
                $score = match ($status) {
                    'pass' => 100,
                    'partial' => 70,
                    default => 25,
                };
                $output = [
                    'scores' => [
                        'formatting' => $score,
                        'completeness' => $score,
                        'alignment' => $score,
                        'export_quality' => $score,
                        'overall' => $score,
                    ],
                    'verdict' => "Deterministic fidelity-only verdict: {$status}.",
                    'gaps' => $status === 'pass' ? [] : ['Artifact fidelity did not fully pass deterministic checks.'],
                    'recommendations' => $status === 'pass' ? [] : ['Preserve file structure, MIME type, and content during round-trip export.'],
                    'competitor_refs' => [],
                ];
                break;
            case 'navigation_wisdom':
            case 'ask_user':
                $output = $this->fallbackDecision($task, $userPrompt, $options);
                break;
            case 'form_fill':
                // The worker's own field heuristics already ran before it asked, so
                // proposing nothing here leaves those values in place untouched.
                $output = [
                    'values' => [],
                    'note'   => 'Deterministic fallback: the worker fills forms from its own field heuristics. Configure an AI provider to answer fields it cannot map.',
                ];
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

    /**
     * @param array<string,mixed> $options
     * @return array{question:string,options:list<array{id:string,label:string,action:string}>,recommended:string}
     */
    private function fallbackDecision(string $task, string $userPrompt, array $options): array
    {
        $context = is_array($options['context'] ?? null) ? $options['context'] : [];
        $hints = strtolower($userPrompt . ' ' . (string) json_encode($context));
        $situationKey = strtolower((string) ($context['situation_key'] ?? ''));
        $questionHint = trim((string) ($context['question'] ?? ''));

        $emptyCompany = str_contains($situationKey, 'company_picker_empty')
            || str_contains($hints, 'no companies')
            || str_contains($hints, 'no company')
            || (str_contains($hints, 'company/all') && str_contains($hints, 'empty'));
        if ($emptyCompany) {
            $companyName = trim((string) ($context['company_name'] ?? $context['preferred_company_name'] ?? 'Smoke Test Co'));
            if ($companyName === '') {
                $companyName = 'Smoke Test Co';
            }
            return [
                'question' => $questionHint !== '' ? $questionHint : 'No companies were found. How should smoke proceed?',
                'options' => [
                    [
                        'id'     => 'create_company',
                        'label'  => sprintf('Create “%s”', $companyName),
                        'action' => 'create_company',
                    ],
                    [
                        'id'     => 'skip_company_scoped_menus',
                        'label'  => 'Skip company-scoped menus',
                        'action' => 'skip_target',
                    ],
                    [
                        'id'     => 'abort_session',
                        'label'  => 'Abort this session',
                        'action' => 'abort_session',
                    ],
                ],
                // Prefer creating the smoke company — skipping leaves every later
                // session on an empty picker and looks like a false green run.
                'recommended' => 'create_company',
            ];
        }

        $clickIntercepted = str_contains($situationKey, 'click_intercepted')
            || str_contains($hints, 'click intercepted')
            || str_contains($hints, 'intercepts pointer')
            || str_contains($hints, 'overlay');
        if ($clickIntercepted) {
            $target = trim((string) ($context['target_label'] ?? $context['label'] ?? 'this control'));
            return [
                'question' => $questionHint !== ''
                    ? $questionHint
                    : sprintf('A UI overlay is blocking “%s”. How should smoke proceed?', $target),
                'options' => [
                    [
                        'id'     => 'dismiss_and_retry',
                        'label'  => 'Dismiss the overlay and retry',
                        'action' => 'dismiss_overlay',
                    ],
                    [
                        'id'     => 'skip_control',
                        'label'  => 'Skip this control',
                        'action' => 'skip_target',
                    ],
                    [
                        'id'     => 'rescan_menus',
                        'label'  => 'Rescan the current menus',
                        'action' => 'rescan_menus',
                    ],
                    [
                        'id'     => 'abort_session',
                        'label'  => 'Abort this session',
                        'action' => 'abort_session',
                    ],
                ],
                'recommended' => 'dismiss_and_retry',
            ];
        }

        return [
            'question' => $questionHint !== ''
                ? $questionHint
                : ($task === 'navigation_wisdom'
                    ? 'The next navigation step is ambiguous. How should smoke proceed?'
                    : 'Worker input is required. How should smoke proceed?'),
            'options' => [
                [
                    'id'     => 'rescan_menus',
                    'label'  => 'Rescan the current menus',
                    'action' => 'rescan_menus',
                ],
                [
                    'id'     => 'skip_target',
                    'label'  => 'Skip this target',
                    'action' => 'skip_target',
                ],
                [
                    'id'     => 'abort_session',
                    'label'  => 'Abort this session',
                    'action' => 'abort_session',
                ],
            ],
            'recommended' => 'rescan_menus',
        ];
    }
}
