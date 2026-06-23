<?php

namespace App\Controllers;

use CodeIgniter\HTTP\ResponseInterface;
use Config\Database;
use Config\Products;
use Config\Services;

class TargetProfilesController extends BaseController
{
    private const ENVIRONMENTS = [
        'sandbox', 'gh_staging', 'production_readonly', 'production_restricted',
    ];

    public function index(): ResponseInterface
    {
        $db = Database::connect();
        $rows = $db->table('smoke_target_profiles')
            ->select('id, profile_name, product_name, environment, base_url, login_url, username,
                      observer_mode, read_only, production_restriction, allow_safe_demo, status,
                      created_by, updated_by, created_at, updated_at')
            ->where('status !=', 'archived')
            ->orderBy('product_name', 'ASC')
            ->orderBy('profile_name', 'ASC')
            ->get()
            ->getResultArray();
        return $this->jsonOk(['data' => $rows]);
    }

    public function show(int $id): ResponseInterface
    {
        $db = Database::connect();
        $row = $db->table('smoke_target_profiles')->where('id', $id)->get()->getRowArray();
        if (! $row) {
            return $this->jsonError('not_found', 'Target profile not found', 404);
        }
        $row['has_credential'] = $db->table('smoke_credentials')->where('target_profile_id', $id)->countAllResults() > 0;
        return $this->jsonOk(['data' => $row]);
    }

    public function create(): ResponseInterface
    {
        $body = $this->jsonBody();
        $err = $this->validateProfileInput($body, true);
        if ($err) {
            return $this->jsonError('invalid_request', $err, 400);
        }
        $env = (string) $body['environment'];
        $isProd = in_array($env, ['production_readonly', 'production_restricted'], true);

        $row = [
            'profile_name'           => trim((string) $body['profile_name']),
            'product_name'           => (string) $body['product_name'],
            'environment'            => $env,
            'base_url'               => (string) $body['base_url'],
            'login_url'              => (string) $body['login_url'],
            'username'               => (string) $body['username'],
            'allowed_domains'        => json_encode($body['allowed_domains'] ?? []),
            'allowed_modules'        => json_encode($body['allowed_modules'] ?? []),
            'observer_mode'          => (bool) ($body['observer_mode'] ?? true) || $isProd,
            'read_only'              => (bool) ($body['read_only'] ?? true) || $isProd,
            'production_restriction' => $isProd || (bool) ($body['production_restriction'] ?? true),
            'allow_safe_demo'        => $isProd ? false : (bool) ($body['allow_safe_demo'] ?? false),
            'ip_restriction'         => json_encode($body['ip_restriction'] ?? []),
            'login_strategy'         => (string) ($body['login_strategy'] ?? 'standard'),
            'extra_config'           => json_encode($body['extra_config'] ?? null),
            'status'                 => (string) ($body['status'] ?? 'active'),
            'created_by'             => $this->user()?->id,
            'updated_by'             => $this->user()?->id,
        ];
        $db = Database::connect();
        $db->table('smoke_target_profiles')->insert($row);
        $id = (int) $db->insertID();

        $plaintext = (string) ($body['password'] ?? '');
        if ($plaintext !== '') {
            Services::vault()->storeForProfile($id, $plaintext, 'password', $this->user()?->id);
        }
        Services::audit()->record('target_profiles.create', 'smoke_target_profiles', (string) $id, $this->user()?->id, [
            'profile_name' => $row['profile_name'],
            'product'      => $row['product_name'],
            'environment'  => $row['environment'],
        ]);
        return $this->jsonOk(['id' => $id], 201);
    }

    public function update(int $id): ResponseInterface
    {
        $db = Database::connect();
        $existing = $db->table('smoke_target_profiles')->where('id', $id)->get()->getRow();
        if (! $existing) {
            return $this->jsonError('not_found', 'Profile not found', 404);
        }
        $body = $this->jsonBody();
        $err = $this->validateProfileInput($body, false);
        if ($err) {
            return $this->jsonError('invalid_request', $err, 400);
        }

        $env = (string) ($body['environment'] ?? $existing->environment);
        $isProd = in_array($env, ['production_readonly', 'production_restricted'], true);

        $patch = array_filter([
            'profile_name'           => $body['profile_name']   ?? null,
            'product_name'           => $body['product_name']   ?? null,
            'environment'            => $body['environment']    ?? null,
            'base_url'               => $body['base_url']       ?? null,
            'login_url'              => $body['login_url']      ?? null,
            'username'               => $body['username']       ?? null,
            'login_strategy'         => $body['login_strategy'] ?? null,
            'status'                 => $body['status']         ?? null,
        ], static fn($v) => $v !== null && $v !== '');

        if (array_key_exists('allowed_domains', $body))  { $patch['allowed_domains']  = json_encode($body['allowed_domains'] ?? []); }
        if (array_key_exists('allowed_modules', $body))  { $patch['allowed_modules']  = json_encode($body['allowed_modules'] ?? []); }
        if (array_key_exists('ip_restriction', $body))   { $patch['ip_restriction']   = json_encode($body['ip_restriction'] ?? []); }
        if (array_key_exists('extra_config', $body))     { $patch['extra_config']     = json_encode($body['extra_config']); }
        if (array_key_exists('observer_mode', $body))    { $patch['observer_mode']    = (bool) $body['observer_mode'] || $isProd; }
        if (array_key_exists('read_only', $body))        { $patch['read_only']        = (bool) $body['read_only'] || $isProd; }
        if (array_key_exists('production_restriction', $body)) { $patch['production_restriction'] = (bool) $body['production_restriction'] || $isProd; }
        if (array_key_exists('allow_safe_demo', $body))  { $patch['allow_safe_demo']  = $isProd ? false : (bool) $body['allow_safe_demo']; }

        $patch['updated_by'] = $this->user()?->id;
        $patch['updated_at'] = date('Y-m-d H:i:s');

        $db->table('smoke_target_profiles')->where('id', $id)->update($patch);

        if (array_key_exists('password', $body) && $body['password'] !== '') {
            Services::vault()->storeForProfile($id, (string) $body['password'], 'password', $this->user()?->id);
        }

        Services::audit()->record('target_profiles.update', 'smoke_target_profiles', (string) $id, $this->user()?->id, [
            'fields' => array_keys($patch),
        ]);
        return $this->jsonOk(['ok' => true]);
    }

    public function delete(int $id): ResponseInterface
    {
        Database::connect()->table('smoke_target_profiles')->where('id', $id)->update(['status' => 'archived']);
        Services::audit()->record('target_profiles.archive', 'smoke_target_profiles', (string) $id, $this->user()?->id);
        return $this->jsonOk(['ok' => true]);
    }

    private function validateProfileInput(array $body, bool $strict): ?string
    {
        if ($strict) {
            foreach (['profile_name', 'product_name', 'environment', 'base_url', 'login_url', 'username'] as $f) {
                if (empty($body[$f])) {
                    return "Field {$f} is required";
                }
            }
        }
        if (! empty($body['product_name']) && ! in_array($body['product_name'], Products::slugs(), true)) {
            return 'Unknown product_name';
        }
        if (! empty($body['environment']) && ! in_array($body['environment'], self::ENVIRONMENTS, true)) {
            return 'Unknown environment (must be one of ' . implode(', ', self::ENVIRONMENTS) . ')';
        }
        foreach (['base_url', 'login_url'] as $u) {
            if (! empty($body[$u]) && ! filter_var($body[$u], FILTER_VALIDATE_URL)) {
                return "{$u} must be a valid URL";
            }
        }
        return null;
    }
}
