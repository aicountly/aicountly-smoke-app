<?php

namespace App\Services\Brain\Adapters;

class OpenAIAdapter extends AbstractAdapter
{
    public function name(): string
    {
        return 'openai';
    }

    public function isConfigured(): bool
    {
        return (string) env('OPENAI_API_KEY', '') !== '';
    }

    public function complete(string $systemPrompt, string $userPrompt, array $options = []): array
    {
        $key   = (string) env('OPENAI_API_KEY', '');
        $base  = rtrim((string) env('OPENAI_BASE_URL', 'https://api.openai.com/v1'), '/');
        $model = (string) ($options['model'] ?? env('OPENAI_MODEL', 'gpt-4o-mini'));

        $payload = [
            'model'    => $model,
            'messages' => [
                ['role' => 'system', 'content' => $systemPrompt],
                ['role' => 'user',   'content' => $userPrompt],
            ],
            'temperature' => $options['temperature'] ?? 0.2,
        ];
        if (! empty($options['expect_json'])) {
            $payload['response_format'] = ['type' => 'json_object'];
        }

        $res = $this->postJson(
            $base . '/chat/completions',
            [
                'Authorization' => 'Bearer ' . $key,
                'Content-Type'  => 'application/json',
            ],
            $payload,
        );

        $raw = (string) ($res['choices'][0]['message']['content'] ?? '');
        return [
            'provider'   => $this->name(),
            'model'      => $model,
            'raw'        => $raw,
            'output'     => $this->extractJson($raw) ?? $raw,
            'usage'      => $res['usage'] ?? [],
            'latency_ms' => (int) ($res['__latency_ms'] ?? 0),
            'sources'    => [],
        ];
    }
}
