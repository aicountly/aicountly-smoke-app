<?php

namespace App\Services\Brain\Adapters;

use GuzzleHttp\Client;
use GuzzleHttp\Exception\GuzzleException;
use RuntimeException;

abstract class AbstractAdapter implements BrainAdapterInterface
{
    protected ?Client $http = null;

    protected function client(): Client
    {
        if ($this->http === null) {
            $this->http = new Client([
                'timeout' => (int) env('BRAIN_TIMEOUT_SECONDS', 60),
                'http_errors' => false,
            ]);
        }
        return $this->http;
    }

    /**
     * Try to extract a JSON object/array from the model's textual reply. Models
     * sometimes wrap JSON in markdown fences -- we handle that, plus stray prose
     * before/after a top-level {}/[] block.
     */
    protected function extractJson(string $raw)
    {
        $text = trim($raw);
        if ($text === '') {
            return null;
        }
        // strip ```json ... ``` fences
        $text = (string) preg_replace('/^```(?:json)?\s*|\s*```$/m', '', $text);
        // First attempt: parse as-is
        $j = json_decode($text, true);
        if ($j !== null) {
            return $j;
        }
        // Second: locate first balanced JSON object/array
        $first = null;
        foreach (['{', '['] as $open) {
            $i = strpos($text, $open);
            if ($i !== false && ($first === null || $i < $first[0])) {
                $first = [$i, $open];
            }
        }
        if ($first === null) {
            return null;
        }
        $close = $first[1] === '{' ? '}' : ']';
        $last = strrpos($text, $close);
        if ($last === false || $last < $first[0]) {
            return null;
        }
        $candidate = substr($text, $first[0], $last - $first[0] + 1);
        $j = json_decode($candidate, true);
        return $j === null ? null : $j;
    }

    /**
     * @throws RuntimeException
     */
    protected function postJson(string $url, array $headers, array $body): array
    {
        try {
            $started = microtime(true);
            $res = $this->client()->post($url, [
                'headers' => $headers,
                'json'    => $body,
            ]);
            $latency = (int) ((microtime(true) - $started) * 1000);
            $code = $res->getStatusCode();
            $payload = (string) $res->getBody();
            if ($code < 200 || $code >= 300) {
                throw new RuntimeException(static::class . " HTTP {$code}: " . substr($payload, 0, 500));
            }
            $decoded = json_decode($payload, true);
            if (! is_array($decoded)) {
                throw new RuntimeException(static::class . ' non-JSON response');
            }
            $decoded['__latency_ms'] = $latency;
            return $decoded;
        } catch (GuzzleException $e) {
            throw new RuntimeException(static::class . ' transport error: ' . $e->getMessage(), 0, $e);
        }
    }
}
