<?php

namespace App\Filters;

use CodeIgniter\Filters\FilterInterface;
use CodeIgniter\HTTP\RequestInterface;
use CodeIgniter\HTTP\ResponseInterface;
use Config\Services;

/**
 * Records every mutating API request to smoke_audit_logs after the response is
 * known. We only log: POST/PUT/DELETE/PATCH on /api/v1/* paths, with the
 * authenticated user (if any), status code, and a redacted payload.
 */
class AuditFilter implements FilterInterface
{
    private const REDACT_FIELDS = ['password', 'password_hash', 'secret', 'token', 'api_key', 'plaintext'];
    private const MUTATING      = ['POST', 'PUT', 'PATCH', 'DELETE'];

    public function before(RequestInterface $request, $arguments = null)
    {
        // no-op
    }

    public function after(RequestInterface $request, ResponseInterface $response, $arguments = null)
    {
        try {
            $method = strtoupper($request->getMethod());
            $uri    = (string) $request->getUri();

            if (! in_array($method, self::MUTATING, true)) {
                return;
            }
            if (strpos($uri, '/api/v1/') === false) {
                return;
            }

            $user      = $request->user ?? null;
            $userId    = is_object($user) ? ($user->id ?? null) : null;
            $payload   = $this->redact($request->getJSON(true) ?? $request->getPost());
            $entity    = $this->guessEntity($uri);

            Services::audit()->record(
                action: $method . ' ' . parse_url($uri, PHP_URL_PATH),
                entity: $entity,
                entityId: null,
                userId: $userId,
                payload: [
                    'status'  => $response->getStatusCode(),
                    'request' => $payload,
                ],
                ip: $request->getIPAddress(),
                userAgent: $request->getUserAgent()->getAgentString(),
            );
        } catch (\Throwable $e) {
            // Audit must never block the response.
            log_message('error', 'AuditFilter failure: ' . $e->getMessage());
        }
    }

    private function redact($payload)
    {
        if (! is_array($payload)) {
            return $payload;
        }
        $out = [];
        foreach ($payload as $k => $v) {
            $key = strtolower((string) $k);
            if (in_array($key, self::REDACT_FIELDS, true)) {
                $out[$k] = '[REDACTED]';
                continue;
            }
            $out[$k] = is_array($v) ? $this->redact($v) : $v;
        }
        return $out;
    }

    private function guessEntity(string $uri): ?string
    {
        $path = parse_url($uri, PHP_URL_PATH) ?: '';
        $segments = array_values(array_filter(explode('/', $path)));
        // /api/v1/<entity>/...
        return $segments[2] ?? null;
    }
}
