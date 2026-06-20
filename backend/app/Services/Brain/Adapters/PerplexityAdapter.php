<?php

namespace App\Services\Brain\Adapters;

/**
 * Perplexity Sonar/Online API. The API surface mirrors OpenAI's chat completions
 * but adds `citations` for source URLs which we surface back as `sources`.
 */
class PerplexityAdapter extends AbstractAdapter
{
    public function name(): string
    {
        return 'perplexity';
    }

    public function isConfigured(): bool
    {
        return (string) env('PERPLEXITY_API_KEY', '') !== '';
    }

    public function complete(string $systemPrompt, string $userPrompt, array $options = []): array
    {
        $key   = (string) env('PERPLEXITY_API_KEY', '');
        $base  = rtrim((string) env('PERPLEXITY_BASE_URL', 'https://api.perplexity.ai'), '/');
        $model = (string) ($options['model'] ?? env('PERPLEXITY_MODEL', 'sonar-pro'));

        $payload = [
            'model'    => $model,
            'messages' => [
                ['role' => 'system', 'content' => $systemPrompt],
                ['role' => 'user',   'content' => $userPrompt],
            ],
            'temperature' => $options['temperature'] ?? 0.2,
        ];

        $res = $this->postJson(
            $base . '/chat/completions',
            [
                'Authorization' => 'Bearer ' . $key,
                'Content-Type'  => 'application/json',
            ],
            $payload,
        );

        $raw = (string) ($res['choices'][0]['message']['content'] ?? '');
        $sources = [];
        foreach ((array) ($res['citations'] ?? $res['search_results'] ?? []) as $c) {
            if (is_string($c)) {
                $sources[] = ['url' => $c];
            } elseif (is_array($c)) {
                $sources[] = [
                    'title' => $c['title'] ?? null,
                    'url'   => $c['url']   ?? ($c['link'] ?? null),
                ];
            }
        }
        return [
            'provider'   => $this->name(),
            'model'      => $model,
            'raw'        => $raw,
            'output'     => $this->extractJson($raw) ?? $raw,
            'usage'      => $res['usage'] ?? [],
            'latency_ms' => (int) ($res['__latency_ms'] ?? 0),
            'sources'    => $sources,
        ];
    }

    /**
     * Convenience helper for Search adapter usage.
     *
     * @return array{summary:string,sources:array<int,array<string,mixed>>}
     */
    public function search(string $query): array
    {
        $sys = 'You are a concise market research assistant. Return a tight bullet summary with sources.';
        $r = $this->complete($sys, $query);
        return [
            'summary' => is_string($r['output']) ? $r['output'] : (string) $r['raw'],
            'sources' => $r['sources'] ?? [],
        ];
    }
}
