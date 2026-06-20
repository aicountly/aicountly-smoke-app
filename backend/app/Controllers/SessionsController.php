<?php

namespace App\Controllers;

use CodeIgniter\HTTP\ResponseInterface;
use Config\Database;
use Config\Services;

class SessionsController extends BaseController
{
    public function update(int $id): ResponseInterface
    {
        $body = $this->jsonBody();
        $patch = array_filter([
            'name'        => $body['name']        ?? null,
            'menu_path'   => $body['menu_path']   ?? null,
            'description' => $body['description'] ?? null,
        ], static fn($v) => $v !== null);
        if (array_key_exists('scope', $body))               { $patch['scope_json'] = json_encode($body['scope']); }
        if (array_key_exists('allowed_actions', $body))     { $patch['allowed_actions_json'] = json_encode($body['allowed_actions']); }
        if (array_key_exists('destructive_allowed', $body)) { $patch['destructive_allowed']  = (bool) $body['destructive_allowed']; }
        if (array_key_exists('expected_screens', $body))    { $patch['expected_screens']     = (int) $body['expected_screens']; }
        if ($patch === []) {
            return $this->jsonError('invalid_request', 'Nothing to update.', 400);
        }
        $patch['updated_at'] = date('Y-m-d H:i:s');
        Database::connect()->table('smoke_sessions')->where('id', $id)->update($patch);
        Services::audit()->record('sessions.update', 'smoke_sessions', (string) $id, $this->user()?->id, ['fields' => array_keys($patch)]);
        return $this->jsonOk(['ok' => true]);
    }

    public function split(int $id): ResponseInterface
    {
        $db = Database::connect();
        $session = $db->table('smoke_sessions')->where('id', $id)->get()->getRow();
        if (! $session) {
            return $this->jsonError('not_found', 'Session not found', 404);
        }
        $body = $this->jsonBody();
        $newName = trim((string) ($body['new_name'] ?? ($session->name . ' (split)')));
        $newScreens = max(1, (int) ($body['new_expected_screens'] ?? max(1, (int) ($session->expected_screens / 2))));

        $db->table('smoke_sessions')->insert([
            'plan_id'             => $session->plan_id,
            'ordinal'             => (int) $session->ordinal + 1,
            'name'                => $newName,
            'menu_path'           => $session->menu_path,
            'description'         => $session->description,
            'scope_json'          => $session->scope_json,
            'allowed_actions_json'=> $session->allowed_actions_json,
            'destructive_allowed' => (bool) $session->destructive_allowed,
            'expected_screens'    => $newScreens,
            'status'              => 'pending',
        ]);
        $newId = (int) $db->insertID();

        $db->query("UPDATE smoke_sessions SET ordinal = ordinal + 1 WHERE plan_id = ? AND ordinal > ? AND id <> ?", [
            $session->plan_id, $session->ordinal, $newId,
        ]);

        Services::audit()->record('sessions.split', 'smoke_sessions', (string) $id, $this->user()?->id, ['new_id' => $newId]);
        return $this->jsonOk(['new_id' => $newId], 201);
    }

    public function merge(int $id): ResponseInterface
    {
        $body  = $this->jsonBody();
        $other = (int) ($body['merge_with'] ?? 0);
        if ($other <= 0 || $other === $id) {
            return $this->jsonError('invalid_request', 'merge_with must be a different session id', 400);
        }
        $db = Database::connect();
        $a = $db->table('smoke_sessions')->where('id', $id)->get()->getRow();
        $b = $db->table('smoke_sessions')->where('id', $other)->get()->getRow();
        if (! $a || ! $b || $a->plan_id !== $b->plan_id) {
            return $this->jsonError('invalid_request', 'Both sessions must belong to the same plan', 400);
        }
        $db->table('smoke_sessions')->where('id', $id)->update([
            'name'             => $a->name . ' + ' . $b->name,
            'description'      => trim(($a->description ?? '') . "\n---\n" . ($b->description ?? '')),
            'expected_screens' => (int) $a->expected_screens + (int) $b->expected_screens,
            'updated_at'       => date('Y-m-d H:i:s'),
        ]);
        $db->table('smoke_sessions')->where('id', $other)->delete();
        Services::audit()->record('sessions.merge', 'smoke_sessions', (string) $id, $this->user()?->id, ['merged_with' => $other]);
        return $this->jsonOk(['ok' => true]);
    }

    public function delete(int $id): ResponseInterface
    {
        Database::connect()->table('smoke_sessions')->where('id', $id)->delete();
        Services::audit()->record('sessions.delete', 'smoke_sessions', (string) $id, $this->user()?->id);
        return $this->jsonOk(['ok' => true]);
    }
}
