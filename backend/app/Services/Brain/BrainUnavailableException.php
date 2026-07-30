<?php

namespace App\Services\Brain;

use RuntimeException;
use Throwable;

class BrainUnavailableException extends RuntimeException
{
    public function __construct(
        public readonly string $provider,
        public readonly int $httpStatus,
        public readonly string $responseSnippet,
        ?Throwable $previous = null,
    ) {
        parent::__construct(
            "Brain provider {$provider} unavailable"
            . ($httpStatus > 0 ? " (HTTP {$httpStatus})" : '')
            . ($responseSnippet !== '' ? ': ' . $responseSnippet : ''),
            $httpStatus,
            $previous,
        );
    }

    public static function fromThrowable(string $provider, Throwable $error): self
    {
        $message = $error->getMessage();
        $status = preg_match('/\bHTTP\s+(\d{3})\b/i', $message, $match) ? (int) $match[1] : 0;
        return new self($provider, $status, mb_substr($message, 0, 500), $error);
    }
}
