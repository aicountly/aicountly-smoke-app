<?php

namespace App\Controllers;

use CodeIgniter\HTTP\ResponseInterface;
use Config\Database;
use Config\Services;

class CredentialsController extends BaseController
{
    public function store(int $profileId): ResponseInterface
    {
        return $this->upsert($profileId, 'credentials.store');
    }

    public function rotate(int $profileId): ResponseInterface
    {
        return $this->upsert($profileId, 'credentials.rotate');
    }

    private function upsert(int $profileId, string $auditAction): ResponseInterface
    {
        $db = Database::connect();
        if ($db->table('smoke_target_profiles')->where('id', $profileId)->countAllResults() === 0) {
            return $this->jsonError('not_found', 'Profile not found', 404);
        }
        $body = $this->jsonBody();
        $pt = (string) ($body['password'] ?? $body['plaintext'] ?? '');
        $kind = (string) ($body['kind'] ?? 'password');
        if ($pt === '' || strlen($pt) > 4096) {
            return $this->jsonError('invalid_request', 'password is required and must be <= 4096 chars', 400);
        }
        $id = Services::vault()->storeForProfile($profileId, $pt, $kind, $this->user()?->id);
        // immediately scrub the variable
        $pt = str_repeat("\0", strlen($pt));
        unset($pt);

        Services::audit()->record($auditAction, 'smoke_credentials', (string) $id, $this->user()?->id, [
            'target_profile_id' => $profileId,
            'kind'              => $kind,
        ]);
        return $this->jsonOk(['id' => $id, 'rotated_at' => date(DATE_ATOM)]);
    }
}
