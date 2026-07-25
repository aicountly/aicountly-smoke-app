<?php

namespace App\Services\Settings;

use Config\Database;

/**
 * Tiny typed reader for smoke_settings key/value pairs.
 */
class SettingsStore
{
    public function get(string $key, mixed $default = null): mixed
    {
        $row = Database::connect()->table('smoke_settings')->where('key', $key)->get()->getRow();
        if (! $row) {
            return $default;
        }
        $decoded = json_decode((string) $row->value_json, true);
        if (json_last_error() !== JSON_ERROR_NONE) {
            return $row->value_json;
        }
        return $decoded;
    }

    public function getString(string $key, string $default = ''): string
    {
        $v = $this->get($key, $default);
        return is_string($v) ? $v : $default;
    }

    /** @return list<string> */
    public function getStringList(string $key, array $default = []): array
    {
        $v = $this->get($key, $default);
        if (! is_array($v)) {
            return $default;
        }
        $out = [];
        foreach ($v as $item) {
            if (is_string($item) && $item !== '') {
                $out[] = strtolower($item);
            }
        }
        return $out !== [] ? $out : $default;
    }

    public function getInt(string $key, int $default = 0): int
    {
        $v = $this->get($key, $default);
        return is_numeric($v) ? (int) $v : $default;
    }
}
