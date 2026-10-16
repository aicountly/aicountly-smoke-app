<?php

namespace App\Services\ConsoleAccess;

/**
 * Outcome of a Console access check (login or refresh).
 *
 * - allowed=false: refuse with $status / $message; $revoke asks the caller to
 *   end every local session of the user and drop their local roles.
 * - allowed=true, roles !== null: replace the user's local roles with exactly
 *   these slugs (Console is authoritative).
 * - allowed=true, roles === null: keep local roles as they are (old Console
 *   payload, pull endpoint not configured, or Console briefly unreachable).
 */
final class AccessDecision
{
    public const SOURCE_CONSOLE      = 'console';
    public const SOURCE_LEGACY       = 'legacy_payload';
    public const SOURCE_STALE        = 'console_unreachable_cached';
    public const SOURCE_UNCONFIGURED = 'pull_unconfigured';
    public const SOURCE_FRESH        = 'recently_synced';

    /**
     * @param list<string>|null $roles
     */
    private function __construct(
        public readonly bool $allowed,
        public readonly int $status,
        public readonly string $message,
        public readonly ?array $roles,
        public readonly string $source,
        public readonly bool $revoke = false,
        public readonly bool $superadmin = false,
        public readonly ?int $consoleUserId = null,
        public readonly ?int $authzVersion = null,
    ) {
    }

    /**
     * @param list<string>|null $roles
     */
    public static function grant(
        ?array $roles,
        string $source,
        bool $superadmin = false,
        ?int $consoleUserId = null,
        ?int $authzVersion = null,
    ): self {
        return new self(true, 200, '', $roles, $source, false, $superadmin, $consoleUserId, $authzVersion);
    }

    public static function deny(int $status, string $message, bool $revoke = false, string $source = self::SOURCE_CONSOLE): self
    {
        return new self(false, $status, $message, null, $source, $revoke);
    }
}
