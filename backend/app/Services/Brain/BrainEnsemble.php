<?php

namespace App\Services\Brain;

use App\Services\Brain\Adapters\BrainAdapterInterface;
use App\Services\Brain\Adapters\DeterministicAdapter;
use App\Services\Brain\Adapters\GeminiAdapter;
use App\Services\Brain\Adapters\OpenAIAdapter;
use App\Services\Brain\Adapters\PerplexityAdapter;
use App\Services\Settings\SettingsStore;
use Throwable;

/**
 * The "council" brain.
 *
 *   plan (default fast): first configured planner (OpenAI, then Gemini) only
 *   council / other tasks:
 *     parallel:  OpenAI + Perplexity (when configured) -> independent answers
 *     arbiter:   Gemini receives the question + both parallel answers and is
 *                asked to deliver the final decision (with its own analysis on
 *                top). Gemini's output is the single source of truth.
 *
 * If no provider is configured, the DeterministicAdapter is used so the rest of
 * the portal stays functional. Provider selection is driven by smoke_settings
 * keys `brain.parallel_providers`, `brain.default_arbiter`, and `brain.plan_mode`.
 */
class BrainEnsemble
{
    public function __construct(
        private OpenAIAdapter $openai,
        private PerplexityAdapter $perplexity,
        private GeminiAdapter $gemini,
        private DeterministicAdapter $deterministic,
        private SettingsStore $settings,
    ) {}

    /**
     * Invoke the ensemble. Returns the final arbiter decision plus per-member
     * details for traceability.
     *
     * For task=plan, defaults to a single-provider "fast" path (no Perplexity
     * research + no Gemini arbitration). Set smoke_settings key
     * `brain.plan_mode` = "council" to restore the full OpenAI+Perplexity->Gemini
     * flow when quality outweighs latency.
     *
     * @param array<string,mixed> $context  Free-form context (product, env, etc.)
     * @return array<string,mixed>
     */
    public function invoke(string $task, string $systemPrompt, string $userPrompt, array $context = []): array
    {
        $expectJson = (bool) ($context['expect_json'] ?? true);
        $contextOptions = [
            'expect_json'    => $expectJson,
            'task'           => $task,
            'product'        => $context['product']     ?? 'unknown',
            'environment'    => $context['environment'] ?? 'sandbox',
            'temperature'    => $context['temperature'] ?? 0.2,
            'timeout'        => $this->settings->getInt('brain.timeout_seconds', 60),
            'context'        => $context,
        ];

        // Session planning is latency-sensitive (browser waits on POST /master-prompts).
        // Prefer one planner call over the full council unless explicitly requested.
        if ($task === 'plan' && strtolower($this->settings->getString('brain.plan_mode', 'fast')) !== 'council') {
            return $this->invokeFastPlan($systemPrompt, $userPrompt, $contextOptions);
        }

        $parallel = $this->parallelMembers();
        $parallelResults = $this->runMembers($parallel, $systemPrompt, $userPrompt, $contextOptions);

        $arbiter = $this->arbiter();
        $arbiterResult = null;

        if ($arbiter instanceof GeminiAdapter && $arbiter->isConfigured()) {
            $arbiterResult = $this->arbitrateWithGemini($task, $systemPrompt, $userPrompt, $parallelResults, $contextOptions);
        } elseif (count($parallelResults) > 0) {
            $arbiterResult = $this->mechanicalMerge($parallelResults);
        }

        if ($arbiterResult === null || ($arbiterResult['error'] ?? null)) {
            $contextOptions['parallel_outputs'] = $parallelResults;
            $arbiterResult = $this->deterministic->complete($systemPrompt, $userPrompt, $contextOptions);
        }
        if (in_array($task, ['navigation_wisdom', 'ask_user'], true)
            && ! $this->looksLikeDecision($arbiterResult['output'] ?? null)) {
            $contextOptions['parallel_outputs'] = $parallelResults;
            $arbiterResult = $this->deterministic->complete($systemPrompt, $userPrompt, $contextOptions);
        }
        if ($task === 'file_quality' && ! $this->looksLikeFileQuality($arbiterResult['output'] ?? null)) {
            $contextOptions['parallel_outputs'] = $parallelResults;
            $arbiterResult = $this->deterministic->complete($systemPrompt, $userPrompt, $contextOptions);
        }

        return [
            'task'       => $task,
            'final'      => $arbiterResult['output'] ?? $arbiterResult,
            'arbiter'    => $arbiterResult['provider'] ?? 'deterministic',
            'parallel'   => $parallelResults,
            'context'    => $contextOptions,
            'created_at' => date(DATE_ATOM),
        ];
    }

    /**
     * Single-provider plan path: first configured planner wins, then deterministic.
     * Avoids OpenAI + Perplexity + Gemini serial latency (often 90–180s).
     *
     * @param array<string,mixed> $contextOptions
     * @return array<string,mixed>
     */
    private function invokeFastPlan(string $systemPrompt, string $userPrompt, array $contextOptions): array
    {
        // Cap planner wait so the UI fails over to the local sample plan instead of hanging.
        $contextOptions['timeout'] = min((int) ($contextOptions['timeout'] ?? 60), 45);

        $members = $this->resolveMembers(
            $this->settings->getStringList('brain.plan_providers', ['openai', 'gemini']),
        );
        $parallelResults = [];
        $winner = null;

        foreach ($members as $member) {
            if ($member instanceof DeterministicAdapter) {
                continue;
            }
            try {
                $result = $member->complete($systemPrompt, $userPrompt, $contextOptions);
                $parallelResults[$member->name()] = $result;
                if ($this->looksLikePlan($result['output'] ?? null)) {
                    $winner = $result;
                    break;
                }
            } catch (Throwable $e) {
                $parallelResults[$member->name()] = [
                    'provider' => $member->name(),
                    'error'    => $e->getMessage(),
                    'output'   => null,
                ];
            }
        }

        if ($winner === null) {
            $contextOptions['parallel_outputs'] = $parallelResults;
            $winner = $this->deterministic->complete($systemPrompt, $userPrompt, $contextOptions);
            $parallelResults['deterministic'] = [
                'provider'   => 'deterministic',
                'model'      => $winner['model'] ?? 'rules-v1',
                'latency_ms' => $winner['latency_ms'] ?? 0,
                'error'      => null,
            ];
        }

        return [
            'task'       => 'plan',
            'final'      => $winner['output'] ?? $winner,
            'arbiter'    => $winner['provider'] ?? 'deterministic',
            'parallel'   => $parallelResults,
            'context'    => $contextOptions + ['plan_mode' => 'fast'],
            'created_at' => date(DATE_ATOM),
        ];
    }

    /** @param mixed $output */
    private function looksLikePlan($output): bool
    {
        return is_array($output)
            && isset($output['sessions'])
            && is_array($output['sessions'])
            && $output['sessions'] !== [];
    }

    /** @param mixed $output */
    private function looksLikeDecision($output): bool
    {
        if (! is_array($output)
            || trim((string) ($output['question'] ?? '')) === ''
            || ! is_array($output['options'] ?? null)
            || $output['options'] === []
            || trim((string) ($output['recommended'] ?? '')) === '') {
            return false;
        }

        $optionIds = [];
        foreach ($output['options'] as $option) {
            if (! is_array($option)
                || trim((string) ($option['id'] ?? '')) === ''
                || trim((string) ($option['label'] ?? '')) === ''
                || trim((string) ($option['action'] ?? '')) === '') {
                return false;
            }
            $optionIds[] = (string) $option['id'];
        }
        return in_array((string) $output['recommended'], $optionIds, true);
    }

    /** @param mixed $output */
    private function looksLikeFileQuality($output): bool
    {
        if (! is_array($output) || ! is_array($output['scores'] ?? null)) {
            return false;
        }
        foreach (['formatting', 'completeness', 'alignment', 'export_quality', 'overall'] as $key) {
            $score = $output['scores'][$key] ?? null;
            if (! is_numeric($score) || (float) $score < 0 || (float) $score > 100) {
                return false;
            }
        }
        return isset($output['verdict'])
            && is_array($output['recommendations'] ?? null)
            && is_array($output['competitor_refs'] ?? null);
    }

    /**
     * @param BrainAdapterInterface[] $members
     * @param array<string,mixed> $contextOptions
     * @return array<string,array<string,mixed>>
     */
    private function runMembers(array $members, string $systemPrompt, string $userPrompt, array $contextOptions): array
    {
        $parallelResults = [];
        foreach ($members as $member) {
            try {
                $parallelResults[$member->name()] = $member->complete($systemPrompt, $userPrompt, $contextOptions);
            } catch (Throwable $e) {
                $parallelResults[$member->name()] = [
                    'provider' => $member->name(),
                    'error'    => $e->getMessage(),
                    'output'   => null,
                ];
            }
        }
        return $parallelResults;
    }

    /** @return BrainAdapterInterface[] */
    private function parallelMembers(): array
    {
        return $this->resolveMembers(
            $this->settings->getStringList('brain.parallel_providers', ['openai', 'perplexity']),
        );
    }

    /**
     * @param list<string> $wanted
     * @return BrainAdapterInterface[]
     */
    private function resolveMembers(array $wanted): array
    {
        $byName = [
            'openai'        => $this->openai,
            'perplexity'    => $this->perplexity,
            'gemini'        => $this->gemini,
            'deterministic' => $this->deterministic,
        ];

        $configured = [];
        foreach ($wanted as $name) {
            $adapter = $byName[$name] ?? null;
            if (! $adapter) {
                continue;
            }
            if ($adapter instanceof DeterministicAdapter || (method_exists($adapter, 'isConfigured') && $adapter->isConfigured())) {
                $configured[] = $adapter;
            }
        }

        if ($configured === []) {
            $configured[] = $this->deterministic;
        }
        return $configured;
    }

    private function arbiter(): BrainAdapterInterface
    {
        $name = strtolower($this->settings->getString('brain.default_arbiter', 'gemini'));
        return match ($name) {
            'openai'        => $this->openai,
            'perplexity'    => $this->perplexity,
            'deterministic' => $this->deterministic,
            default         => $this->gemini,
        };
    }

    private function arbitrateWithGemini(
        string $task,
        string $systemPrompt,
        string $userPrompt,
        array $parallelResults,
        array $contextOptions,
    ): array {
        $arbSystem = "You are the arbiter of an AI council for AICOUNTLY's product "
            . "intelligence portal.\n"
            . "You receive (a) the original system prompt, (b) the user prompt, and (c) "
            . "the answers produced independently by other models.\n"
            . "Your job: produce the single best, structured, JSON-valid answer for the "
            . "task '{$task}', combining the strongest points from each input and adding "
            . "your own analysis. Resolve conflicts. Drop unsupported claims. Cite "
            . "concrete observations only. Output JSON only.\n\n"
            . "Original system prompt:\n---\n{$systemPrompt}\n---\n";

        $arbUser = "Original user prompt:\n---\n{$userPrompt}\n---\n\n";
        $arbUser .= "Council answers (JSON):\n```json\n";
        $arbUser .= json_encode($parallelResults, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
        $arbUser .= "\n```\n\nReturn the final JSON only.";

        try {
            return $this->gemini->complete($arbSystem, $arbUser, array_merge($contextOptions, ['expect_json' => true]));
        } catch (Throwable $e) {
            return ['provider' => 'gemini', 'error' => $e->getMessage(), 'output' => null];
        }
    }

    private function mechanicalMerge(array $parallelResults): array
    {
        // No arbiter available -- pick the first non-error structured output.
        foreach ($parallelResults as $name => $r) {
            if (empty($r['error']) && ! empty($r['output'])) {
                return $r;
            }
        }
        return ['provider' => 'none', 'error' => 'all parallel members failed', 'output' => null];
    }
}
