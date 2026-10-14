<?php

namespace App\Services\ConsoleAccess;

/**
 * Pure decision rules for Console-assigned roles. No I/O, so it is unit-tested
 * directly (tests/unit/ConsoleAccessPolicyTest.php).
 */
final class ConsoleAccessPolicy
{
    public const NOT_ASSIGNED_MESSAGE = 'Access not assigned. Ask a Console superadmin to assign you a role.';
    public const REVOKED_MESSAGE      = 'Your Console access to Smoke has been removed. Ask a Console superadmin to assign you a role.';
    public const STALE_MESSAGE        = 'Console could not be reached to confirm your Smoke access, and it was last confirmed more than 12 hours ago. Sign in again from console.aicountly.org once Console is reachable.';

    /** How long locally cached roles stay usable while Console is unreachable. */
    public const STALE_WINDOW_SECONDS = 12 * 3600;

    public function __construct(private readonly ConsoleRoleCatalog $catalog = new ConsoleRoleCatalog())
    {
    }

    public function catalog(): ConsoleRoleCatalog
    {
        return $this->catalog;
    }

    /**
     * Decide roles from an SSO exchange / introspect payload.
     *
     * @param array<string,mixed> $identity
     */
    public function forLogin(array $identity): AccessDecision
    {
        $superadmin    = ! empty($identity['app_superadmin']) || ! empty($identity['global_superadmin']);
        $consoleUserId = self::consoleUserId($identity);
        $authzVersion  = isset($identity['authz_version']) && is_numeric($identity['authz_version'])
            ? (int) $identity['authz_version']
            : null;

        if (! array_key_exists('app_roles', $identity)) {
            // Old Console (no app_roles yet): keep today's behaviour; the caller
            // only ever seeds the top role for a superadmin.
            return AccessDecision::grant(null, AccessDecision::SOURCE_LEGACY, $superadmin, $consoleUserId, $authzVersion);
        }

        $roles = $superadmin ? $this->catalog->all() : $this->catalog->normalize($identity['app_roles']);
        if ($roles === []) {
            return AccessDecision::deny(403, self::NOT_ASSIGNED_MESSAGE, true);
        }

        return AccessDecision::grant($roles, AccessDecision::SOURCE_CONSOLE, $superadmin, $consoleUserId, $authzVersion);
    }

    /**
     * Decide from the user-access pull endpoint's `data` (null = Console
     * unreachable or answered something unusable).
     *
     * @param array<string,mixed>|null $access
     */
    public function forRefresh(?array $access, ?int $rolesSyncedAt, int $now): AccessDecision
    {
        if ($access === null) {
            if ($rolesSyncedAt !== null && ($now - $rolesSyncedAt) <= self::STALE_WINDOW_SECONDS) {
                return AccessDecision::grant(null, AccessDecision::SOURCE_STALE);
            }

            return AccessDecision::deny(401, self::STALE_MESSAGE, false, AccessDecision::SOURCE_STALE);
        }

        $exists    = (bool) ($access['exists'] ?? false);
        $active    = (bool) ($access['active'] ?? false);
        $appAccess = (bool) ($access['app_access'] ?? false);
        if (! $exists || ! $active || ! $appAccess) {
            return AccessDecision::deny(403, self::REVOKED_MESSAGE, true);
        }

        $superadmin = ! empty($access['app_superadmin']);
        $roles      = $superadmin ? $this->catalog->all() : $this->catalog->normalize($access['app_roles'] ?? []);
        if ($roles === []) {
            return AccessDecision::deny(403, self::NOT_ASSIGNED_MESSAGE, true);
        }

        return AccessDecision::grant(
            $roles,
            AccessDecision::SOURCE_CONSOLE,
            $superadmin,
            isset($access['console_user_id']) && is_numeric($access['console_user_id']) ? (int) $access['console_user_id'] : null,
            isset($access['authz_version']) && is_numeric($access['authz_version']) ? (int) $access['authz_version'] : null,
        );
    }

    /**
     * @param array<string,mixed> $identity
     */
    private static function consoleUserId(array $identity): ?int
    {
        if (isset($identity['console_user_id']) && is_numeric($identity['console_user_id'])) {
            return (int) $identity['console_user_id'];
        }
        $user = is_array($identity['user'] ?? null) ? $identity['user'] : [];
        if (isset($user['id']) && is_numeric($user['id']) && (int) $user['id'] > 0) {
            return (int) $user['id'];
        }

        return null;
    }
}
