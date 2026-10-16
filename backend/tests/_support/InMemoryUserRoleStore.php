<?php

namespace Tests\Support;

use App\Services\ConsoleAccess\UserRoleStore;

/**
 * In-memory UserRoleStore for unit tests of ConsoleRoleSyncService.
 */
final class InMemoryUserRoleStore implements UserRoleStore
{
    /** @var array<int, list<string>> */
    public array $roles = [];

    /** @var array<int, array{console_user_id:?int, authz_version:?int, roles_synced:bool}> */
    public array $links = [];

    /** @var list<int> */
    public array $revoked = [];

    public function roleSlugs(int $userId): array
    {
        return $this->roles[$userId] ?? [];
    }

    public function replaceRoles(int $userId, array $slugs): void
    {
        $this->roles[$userId] = array_values($slugs);
    }

    public function recordConsoleLink(int $userId, ?int $consoleUserId, ?int $authzVersion, bool $rolesSynced): void
    {
        $this->links[$userId] = [
            'console_user_id' => $consoleUserId,
            'authz_version'   => $authzVersion,
            'roles_synced'    => $rolesSynced,
        ];
    }

    public function revokeSessions(int $userId): void
    {
        $this->revoked[]      = $userId;
        $this->roles[$userId] = [];
    }
}
