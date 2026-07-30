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

        $userContent = $userPrompt;
        if (! empty($options['images']) && is_array($options['images'])) {
            $userContent = [['type' => 'text', 'text' => $userPrompt]];
            foreach ($options['images'] as $image) {
                if (! is_array($image) || trim((string) ($image['data'] ?? '')) === '') {
                    continue;
                }
                $mime = trim((string) ($image['mime_type'] ?? 'image/jpeg')) ?: 'image/jpeg';
                $userContent[] = [
                    'type' => 'image_url',
                    'image_url' => ['url' => 'data:' . $mime . ';base64,' . $image['data']],
                ];
            }
        }

        $payload = [
            'model'    => $model,
            'messages' => [
                ['role' => 'system', 'content' => $systemPrompt],
                ['role' => 'user',   'content' => $userContent],
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
            isset($options['timeout']) ? (int) $options['timeout'] : null,
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
