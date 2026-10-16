<?php

namespace App\Services\Auth;

use Firebase\JWT\JWT;
use Firebase\JWT\Key;
use RuntimeException;
use stdClass;

/**
 * Minimal JWT issuance + verification for the smoke portal. HS256 with a
 * single secret (JWT_SECRET). Access tokens carry user id, email and role
 * codes; refresh tokens only carry user id and a token type marker.
 *
 * Access tokens are capped at 15 minutes (MAX_ACCESS_TTL) whatever
 * JWT_ACCESS_TTL says: roles come from Console and are re-confirmed on every
 * refresh, so the access TTL is the upper bound on how long a role removed in
 * Console stays effective.
 */
class JwtService
{
    public const MAX_ACCESS_TTL = 900;

    private string $secret;
    private string $issuer;
    private int $accessTtl;
    private int $refreshTtl;

    public function __construct()
    {
        $this->secret     = (string) env('JWT_SECRET', '');
        $this->issuer     = (string) env('JWT_ISSUER', 'smoke.aicountly.org');
        $this->accessTtl  = max(60, min(self::MAX_ACCESS_TTL, (int) env('JWT_ACCESS_TTL', self::MAX_ACCESS_TTL)));
        $this->refreshTtl = (int) env('JWT_REFRESH_TTL', 2592000);
        if ($this->secret === '' || strlen($this->secret) < 32) {
            throw new RuntimeException('JWT_SECRET must be set to a strong random string (>=32 chars).');
        }
    }

    public function accessTtl(): int
    {
        return $this->accessTtl;
    }

    /**
     * @param array<int,string> $roles
     */
    public function issueAccess(int $userId, string $email, array $roles): string
    {
        $now = time();
        return JWT::encode([
            'iss'   => $this->issuer,
            'sub'   => $userId,
            'email' => $email,
            'roles' => array_values(array_map('strval', $roles)),
            'typ'   => 'access',
            'iat'   => $now,
            'nbf'   => $now,
            'exp'   => $now + $this->accessTtl,
        ], $this->secret, 'HS256');
    }

    public function issueRefresh(int $userId): string
    {
        $now = time();
        return JWT::encode([
            'iss' => $this->issuer,
            'sub' => $userId,
            'typ' => 'refresh',
            'iat' => $now,
            'nbf' => $now,
            'exp' => $now + $this->refreshTtl,
        ], $this->secret, 'HS256');
    }

    public function verifyAccess(string $token): stdClass
    {
        $payload = JWT::decode($token, new Key($this->secret, 'HS256'));
        if (! isset($payload->typ) || $payload->typ !== 'access') {
            throw new RuntimeException('Wrong token type: expected access');
        }
        return $payload;
    }

    public function verifyRefresh(string $token): stdClass
    {
        $payload = JWT::decode($token, new Key($this->secret, 'HS256'));
        if (! isset($payload->typ) || $payload->typ !== 'refresh') {
            throw new RuntimeException('Wrong token type: expected refresh');
        }
        return $payload;
    }
}
