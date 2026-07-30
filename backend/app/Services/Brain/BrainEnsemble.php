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
 * Provider failures are hard failures: callers must never silently substitute
 * deterministic rules for an unavailable or malformed model response.
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

        // Synthetic form/file datasets: Perplexity first, OpenAI fallback. Sequential.
        if ($task === 'synthetic_data') {
            return $this->invokeDataProviders($systemPrompt, $userPrompt, $contextOptions);
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
            throw $this->unavailableFromResults($parallelResults, $arbiterResult);
        }
        if (in_array($task, ['navigation_wisdom', 'ask_user'], true)
            && ! $this->looksLikeDecision($arbiterResult['output'] ?? null)) {
            throw new BrainUnavailableException(
                (string) ($arbiterResult['provider'] ?? 'unknown'),
                0,
                'Provider returned a malformed navigation decision.',
            );
        }
        if ($task === 'file_quality' && ! $this->looksLikeFileQuality($arbiterResult['output'] ?? null)) {
            throw new BrainUnavailableException(
                (string) ($arbiterResult['provider'] ?? 'unknown'),
                0,
                'Provider returned a malformed file-quality response.',
            );
        }
        if ($task === 'form_fill') {
            $arbiterResult['output'] = $this->sanitizeFormFill($arbiterResult['output'] ?? null, $contextOptions);
        }

        return [
            'task'       => $task,
            'final'      => $arbiterResult['output'] ?? $arbiterResult,
            'arbiter'    => $arbiterResult['provider'] ?? 'unknown',
            'parallel'   => $parallelResults,
            'context'    => $contextOptions,
            'created_at' => date(DATE_ATOM),
        ];
    }

    /**
     * Single-provider plan path: first configured planner wins.
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
            throw $this->unavailableFromResults($parallelResults);
        }

        return [
            'task'       => 'plan',
            'final'      => $winner['output'] ?? $winner,
            'arbiter'    => $winner['provider'] ?? 'unknown',
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

    /**
     * Sequential synthetic-data path: Perplexity then OpenAI (configurable).
     * First valid JSON payload wins; one repair attempt per provider.
     *
     * @param array<string,mixed> $contextOptions
     * @return array<string,mixed>
     */
    private function invokeDataProviders(string $systemPrompt, string $userPrompt, array $contextOptions): array
    {
        $contextOptions['timeout'] = min((int) ($contextOptions['timeout'] ?? 60), 45);
        $members = $this->resolveMembers(
            $this->settings->getStringList('brain.data_providers', ['perplexity', 'openai']),
        );
        $parallelResults = [];
        $winner = null;
        $failures = [];

        foreach ($members as $member) {
            if ($member instanceof DeterministicAdapter) {
                continue;
            }
            try {
                $result = $member->complete($systemPrompt, $userPrompt, $contextOptions);
                if (! $this->looksLikeSyntheticData($result['output'] ?? null)) {
                    $repair = $member->complete(
                        $systemPrompt,
                        $userPrompt . "\n\nYour previous response was malformed. Return the required JSON object only.",
                        $contextOptions,
                    );
                    if (! $this->looksLikeSyntheticData($repair['output'] ?? null)) {
                        throw new BrainUnavailableException(
                            $member->name(),
                            0,
                            'Provider returned malformed synthetic_data JSON after one repair attempt.',
                        );
                    }
                    $result = $repair;
                }
                $parallelResults[$member->name()] = $result;
                $winner = $result;
                break;
            } catch (Throwable $e) {
                $parallelResults[$member->name()] = [
                    'provider' => $member->name(),
                    'error'    => $e->getMessage(),
                    'output'   => null,
                ];
                $failures[] = $member->name() . ': ' . $e->getMessage();
            }
        }

        if ($winner === null) {
            if ($failures === []) {
                throw new BrainUnavailableException('none', 0, 'No configured synthetic-data provider.');
            }
            throw new BrainUnavailableException(
                'synthetic_data',
                0,
                'All configured data providers failed: ' . implode('; ', $failures),
            );
        }

        return [
            'task'       => 'synthetic_data',
            'final'      => $winner['output'] ?? $winner,
            'arbiter'    => $winner['provider'] ?? 'unknown',
            'parallel'   => $parallelResults,
            'context'    => $contextOptions + ['data_mode' => 'sequential'],
            'created_at' => date(DATE_ATOM),
        ];
    }

    /** @param mixed $output */
    private function looksLikeSyntheticData($output): bool
    {
        if (! is_array($output)) {
            return false;
        }
        $hasFields = false;
        if (isset($output['fields']) && is_array($output['fields'])) {
            foreach ($output['fields'] as $value) {
                if (is_scalar($value)) {
                    $hasFields = true;
                    break;
                }
            }
        } else {
            foreach ($output as $key => $value) {
                if (in_array($key, ['dataset', 'notes', 'fields'], true)) {
                    continue;
                }
                if (is_scalar($value)) {
                    $hasFields = true;
                    break;
                }
            }
        }

        $hasDataset = false;
        $dataset = is_array($output['dataset'] ?? null) ? $output['dataset'] : null;
        if ($dataset !== null
            && is_array($dataset['columns'] ?? null)
            && $dataset['columns'] !== []
            && is_array($dataset['rows'] ?? null)
            && $dataset['rows'] !== []) {
            $hasDataset = true;
        }

        return $hasFields || $hasDataset;
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
     * Form-fill answers get typed into a live product, so only scalar values keyed
     * by a requested field survive. Anything else — prose, nested objects, keys
     * nobody asked about — is dropped rather than handed back to the worker.
     *
     * @param mixed $output
     * @param array<string,mixed> $contextOptions
     * @return array{values:array<string,string>}
     */
    private function sanitizeFormFill($output, array $contextOptions = []): array
    {
        if (! is_array($output)) {
            return ['values' => []];
        }
        $raw = is_array($output['values'] ?? null) ? $output['values'] : $output;
        $requested = [];
        foreach ((array) ($contextOptions['context']['fields'] ?? []) as $field) {
            if (is_array($field) && ($field['key'] ?? '') !== '') {
                $requested[(string) $field['key']] = true;
            }
        }

        $values = [];
        foreach ($raw as $key => $value) {
            $key = trim((string) $key);
            if ($key === '' || $key === 'note' || $key === 'values') {
                continue;
            }
            if ($requested !== [] && ! isset($requested[$key])) {
                continue;
            }
            if (is_bool($value)) {
                $value = $value ? 'true' : 'false';
            }
            if (! is_scalar($value)) {
                continue;
            }
            $value = trim((string) $value);
            if ($value === '' || mb_strlen($value) > 200) {
                continue;
            }
            $values[$key] = $value;
        }
        return ['values' => $values];
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
            if (! $adapter instanceof DeterministicAdapter
                && method_exists($adapter, 'isConfigured')
                && $adapter->isConfigured()) {
                $configured[] = $adapter;
            }
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

    /**
     * Vision providers are tried in configured order. Exactly one repair
     * request per provider is permitted when it returns malformed JSON.
     *
     * @param array<int,array{mime_type?:string,data:string}> $images
     * @param array<string,mixed> $context
     * @return array<string,mixed>
     */
    public function invokeVision(
        string $task,
        string $systemPrompt,
        string $userPrompt,
        array $images,
        array $context = [],
    ): array {
        $members = $this->resolveMembers(
            $this->settings->getStringList('brain.vision_providers', ['gemini', 'openai']),
        );
        $options = [
            'expect_json' => true,
            'temperature' => $context['temperature'] ?? 0.1,
            'timeout' => min($this->settings->getInt('brain.timeout_seconds', 60), 25),
            'images' => $images,
            'context' => $context,
        ];

        $failures = [];
        $lastError = null;
        foreach ($members as $member) {
            if (! ($member instanceof GeminiAdapter || $member instanceof OpenAIAdapter)) {
                continue;
            }

            try {
                $result = $member->complete($systemPrompt, $userPrompt, $options);
                if (! $this->looksLikeVisionDecision($result['output'] ?? null)) {
                    $repair = $member->complete(
                        $systemPrompt,
                        $userPrompt . "\n\nYour previous response was malformed. Return the required JSON object only.",
                        $options,
                    );
                    if (! $this->looksLikeVisionDecision($repair['output'] ?? null)) {
                        throw new BrainUnavailableException(
                            $member->name(),
                            0,
                            'Provider returned malformed JSON after one repair attempt.',
                        );
                    }
                    $result = $repair;
                }
            } catch (Throwable $error) {
                $lastError = $error instanceof BrainUnavailableException
                    ? $error
                    : BrainUnavailableException::fromThrowable($member->name(), $error);
                $failures[] = $member->name() . ': ' . $lastError->responseSnippet;
                continue;
            }

            return [
                'task' => $task,
                'final' => $result['output'],
                'arbiter' => $member->name(),
                'parallel' => [$member->name() => $result],
                'context' => $context,
                'created_at' => date(DATE_ATOM),
            ];
        }

        if ($lastError === null) {
            throw new BrainUnavailableException('none', 0, 'No configured vision-capable provider.');
        }

        throw new BrainUnavailableException(
            $lastError->provider,
            $lastError->httpStatus,
            'All configured vision providers failed: ' . implode('; ', $failures),
            $lastError,
        );
    }

    /** @return array<int,array{name:string,configured:bool,vision_capable:bool,enabled_for_vision:bool}> */
    public function providerHealth(): array
    {
        $enabled = array_map(
            'strtolower',
            $this->settings->getStringList('brain.vision_providers', ['gemini', 'openai']),
        );
        return [
            [
                'name' => 'gemini',
                'configured' => $this->gemini->isConfigured(),
                'vision_capable' => true,
                'enabled_for_vision' => in_array('gemini', $enabled, true),
            ],
            [
                'name' => 'openai',
                'configured' => $this->openai->isConfigured(),
                'vision_capable' => true,
                'enabled_for_vision' => in_array('openai', $enabled, true),
            ],
            [
                'name' => 'perplexity',
                'configured' => $this->perplexity->isConfigured(),
                'vision_capable' => false,
                'enabled_for_vision' => false,
            ],
        ];
    }

    private function unavailableFromResults(array $results, ?array $arbiter = null): BrainUnavailableException
    {
        $all = $results;
        if ($arbiter !== null) {
            $all[(string) ($arbiter['provider'] ?? 'arbiter')] = $arbiter;
        }
        foreach ($all as $provider => $result) {
            if (! empty($result['error'])) {
                return BrainUnavailableException::fromThrowable(
                    (string) $provider,
                    new \RuntimeException((string) $result['error']),
                );
            }
        }
        return new BrainUnavailableException('none', 0, 'No configured provider produced a usable response.');
    }

    /** @param mixed $output */
    private function looksLikeVisionDecision($output): bool
    {
        if (! is_array($output)
            || ! is_array($output['action'] ?? null)
            || trim((string) ($output['observation'] ?? '')) === ''
            || trim((string) ($output['reasoning'] ?? '')) === '') {
            return false;
        }
        $allowed = ['click', 'type', 'select', 'press', 'scroll', 'navigate', 'wait', 'done', 'blocked', 'ask_operator'];
        $type = (string) ($output['action']['type'] ?? '');
        if (! in_array($type, $allowed, true)) {
            return false;
        }
        if (in_array($type, ['click', 'type', 'select'], true)
            && (int) ($output['action']['mark'] ?? 0) <= 0) {
            return false;
        }
        return true;
    }
}
