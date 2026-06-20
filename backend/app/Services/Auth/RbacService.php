<?php

namespace App\Services\Auth;

use Config\Database;

/**
 * Role lookup and helper checks for smoke users. Reads from smoke_user_roles
 * joined to smoke_roles.
 */
class RbacService
{
    /** @return string[] */
    public function rolesForUser(int $userId): array
    {
        $db = Database::connect();
        $rows = $db->table('smoke_user_roles ur')
            ->select('r.code')
            ->join('smoke_roles r', 'r.id = ur.role_id')
            ->where('ur.user_id', $userId)
            ->get()
            ->getResultArray();

        return array_values(array_map(static fn(array $r): string => (string) $r['code'], $rows));
    }

    /**
     * @param array<int,string> $userRoles
     * @param array<int,string> $allowed
     */
    public function hasAny(array $userRoles, array $allowed): bool
    {
        foreach ($allowed as $role) {
            if (in_array($role, $userRoles, true)) {
                return true;
            }
        }
        return false;
    }

    public function isOwner(array $userRoles): bool
    {
        return in_array('owner', $userRoles, true);
    }

    public function canApproveSessions(array $userRoles): bool
    {
        return $this->hasAny($userRoles, ['owner', 'product_reviewer']);
    }

    public function canRunObservations(array $userRoles): bool
    {
        return $this->hasAny($userRoles, ['owner', 'product_reviewer']);
    }

    public function canViewReports(array $userRoles): bool
    {
        return $this->hasAny($userRoles, ['owner', 'product_reviewer', 'developer_viewer', 'auditor_viewer']);
    }
}
