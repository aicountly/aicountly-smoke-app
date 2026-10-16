<?php

namespace Tests\Support;

/**
 * Records requests and replays a canned response for ConsoleUserAccessClient.
 * A null response simulates Console being unreachable.
 */
final class StubConsoleTransport
{
    /** @var list<array{url:string, headers:list<string>}> */
    public array $calls = [];

    /** @param array{status:int, body:string}|null $response */
    public function __construct(public ?array $response = null)
    {
    }

    /** @param array<string,mixed> $data */
    public static function ok(array $data): self
    {
        return new self(['status' => 200, 'body' => json_encode(['success' => true, 'data' => $data])]);
    }

    public static function down(): self
    {
        return new self(null);
    }

    /**
     * @param list<string> $headers
     * @return array{status:int, body:string}|null
     */
    public function __invoke(string $url, array $headers, int $timeout): ?array
    {
        $this->calls[] = ['url' => $url, 'headers' => $headers];

        return $this->response;
    }
}
