<?php

namespace App\Controllers;

use CodeIgniter\HTTP\ResponseInterface;
use Config\Database;
use Config\Services;

/**
 * Local Smoke user listing and deactivation. Roles are NOT editable here:
 * Console assigns them (Console -> Roles & Access) and they are synced at
 * sign-in and on every token refresh (see ConsoleRoleSyncService).
 */
class UsersController extends BaseController
{
    public const ROLES_READ_ONLY_MESSAGE = 'Roles are assigned in Console → Roles & Access (https://console.aicountly.org).';
    public function index(): ResponseInterface
    {
        $db = Database::connect();
        $rows = $db->table('smoke_users')
            ->select('id, email, full_name, status, must_rotate_pw, last_login_at, created_at, console_user_id, roles_synced_at')
            ->orderBy('created_at', 'DESC')
            ->get()
            ->getResultArray();

        $rbac = Services::rbac();
        foreach ($rows as &$row) {
            $row['roles'] = $rbac->rolesForUser((int) $row['id']);
        }
        return $this->jsonOk([
            'data'             => $rows,
            'roles_managed_by' => 'console',
            'roles_note'       => self::ROLES_READ_ONLY_MESSAGE,
        ]);
    }

    public function create(): ResponseInterface
    {
        $body  = $this->jsonBody();
        $email = strtolower(trim((string) ($body['email'] ?? '')));
        $name  = trim((string) ($body['full_name'] ?? ''));
        $pw    = (string) ($body['password'] ?? '');
        if (array_key_exists('roles', $body)) {
            return $this->jsonError('roles_managed_by_console', self::ROLES_READ_ONLY_MESSAGE, 403);
        }
        if ($email === '' || $name === '' || strlen($pw) < 12) {
            return $this->jsonError('invalid_request', 'email, full_name and password (>=12 chars) required', 400);
        }
        $db = Database::connect();
        if ($db->table('smoke_users')->where('email', $email)->countAllResults() > 0) {
            return $this->jsonError('conflict', 'Email already exists', 409);
        }
        $db->table('smoke_users')->insert([
            'email'         => $email,
            'password_hash' => password_hash($pw, PASSWORD_BCRYPT),
            'full_name'     => $name,
            'status'        => 'active',
            'must_rotate_pw'=> true,
        ]);
        $userId = (int) $db->insertID();

        Services::audit()->record('users.create', 'smoke_users', (string) $userId, $this->user()?->id, ['email' => $email]);
        return $this->jsonOk(['id' => $userId], 201);
    }

    public function update(int $id): ResponseInterface
    {
        $body = $this->jsonBody();
        if (array_key_exists('roles', $body)) {
            return $this->jsonError('roles_managed_by_console', self::ROLES_READ_ONLY_MESSAGE, 403);
        }
        $patch = array_filter([
            'full_name' => $body['full_name'] ?? null,
            'status'    => $body['status'] ?? null,
        ], static fn($v) => $v !== null);
        if (! empty($body['new_password']) && strlen((string) $body['new_password']) >= 12) {
            $patch['password_hash'] = password_hash((string) $body['new_password'], PASSWORD_BCRYPT);
            $patch['must_rotate_pw'] = false;
        }
        if ($patch === []) {
            return $this->jsonError('invalid_request', 'No updatable fields supplied', 400);
        }
        $patch['updated_at'] = date('Y-m-d H:i:s');
        Database::connect()->table('smoke_users')->where('id', $id)->update($patch);
        Services::audit()->record('users.update', 'smoke_users', (string) $id, $this->user()?->id, ['fields' => array_keys($patch)]);
        return $this->jsonOk(['ok' => true]);
    }

    public function delete(int $id): ResponseInterface
    {
        Database::connect()->table('smoke_users')->where('id', $id)->update(['status' => 'disabled']);
        Services::audit()->record('users.delete', 'smoke_users', (string) $id, $this->user()?->id);
        return $this->jsonOk(['ok' => true]);
    }

    /**
     * POST /users/{id}/roles — kept so old clients get a clear answer.
     */
    public function assignRole(int $id): ResponseInterface
    {
        return $this->jsonError('roles_managed_by_console', self::ROLES_READ_ONLY_MESSAGE, 403);
    }
}
