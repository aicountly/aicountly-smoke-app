<?php

namespace App\Services\Brain\Adapters;

interface BrainAdapterInterface
{
    public function name(): string;

    public function isConfigured(): bool;

    /**
     * Synchronous invocation. Returns a structured response:
     *
     *   [
     *     'provider'  => 'openai|perplexity|gemini|deterministic',
     *     'model'     => string,
     *     'output'    => mixed (parsed JSON if available, else string),
     *     'raw'       => string (full raw text),
     *     'sources'   => array<int,array{title?:string,url?:string}> (optional),
     *     'usage'     => array<string,mixed> (optional),
     *     'latency_ms'=> int (optional),
     *   ]
     *
     * Throws on transport / auth failures so the ensemble can decide what to do.
     */
    public function complete(string $systemPrompt, string $userPrompt, array $options = []): array;
}
