<?php

namespace App\Controllers;

use App\Services\ConsoleIdentityService;
use CodeIgniter\HTTP\ResponseInterface;
use Config\Database;
use Config\Services;
use RuntimeException;
use Throwable;

class AuthController extends BaseController
{
    private const AUTH_STORAGE_KEY = 'smoke.auth';

    public function login(): ResponseInterface
    {
        return $this->jsonError(
            'login_disabled',
            'Local login is disabled. Sign in at console.aicountly.org and open Smoke from Top Controller Apps.',
            403,
        );
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

    /**
     * GET /v1/auth/sso-callback?token= — browser redirect from Console (no SPA JS required).
     */
    public function ssoCallback(): ResponseInterface
    {
        try {
            if ($fail = $this->ensureJwtConfigured()) {
                return $this->ssoCallbackHtml('Smoke Portal is not configured for Console SSO yet.', 503);
            }

            $token = trim((string) ($this->request->getGet('token') ?? ''));
            if ($token === '') {
                return $this->ssoCallbackHtml('Missing SSO token. Open Smoke again from Console Top Controller Apps.', 400);
            }

            $identity = Services::consoleIdentity()->exchangeLaunchToken($token);
            if ($identity === null) {
                return $this->ssoCallbackHtml(
                    'This sign-in link expired. Go back to Console and click Smoke again.',
                    401,
                );
            }

            $session = $this->buildSessionFromConsoleIdentity($identity, 'controller_sso_callback');
            if ($session instanceof ResponseInterface) {
                $message = 'You do not have access to the Smoke controller app.';
                $json    = json_decode($session->getBody(), true);
                if (is_array($json) && ! empty($json['message'])) {
                    $message = (string) $json['message'];
                }

                return $this->ssoCallbackHtml($message, 403);
            }

            return $this->completeSsoInBrowser($session);
        } catch (Throwable $e) {
            log_message('error', 'SSO callback failed: ' . $e->getMessage());

            return $this->ssoCallbackHtml('Console SSO sign-in failed. Try again from Console.', 500);
        }
    }

    /**
     * Exchange a Console controller SSO launch token for a Smoke session.
     */
    public function controllerSso(): ResponseInterface
    {
        try {
            if ($fail = $this->ensureJwtConfigured()) {
                return $fail;
            }

            $body  = $this->jsonBody();
            $token = trim((string) ($body['token'] ?? ''));
            if ($token === '') {
                return $this->jsonError('invalid_request', 'token required.', 400);
            }

            $identity = Services::consoleIdentity()->exchangeLaunchToken($token);
            if ($identity === null) {
                return $this->jsonError('invalid_token', 'Invalid or expired Console SSO token.', 401);
            }

            $session = $this->buildSessionFromConsoleIdentity($identity, 'controller_sso_login');
            if ($session instanceof ResponseInterface) {
                return $session;
            }

            return $this->jsonOk($session);
        } catch (Throwable $e) {
            log_message('error', 'Controller SSO failed: ' . $e->getMessage());

            return $this->jsonError('sso_failed', 'Controller SSO login failed.', 500);
        }
    }

    /**
     * Sign in using the shared Console cookie (direct visit to smoke.aicountly.org).
     */
    public function consoleSession(): ResponseInterface
    {
        try {
            if ($fail = $this->ensureJwtConfigured()) {
                return $fail;
            }

            $consoleToken = trim((string) ($this->request->getCookie(ConsoleIdentityService::cookieName()) ?? ''));
            if ($consoleToken === '') {
                return $this->jsonError('console_required', 'Sign in to Console first.', 401);
            }

            $identity = Services::consoleIdentity()->introspectSession($consoleToken);
            if ($identity === null) {
                return $this->jsonError('invalid_token', 'Console session is invalid or expired. Sign in again at Console.', 401);
            }

            $session = $this->buildSessionFromConsoleIdentity($identity, 'console_session_login');
            if ($session instanceof ResponseInterface) {
                return $session;
            }

            return $this->jsonOk($session);
        } catch (Throwable $e) {
            log_message('error', 'Console session login failed: ' . $e->getMessage());

            return $this->jsonError('sso_failed', 'Console session login failed.', 500);
        }
    }

    /**
     * @param array<string,mixed> $identity
     * @return array<string,mixed>|ResponseInterface
     */
    private function buildSessionFromConsoleIdentity(array $identity, string $auditEvent): array|ResponseInterface
    {
        $active = (bool) ($identity['active'] ?? false);
        $global = (bool) ($identity['global_superadmin'] ?? false);
        if (! $active && ! $global) {
            return $this->jsonError('no_access', 'You do not have access to the Smoke controller app.', 403);
        }

        $consoleUser = is_array($identity['user'] ?? null) ? $identity['user'] : [];
        $email       = strtolower(trim((string) ($consoleUser['email'] ?? '')));
        $name        = trim((string) ($consoleUser['name'] ?? ''));
        if ($email === '') {
            return $this->jsonError('bad_identity', 'Console identity did not return a user email.', 502);
        }

        $db   = Database::connect();
        $user = $db->table('smoke_users')->where('email', $email)->get()->getRow();

        if (! $user) {
            $db->table('smoke_users')->insert([
                'email'          => $email,
                'password_hash'  => password_hash(bin2hex(random_bytes(16)), PASSWORD_BCRYPT),
                'full_name'      => $name !== '' ? $name : $email,
                'status'         => 'active',
                'must_rotate_pw' => false,
            ]);
            $userId = (int) $db->insertID();
            if ($userId <= 0) {
                return $this->jsonError('provision_failed', 'Could not provision Smoke user from Console identity.', 500);
            }

            $this->assignRoleByCode($userId, $global ? 'owner' : 'developer_viewer');
            $user = $db->table('smoke_users')->where('id', $userId)->get()->getRow();
        } elseif ($user->status !== 'active') {
            return $this->jsonError('inactive_user', 'Smoke user account is inactive.', 403);
        }

        $roles = Services::rbac()->rolesForUser((int) $user->id);
        if ($roles === [] && $global) {
            $this->assignRoleByCode((int) $user->id, 'owner');
            $roles = Services::rbac()->rolesForUser((int) $user->id);
        }

        try {
            $access  = Services::jwt()->issueAccess((int) $user->id, $user->email, $roles);
            $refresh = Services::jwt()->issueRefresh((int) $user->id);
        } catch (RuntimeException $e) {
            return $this->jsonError('misconfigured', $e->getMessage(), 503);
        }

        $db->table('smoke_users')->where('id', $user->id)->update([
            'last_login_at' => date('Y-m-d H:i:s'),
            'last_login_ip' => $this->request->getIPAddress(),
        ]);

        Services::audit()->record($auditEvent, 'smoke_users', (string) $user->id, (int) $user->id, [
            'console_user_id'   => (int) ($consoleUser['id'] ?? 0),
            'global_superadmin' => $global,
            'roles'             => $roles,
        ], $this->request->getIPAddress(), $this->request->getUserAgent()->getAgentString());

        return [
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
        ];
    }

    /**
     * @param array<string,mixed> $session
     */
    private function completeSsoInBrowser(array $session): ResponseInterface
    {
        $persist = [
            'state' => [
                'accessToken'  => (string) $session['access_token'],
                'refreshToken' => (string) $session['refresh_token'],
                'user'         => $session['user'],
            ],
            'version' => 0,
        ];

        $persistJson = json_encode($persist, JSON_THROW_ON_ERROR | JSON_HEX_TAG | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_HEX_AMP);
        $storageKey  = json_encode(self::AUTH_STORAGE_KEY, JSON_THROW_ON_ERROR | JSON_HEX_TAG | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_HEX_AMP);
        $html = <<<HTML
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Signing in to Smoke Portal…</title>
  <style>
    body { font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; color: #334155; }
  </style>
</head>
<body>
  <p>Signing you in to Smoke Portal…</p>
  <script>
    try {
      localStorage.setItem({$storageKey}, {$persistJson});
    } catch (e) {}
    location.replace('/');
  </script>
</body>
</html>
HTML;

        return $this->response
            ->setStatusCode(200)
            ->setContentType('text/html')
            ->setBody($html);
    }

    private function ssoCallbackHtml(string $message, int $status = 400): ResponseInterface
    {
        $safeMessage = htmlspecialchars($message, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
        $consoleUrl  = 'https://console.aicountly.org';
        $html = <<<HTML
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Smoke sign-in failed</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 420px; margin: 48px auto; padding: 0 16px; color: #334155; }
    .box { border: 1px solid #fecaca; background: #fef2f2; border-radius: 12px; padding: 16px; }
    a { color: #047857; }
  </style>
</head>
<body>
  <div class="box">
    <h1 style="font-size:18px;margin:0 0 8px;">Smoke sign-in failed</h1>
    <p style="margin:0 0 12px;">{$safeMessage}</p>
    <p style="margin:0;"><a href="{$consoleUrl}">Return to Console</a></p>
  </div>
</body>
</html>
HTML;

        return $this->response
            ->setStatusCode($status)
            ->setContentType('text/html')
            ->setBody($html);
    }

    private function ensureJwtConfigured(): ?ResponseInterface
    {
        $jwtSecret = (string) env('JWT_SECRET', '');
        if ($jwtSecret === '' || strlen($jwtSecret) < 32) {
            return $this->jsonError(
                'misconfigured',
                'Server misconfigured: set JWT_SECRET (32+ chars) in backend/.env',
                503,
            );
        }

        return null;
    }

    private function assignRoleByCode(int $userId, string $roleCode): void
    {
        $db   = Database::connect();
        $role = $db->table('smoke_roles')->where('code', $roleCode)->get()->getRow();
        if (! $role) {
            return;
        }

        $exists = $db->table('smoke_user_roles')
            ->where('user_id', $userId)
            ->where('role_id', $role->id)
            ->countAllResults() > 0;

        if ($exists) {
            return;
        }

        $db->table('smoke_user_roles')->insert([
            'user_id' => $userId,
            'role_id' => $role->id,
        ]);
    }
}
