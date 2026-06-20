<?php

namespace App\Controllers;

use CodeIgniter\HTTP\ResponseInterface;
use Config\Database;
use Config\Services;

class SettingsController extends BaseController
{
    public function index(): ResponseInterface
    {
        $rows = Database::connect()->table('smoke_settings')->orderBy('key', 'ASC')->get()->getResultArray();
        // Mask secrets
        foreach ($rows as &$r) {
            if ((bool) $r['is_secret']) {
                $r['value_json'] = json_encode('***');
            }
        }
        return $this->jsonOk(['data' => $rows]);
    }

    public function update(string $key): ResponseInterface
    {
        $body = $this->jsonBody();
        if (! array_key_exists('value', $body)) {
            return $this->jsonError('invalid_request', 'value is required', 400);
        }
        $db = Database::connect();
        $existing = $db->table('smoke_settings')->where('key', $key)->get()->getRow();
        $patch = [
            'value_json' => json_encode($body['value']),
            'updated_by' => $this->user()?->id,
            'updated_at' => date('Y-m-d H:i:s'),
        ];
        if ($existing) {
            $db->table('smoke_settings')->where('key', $key)->update($patch);
        } else {
            $db->table('smoke_settings')->insert(array_merge($patch, [
                'key'        => $key,
                'description'=> (string) ($body['description'] ?? ''),
                'is_secret'  => (bool) ($body['is_secret'] ?? false),
            ]));
        }
        Services::audit()->record('settings.update', 'smoke_settings', $key, $this->user()?->id);
        return $this->jsonOk(['ok' => true]);
    }
}
