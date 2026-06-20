<?php

namespace App\Controllers;

use CodeIgniter\HTTP\ResponseInterface;
use Config\Database;
use Config\Services;

class UsersController extends BaseController
{
    public function index(): ResponseInterface
    {
        $db = Database::connect();
        $rows = $db->table('smoke_users')
            ->select('id, email, full_name, status, must_rotate_pw, last_login_at, created_at')
            ->orderBy('created_at', 'DESC')
            ->get()
            ->getResultArray();

        $rbac = Services::rbac();
        foreach ($rows as &$row) {
            $row['roles'] = $rbac->rolesForUser((int) $row['id']);
        }
        return $this->jsonOk(['data' => $rows]);
    }

    public function create(): ResponseInterface
    {
        $body  = $this->jsonBody();
        $email = strtolower(trim((string) ($body['email'] ?? '')));
        $name  = trim((string) ($body['full_name'] ?? ''));
        $pw    = (string) ($body['password'] ?? '');
        $roleCodes = $body['roles'] ?? [];
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

        if (is_array($roleCodes)) {
            foreach ($roleCodes as $code) {
                $r = $db->table('smoke_roles')->where('code', $code)->get()->getRow();
                if ($r) {
                    $db->table('smoke_user_roles')->insert([
                        'user_id'     => $userId,
                        'role_id'     => $r->id,
                        'assigned_by' => $this->user()?->id,
                    ]);
                }
            }
        }
        Services::audit()->record('users.create', 'smoke_users', (string) $userId, $this->user()?->id, ['email' => $email]);
        return $this->jsonOk(['id' => $userId], 201);
    }

    public function update(int $id): ResponseInterface
    {
        $body = $this->jsonBody();
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

    public function assignRole(int $id): ResponseInterface
    {
        $body = $this->jsonBody();
        $code = (string) ($body['role'] ?? '');
        if ($code === '') {
            return $this->jsonError('invalid_request', 'role required', 400);
        }
        $db = Database::connect();
        $r  = $db->table('smoke_roles')->where('code', $code)->get()->getRow();
        if (! $r) {
            return $this->jsonError('not_found', 'Unknown role', 404);
        }
        $exists = $db->table('smoke_user_roles')->where('user_id', $id)->where('role_id', $r->id)->countAllResults();
        if ($exists === 0) {
            $db->table('smoke_user_roles')->insert([
                'user_id'     => $id,
                'role_id'     => $r->id,
                'assigned_by' => $this->user()?->id,
            ]);
        }
        Services::audit()->record('users.assign_role', 'smoke_users', (string) $id, $this->user()?->id, ['role' => $code]);
        return $this->jsonOk(['ok' => true]);
    }
}
