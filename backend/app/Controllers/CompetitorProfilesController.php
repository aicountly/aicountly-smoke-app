<?php

namespace App\Controllers;

use CodeIgniter\HTTP\ResponseInterface;
use Config\Database;
use Config\Services;

class CompetitorProfilesController extends BaseController
{
    public function index(): ResponseInterface
    {
        $db = Database::connect();
        $q  = $db->table('smoke_competitor_profiles');
        if ($p = $this->request->getGet('product_name')) {
            $q->where('product_name', $p);
        }
        if ($e = $this->request->getGet('enabled')) {
            $q->where('enabled', in_array($e, ['1', 'true', 'yes'], true) ? 'true' : 'false');
        }
        $rows = $q->orderBy('product_name', 'ASC')->orderBy('competitor_name', 'ASC')->get()->getResultArray();
        return $this->jsonOk(['data' => $rows]);
    }

    public function create(): ResponseInterface
    {
        $body = $this->jsonBody();
        foreach (['product_name', 'competitor_name'] as $f) {
            if (empty($body[$f])) {
                return $this->jsonError('invalid_request', "{$f} is required", 400);
            }
        }
        $db = Database::connect();
        $row = [
            'product_name'      => (string) $body['product_name'],
            'competitor_name'   => (string) $body['competitor_name'],
            'feature_list_json' => json_encode($body['features'] ?? []),
            'source_url'        => (string) ($body['source_url'] ?? ''),
            'enabled'           => (bool) ($body['enabled'] ?? true),
            'notes'             => (string) ($body['notes'] ?? ''),
        ];
        $db->table('smoke_competitor_profiles')->insert($row);
        $id = (int) $db->insertID();
        Services::audit()->record('competitors.create', 'smoke_competitor_profiles', (string) $id, $this->user()?->id, [
            'product' => $row['product_name'],
            'name'    => $row['competitor_name'],
        ]);
        return $this->jsonOk(['id' => $id], 201);
    }

    public function update(int $id): ResponseInterface
    {
        $body = $this->jsonBody();
        $patch = array_filter([
            'product_name'    => $body['product_name']    ?? null,
            'competitor_name' => $body['competitor_name'] ?? null,
            'source_url'      => $body['source_url']      ?? null,
            'notes'           => $body['notes']           ?? null,
        ], static fn($v) => $v !== null);
        if (array_key_exists('features', $body)) $patch['feature_list_json'] = json_encode($body['features']);
        if (array_key_exists('enabled', $body))  $patch['enabled']           = (bool) $body['enabled'];
        if ($patch === []) {
            return $this->jsonError('invalid_request', 'Nothing to update', 400);
        }
        $patch['updated_at'] = date('Y-m-d H:i:s');
        Database::connect()->table('smoke_competitor_profiles')->where('id', $id)->update($patch);
        Services::audit()->record('competitors.update', 'smoke_competitor_profiles', (string) $id, $this->user()?->id, ['fields' => array_keys($patch)]);
        return $this->jsonOk(['ok' => true]);
    }

    public function delete(int $id): ResponseInterface
    {
        Database::connect()->table('smoke_competitor_profiles')->where('id', $id)->delete();
        Services::audit()->record('competitors.delete', 'smoke_competitor_profiles', (string) $id, $this->user()?->id);
        return $this->jsonOk(['ok' => true]);
    }
}
