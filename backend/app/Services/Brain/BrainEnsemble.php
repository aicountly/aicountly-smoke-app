<?php

namespace App\Services\Brain;

use App\Services\Brain\Adapters\BrainAdapterInterface;
use App\Services\Brain\Adapters\DeterministicAdapter;
use App\Services\Brain\Adapters\GeminiAdapter;
use App\Services\Brain\Adapters\OpenAIAdapter;
use App\Services\Brain\Adapters\PerplexityAdapter;
use Throwable;

/**
 * The "council" brain.
 *
 *   parallel:  OpenAI + Perplexity (when configured) -> independent answers
 *   arbiter:   Gemini receives the question + both parallel answers and is
 *              asked to deliver the final decision (with its own analysis on
 *              top). Gemini's output is the single source of truth.
 *
 * If no provider is configured, the DeterministicAdapter is used so the rest of
 * the portal stays functional. The configured providers can be overridden via
 * the smoke_settings keys `brain.parallel_providers` and `brain.default_arbiter`.
 */
class BrainEnsemble
{
    public function __construct(
        private OpenAIAdapter $openai,
        private PerplexityAdapter $perplexity,
        private GeminiAdapter $gemini,
        private DeterministicAdapter $deterministic,
    ) {}

    /**
     * Invoke the ensemble. Returns the final arbiter decision plus per-member
     * details for traceability.
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
        ];

        $parallel = $this->parallelMembers();
        $parallelResults = [];
        foreach ($parallel as $member) {
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

        return [
            'task'       => $task,
            'final'      => $arbiterResult['output'] ?? $arbiterResult,
            'arbiter'    => $arbiterResult['provider'] ?? 'deterministic',
            'parallel'   => $parallelResults,
            'context'    => $contextOptions,
            'created_at' => date(DATE_ATOM),
        ];
    }

    /** @return BrainAdapterInterface[] */
    private function parallelMembers(): array
    {
        $configured = [];
        if ($this->openai->isConfigured()) {
            $configured[] = $this->openai;
        }
        if ($this->perplexity->isConfigured()) {
            $configured[] = $this->perplexity;
        }
        if ($configured === []) {
            $configured[] = $this->deterministic;
        }
        return $configured;
    }

    private function arbiter(): BrainAdapterInterface
    {
        return $this->gemini;
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
