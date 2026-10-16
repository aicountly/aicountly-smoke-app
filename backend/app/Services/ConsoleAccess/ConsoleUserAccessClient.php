<?php

namespace App\Services\ConsoleAccess;

use Closure;

/**
 * Pulls a user's current Smoke access from Console:
 *
 *   GET {CONSOLE_API_URL}/portal/controller-apps/user-access?app_code=smoke&console_user_id=|email=
 *   Authorization: Bearer {CONSOLE_API_TOKEN}   (per-product key, capability staff.roles)
 *
 * fetch() returns the response `data` object, or null when Console is
 * unreachable / not configured / answered something we cannot trust. The
 * HTTP transport is injectable so tests never touch the network.
 */
class ConsoleUserAccessClient
{
    private string $baseUrl;
    private string $token;
    private string $appCode;
    private int $timeoutSeconds;

    /** @var Closure(string, list<string>, int): (array{status:int, body:string}|null) */
    private Closure $transport;

    /**
     * @param (callable(string, list<string>, int): (array{status:int, body:string}|null))|null $transport
     */
    public function __construct(
        ?string $baseUrl = null,
        ?string $token = null,
        ?string $appCode = null,
        ?callable $transport = null,
        int $timeoutSeconds = 5,
    ) {
        $this->baseUrl        = rtrim(trim((string) ($baseUrl ?? self::envBaseUrl())), '/');
        $this->token          = trim((string) ($token ?? env('CONSOLE_API_TOKEN', '')));
        $this->appCode        = strtolower(trim((string) ($appCode ?? env('CONTROLLER_APP_CODE', 'smoke'))));
        $this->timeoutSeconds = max(1, $timeoutSeconds);
        $this->transport      = $transport !== null ? Closure::fromCallable($transport) : Closure::fromCallable([self::class, 'curlGet']);
    }

    public function isConfigured(): bool
    {
        return $this->baseUrl !== '' && $this->token !== '' && $this->appCode !== '';
    }

    /**
     * @return array<string,mixed>|null
     */
    public function fetch(string $email, ?int $consoleUserId = null): ?array
    {
        if (! $this->isConfigured()) {
            return null;
        }

        $query = ['app_code' => $this->appCode];
        if ($consoleUserId !== null && $consoleUserId > 0) {
            $query['console_user_id'] = (string) $consoleUserId;
        } else {
            $email = strtolower(trim($email));
            if ($email === '') {
                return null;
            }
            $query['email'] = $email;
        }

        $url      = $this->baseUrl . '/portal/controller-apps/user-access?' . http_build_query($query);
        $response = ($this->transport)($url, [
            'Accept: application/json',
            'Authorization: Bearer ' . $this->token,
        ], $this->timeoutSeconds);

        if ($response === null) {
            self::log('Console user-access request failed (network).');

            return null;
        }

        $status = (int) ($response['status'] ?? 0);
        if ($status < 200 || $status >= 300) {
            self::log('Console user-access request failed HTTP ' . $status . '.');

            return null;
        }

        $decoded = json_decode((string) ($response['body'] ?? ''), true);
        if (! is_array($decoded) || empty($decoded['success']) || ! is_array($decoded['data'] ?? null)) {
            self::log('Console user-access returned an unexpected body.');

            return null;
        }

        $data = $decoded['data'];
        // A user Console does not know is a definitive answer ("revoked").
        if (array_key_exists('exists', $data) && ! $data['exists']) {
            return $data;
        }
        if (! array_key_exists('app_access', $data) || ! is_array($data['app_roles'] ?? null)) {
            self::log('Console user-access payload is missing app_access/app_roles.');

            return null;
        }

        return $data;
    }

    private static function envBaseUrl(): string
    {
        foreach ([env('CONSOLE_API_URL'), env('CONSOLE_API_BASE_URL')] as $value) {
            $value = trim((string) $value);
            if ($value !== '') {
                return $value;
            }
        }

        return '';
    }

    /**
     * @param list<string> $headers
     * @return array{status:int, body:string}|null
     */
    private static function curlGet(string $url, array $headers, int $timeout): ?array
    {
        $ch = curl_init($url);
        if ($ch === false) {
            return null;
        }
        curl_setopt_array($ch, [
            CURLOPT_HTTPGET        => true,
            CURLOPT_HTTPHEADER     => $headers,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => $timeout,
            CURLOPT_TIMEOUT        => $timeout,
        ]);
        $raw    = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($raw === false || $status === 0) {
            return null;
        }

        return ['status' => $status, 'body' => (string) $raw];
    }

    private static function log(string $message): void
    {
        if (function_exists('log_message')) {
            log_message('error', $message);
        }
    }
}
