<?php

namespace App\Controllers;

use CodeIgniter\HTTP\ResponseInterface;
use Config\Database;
use Config\Services;

class AuthController extends BaseController
{
    public function login(): ResponseInterface
    {
        $body  = $this->jsonBody();
        $email = strtolower(trim((string) ($body['email'] ?? '')));
        $pw    = (string) ($body['password'] ?? '');

        if ($email === '' || $pw === '') {
            return $this->jsonError('invalid_credentials', 'Email and password are required.', 400);
        }

        $db   = Database::connect();
        $user = $db->table('smoke_users')->where('email', $email)->get()->getRow();

        if ($user === null || $user->status !== 'active' || ! password_verify($pw, $user->password_hash)) {
            Services::audit()->record('auth.login.failed', 'smoke_users', $email, null, [
                'reason' => $user === null ? 'unknown_email' : ($user->status !== 'active' ? 'inactive' : 'bad_password'),
            ], $this->request->getIPAddress(), $this->request->getUserAgent()->getAgentString());
            return $this->jsonError('invalid_credentials', 'Email or password is incorrect.', 401);
        }

        $rbac  = Services::rbac();
        $roles = $rbac->rolesForUser((int) $user->id);

        $access  = Services::jwt()->issueAccess((int) $user->id, $user->email, $roles);
        $refresh = Services::jwt()->issueRefresh((int) $user->id);

        $db->table('smoke_users')->where('id', $user->id)->update([
            'last_login_at' => date('Y-m-d H:i:s'),
            'last_login_ip' => $this->request->getIPAddress(),
        ]);

        Services::audit()->record('auth.login.success', 'smoke_users', (string) $user->id, (int) $user->id, [
            'roles' => $roles,
        ], $this->request->getIPAddress(), $this->request->getUserAgent()->getAgentString());

        return $this->jsonOk([
            'access_token'  => $access,
            'refresh_token' => $refresh,
            'token_type'    => 'Bearer',
            'expires_in'    => (int) env('JWT_ACCESS_TTL', 86400),
            'user'          => [
                'id'             => (int) $user->id,
                'email'          => $user->email,
                'full_name'      => $user->full_name,
                'roles'          => $roles,
                'must_rotate_pw' => (bool) $user->must_rotate_pw,
            ],
        ]);
    }

    public function refresh(): ResponseInterface
    {
        $body = $this->jsonBody();
        $rt   = (string) ($body['refresh_token'] ?? '');
        if ($rt === '') {
            return $this->jsonError('invalid_request', 'refresh_token required', 400);
        }
        try {
            $payload = Services::jwt()->verifyRefresh($rt);
        } catch (\Throwable $e) {
            return $this->jsonError('invalid_token', $e->getMessage(), 401);
        }
        $userId = (int) ($payload->sub ?? 0);
        if ($userId <= 0) {
            return $this->jsonError('invalid_token', 'Bad subject', 401);
        }
        $db = Database::connect();
        $u  = $db->table('smoke_users')->where('id', $userId)->get()->getRow();
        if ($u === null || $u->status !== 'active') {
            return $this->jsonError('invalid_token', 'User not active', 401);
        }
        $roles  = Services::rbac()->rolesForUser($userId);
        $access = Services::jwt()->issueAccess($userId, $u->email, $roles);

        return $this->jsonOk([
            'access_token' => $access,
            'token_type'   => 'Bearer',
            'expires_in'   => (int) env('JWT_ACCESS_TTL', 86400),
        ]);
    }

    public function logout(): ResponseInterface
    {
        $u = $this->user();
        Services::audit()->record('auth.logout', 'smoke_users', $u ? (string) $u->id : null, $u?->id);
        return $this->jsonOk(['ok' => true]);
    }

    public function me(): ResponseInterface
    {
        $u = $this->user();
        if (! $u) {
            return $this->jsonError('unauthorized', 'No session', 401);
        }
        $db = Database::connect();
        $row = $db->table('smoke_users')->where('id', $u->id)->get()->getRow();
        if (! $row) {
            return $this->jsonError('not_found', 'User no longer exists', 404);
        }
        return $this->jsonOk([
            'id'             => (int) $row->id,
            'email'          => $row->email,
            'full_name'      => $row->full_name,
            'roles'          => Services::rbac()->rolesForUser((int) $row->id),
            'status'         => $row->status,
            'must_rotate_pw' => (bool) $row->must_rotate_pw,
            'last_login_at'  => $row->last_login_at,
        ]);
    }

    public function changePassword(): ResponseInterface
    {
        $u = $this->user();
        if (! $u) {
            return $this->jsonError('unauthorized', 'No session', 401);
        }
        $body = $this->jsonBody();
        $cur  = (string) ($body['current_password'] ?? '');
        $new  = (string) ($body['new_password'] ?? '');
        if (strlen($new) < 12) {
            return $this->jsonError('weak_password', 'New password must be at least 12 characters.', 400);
        }
        $db = Database::connect();
        $row = $db->table('smoke_users')->where('id', $u->id)->get()->getRow();
        if (! $row || ! password_verify($cur, $row->password_hash)) {
            return $this->jsonError('invalid_credentials', 'Current password incorrect.', 401);
        }
        $db->table('smoke_users')->where('id', $u->id)->update([
            'password_hash'  => password_hash($new, PASSWORD_BCRYPT),
            'must_rotate_pw' => false,
            'updated_at'     => date('Y-m-d H:i:s'),
        ]);
        Services::audit()->record('auth.change_password', 'smoke_users', (string) $u->id, (int) $u->id);
        return $this->jsonOk(['ok' => true]);
    }
}
