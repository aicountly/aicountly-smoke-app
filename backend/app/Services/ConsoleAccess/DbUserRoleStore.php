<?php

namespace App\Services\ConsoleAccess;

use CodeIgniter\Database\BaseConnection;
use Config\Database;

/**
 * smoke_users / smoke_roles / smoke_user_roles implementation of
 * UserRoleStore. Console slugs are matched on smoke_roles.code.
 */
class DbUserRoleStore implements UserRoleStore
{
    public function __construct(private ?BaseConnection $db = null)
    {
    }

    private function db(): BaseConnection
    {
        return $this->db ??= Database::connect();
    }

    public function roleSlugs(int $userId): array
    {
        $rows = $this->db()->table('smoke_user_roles ur')
            ->select('r.code')
            ->join('smoke_roles r', 'r.id = ur.role_id')
            ->where('ur.user_id', $userId)
            ->orderBy('r.id')
            ->get()->getResultArray();

        return array_values(array_map(static fn (array $r): string => (string) $r['code'], $rows));
    }

    public function replaceRoles(int $userId, array $slugs): void
    {
        $db    = $this->db();
        $roles = $slugs === []
            ? []
            : $db->table('smoke_roles')->select('id, code')->whereIn('code', $slugs)->get()->getResultArray();

        if (count($roles) !== count(array_unique($slugs))) {
            log_message('error', 'Console role sync: some role slugs have no smoke_roles row: ' . implode(',', $slugs));
        }

        $db->transStart();
        $db->table('smoke_user_roles')->where('user_id', $userId)->delete();
        foreach ($roles as $role) {
            $db->table('smoke_user_roles')->insert([
                'user_id'     => $userId,
                'role_id'     => (int) $role['id'],
                'assigned_at' => date('Y-m-d H:i:s'),
                'assigned_by' => null,
            ]);
        }
        $db->transComplete();
    }

    public function recordConsoleLink(int $userId, ?int $consoleUserId, ?int $authzVersion, bool $rolesSynced): void
    {
        $patch = [];
        if ($consoleUserId !== null && $consoleUserId > 0) {
            $patch['console_user_id'] = $consoleUserId;
        }
        if ($authzVersion !== null) {
            $patch['authz_version'] = $authzVersion;
        }
        if ($rolesSynced) {
            $patch['roles_synced_at'] = date('Y-m-d H:i:s');
        }
        if ($patch === []) {
            return;
        }
        $patch['updated_at'] = date('Y-m-d H:i:s');
        $this->db()->table('smoke_users')->where('id', $userId)->update($patch);
    }

    public function revokeSessions(int $userId): void
    {
        $db = $this->db();
        $db->transStart();
        $db->table('smoke_user_roles')->where('user_id', $userId)->delete();
        $db->table('smoke_users')->where('id', $userId)->update([
            'sessions_revoked_at' => date('Y-m-d H:i:s'),
            'roles_synced_at'     => null,
            'updated_at'          => date('Y-m-d H:i:s'),
        ]);
        $db->transComplete();
    }
}
