<?php

namespace App\Services\Brain\Adapters;

use Config\Environments;

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
        $env = (string) ($options['environment'] ?? 'sandbox');
        $hints = strtolower($userPrompt . ' ' . (string) json_encode($context));
        $situationKey = strtolower((string) ($context['situation_key'] ?? ''));

        // The worker's own question arrives as the user prompt and describes the screen
        // it is actually looking at. Replacing it with a canned line here once told an
        // operator "No companies were found" about a picker listing two companies.
        $questionHint = trim((string) ($context['question'] ?? ''));
        if ($questionHint === '') {
            $questionHint = trim($userPrompt);
        }

        // Match the situation key, which is exact. Phrase matching is a fallback for
        // callers that send none, and it must not fire on "no company card could be
        // identified" — that is a detection failure on a populated picker, and
        // answering it with Create only adds a duplicate.
        $emptyCompany = str_contains($situationKey, 'company_picker_empty')
            || ($situationKey === '' && (
                str_contains($hints, 'no companies were found')
                || str_contains($hints, 'no companies yet')
                || str_contains($hints, 'no companies exist')
                || (str_contains($hints, 'company/all') && str_contains($hints, 'empty'))
            ));
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
                // session on an empty picker and looks like a false green run. An
                // observer-only tier may not create anything, so there recommending
                // it would only send the run at an action it is about to refuse.
                'recommended' => Environments::isObserverOnly($env)
                    ? 'skip_company_scoped_menus'
                    : 'create_company',
            ];
        }

        // The picker counts its companies but exposes none we can address. Creating
        // another one is the wrong answer here; only a name an operator can give us,
        // or going around the screen, gets the run anywhere.
        if (str_contains($situationKey, 'company_picker_unreadable')) {
            return [
                'question' => $questionHint !== ''
                    ? $questionHint
                    : 'The company picker lists companies that cannot be identified in the page markup. How should smoke proceed?',
                'options' => [
                    [
                        'id'     => 'open_named_company',
                        'label'  => 'Open a company by name — type its exact name in the note below',
                        'action' => 'open_company',
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
                // Naming the company needs a human, so the run's own best move is to go
                // around the screen and have the session reported as blocked.
                'recommended' => 'skip_company_scoped_menus',
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
