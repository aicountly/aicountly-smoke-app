<?php

namespace App\Services\Brain\Adapters;

/**
 * Google Gemini generateContent endpoint.
 */
class GeminiAdapter extends AbstractAdapter
{
    public function name(): string
    {
        return 'gemini';
    }

    public function isConfigured(): bool
    {
        return (string) env('GEMINI_API_KEY', '') !== '';
    }

    public function complete(string $systemPrompt, string $userPrompt, array $options = []): array
    {
        $key   = (string) env('GEMINI_API_KEY', '');
        $base  = rtrim((string) env('GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta'), '/');
        $model = (string) ($options['model'] ?? env('GEMINI_MODEL', 'gemini-2.5-pro'));

        $url = $base . '/models/' . urlencode($model) . ':generateContent?key=' . urlencode($key);

        $payload = [
            'systemInstruction' => [
                'role'  => 'system',
                'parts' => [['text' => $systemPrompt]],
            ],
            'contents' => [[
                'role'  => 'user',
                'parts' => [['text' => $userPrompt]],
            ]],
            'generationConfig' => [
                'temperature' => $options['temperature'] ?? 0.2,
            ],
        ];
        if (! empty($options['expect_json'])) {
            $payload['generationConfig']['responseMimeType'] = 'application/json';
        }

        $res = $this->postJson($url, ['Content-Type' => 'application/json'], $payload);

        $raw = '';
        foreach ((array) ($res['candidates'][0]['content']['parts'] ?? []) as $part) {
            if (isset($part['text'])) {
                $raw .= $part['text'];
            }
        }
        return [
            'provider'   => $this->name(),
            'model'      => $model,
            'raw'        => $raw,
            'output'     => $this->extractJson($raw) ?? $raw,
            'usage'      => $res['usageMetadata'] ?? [],
            'latency_ms' => (int) ($res['__latency_ms'] ?? 0),
            'sources'    => [],
        ];
    }
}
