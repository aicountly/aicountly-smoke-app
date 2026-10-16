<?php

namespace App\Services\ConsoleAccess;

/**
 * Persistence used by ConsoleRoleSyncService. The production implementation is
 * DbUserRoleStore; tests use an in-memory fake.
 */
interface UserRoleStore
{
    /** @return list<string> role slugs the user holds locally */
    public function roleSlugs(int $userId): array;

    /** Replace the user's local roles with exactly these slugs. @param list<string> $slugs */
    public function replaceRoles(int $userId, array $slugs): void;

    /**
     * Remember the Console link. When $rolesSynced is true, roles_synced_at is
     * set to now (the roles were just confirmed by Console).
     */
    public function recordConsoleLink(int $userId, ?int $consoleUserId, ?int $authzVersion, bool $rolesSynced): void;

    /** End every local session (tokens issued before now) and drop local roles. */
    public function revokeSessions(int $userId): void;
}
