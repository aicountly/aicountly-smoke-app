<?php

namespace App\Services\ConsoleAccess;

use Closure;
use CodeIgniter\Cache\CacheInterface;

/**
 * Keeps local Smoke roles equal to what Console assigns.
 *
 *  - Login (SSO exchange / introspect): decideLogin() + applyLogin().
 *  - Token refresh and the periodic re-check in JwtFilter: checkAccess(),
 *    which pulls /portal/controller-apps/user-access when CONSOLE_API_URL +
 *    CONSOLE_API_TOKEN are configured.
 */
class ConsoleRoleSyncService
{
    public const UNREACHABLE_CACHE_KEY = 'smoke_console_user_access_unreachable';

    private ConsoleAccessPolicy $policy;

    /** @var Closure(): int */
    private Closure $clock;

    public function __construct(
        private readonly UserRoleStore $store,
        private readonly ConsoleUserAccessClient $client,
        ?ConsoleAccessPolicy $policy = null,
        private readonly ?CacheInterface $cache = null,
        ?callable $clock = null,
        private readonly int $recheckSeconds = 900,
        private readonly int $unreachableBackoffSeconds = 60,
    ) {
        $this->policy = $policy ?? new ConsoleAccessPolicy();
        $this->clock  = $clock !== null ? Closure::fromCallable($clock) : static fn (): int => time();
    }

    public function isPullConfigured(): bool
    {
        return $this->client->isConfigured();
    }

    /**
     * @param array<string,mixed> $identity SSO exchange / introspect `data`
     */
    public function decideLogin(array $identity): AccessDecision
    {
        return $this->policy->forLogin($identity);
    }

    /**
     * Apply an allowed login decision to a (possibly just created) local user.
     *
     * @return list<string> role slugs the user now holds
     */
    public function applyLogin(int $userId, AccessDecision $decision): array
    {
        if (! $decision->allowed) {
            $this->store->revokeSessions($userId);

            return [];
        }

        if ($decision->roles !== null) {
            $this->store->replaceRoles($userId, $decision->roles);
            $this->store->recordConsoleLink($userId, $decision->consoleUserId, $decision->authzVersion, true);

            return $this->store->roleSlugs($userId);
        }

        // Old Console payload without app_roles: keep existing roles; a user
        // with none gets the old default. Only a superadmin is ever seeded with
        // the top role.
        if ($this->store->roleSlugs($userId) === []) {
            $catalog = $this->policy->catalog();
            $this->store->replaceRoles($userId, [$decision->superadmin ? $catalog->owner() : $catalog->legacyDefault()]);
        }
        $this->store->recordConsoleLink($userId, $decision->consoleUserId, $decision->authzVersion, false);

        return $this->store->roleSlugs($userId);
    }

    public function revokeLocalAccess(int $userId): void
    {
        $this->store->revokeSessions($userId);
    }

    /**
     * Re-confirm a user's access with Console and apply the answer.
     *
     * $force = true (token refresh, scheduled sweep) always asks Console;
     * $force = false only asks once roles_synced_at is
     * older than the re-check interval.
     *
     * @param array<string,mixed> $user smoke_users row: id, email, console_user_id, roles_synced_at
     */
    public function checkAccess(array $user, bool $force = true): AccessDecision
    {
        $userId = (int) ($user['id'] ?? 0);
        $now    = ($this->clock)();
        $synced = self::timestamp($user['roles_synced_at'] ?? null);

        if (! $this->client->isConfigured()) {
            if ($force) {
                self::log('warning', 'CONSOLE_API_URL/CONSOLE_API_TOKEN not configured: Smoke roles are not re-checked with Console on refresh. Configure both in production.');
            }

            return AccessDecision::grant(null, AccessDecision::SOURCE_UNCONFIGURED);
        }

        if (! $force && $synced !== null && ($now - $synced) < $this->recheckSeconds) {
            return AccessDecision::grant(null, AccessDecision::SOURCE_FRESH);
        }

        $access = null;
        if (! $this->recentlyUnreachable()) {
            $consoleUserId = isset($user['console_user_id']) && is_numeric($user['console_user_id']) ? (int) $user['console_user_id'] : null;
            $access        = $this->client->fetch((string) ($user['email'] ?? ''), $consoleUserId);
            if ($access === null) {
                $this->cache?->save(self::UNREACHABLE_CACHE_KEY, $now, $this->unreachableBackoffSeconds);
            }
        }

        $decision = $this->policy->forRefresh($access, $synced, $now);

        if (! $decision->allowed) {
            if ($decision->revoke && $userId > 0) {
                $this->store->revokeSessions($userId);
            }

            return $decision;
        }

        if ($decision->roles !== null && $userId > 0) {
            $this->store->replaceRoles($userId, $decision->roles);
            $this->store->recordConsoleLink($userId, $decision->consoleUserId, $decision->authzVersion, true);
        }

        return $decision;
    }

    /**
     * True when the token was issued before (or in the same second as) the
     * user's sessions were revoked — iat has one-second resolution.
     *
     * @param array<string,mixed> $user
     */
    public static function sessionRevoked(array $user, int $issuedAt): bool
    {
        $revokedAt = self::timestamp($user['sessions_revoked_at'] ?? null);

        return $revokedAt !== null && $issuedAt <= $revokedAt;
    }

    private function recentlyUnreachable(): bool
    {
        return $this->cache !== null && $this->cache->get(self::UNREACHABLE_CACHE_KEY) !== null;
    }

    private static function timestamp(mixed $value): ?int
    {
        if ($value === null || $value === '') {
            return null;
        }
        if (is_int($value)) {
            return $value;
        }
        $ts = strtotime((string) $value);

        return $ts === false ? null : $ts;
    }

    private static function log(string $level, string $message): void
    {
        if (function_exists('log_message')) {
            log_message($level, $message);
        }
    }
}
