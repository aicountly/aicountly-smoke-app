<?php

namespace App\Services\Vault;

use CodeIgniter\Database\RawSql;
use Config\Database;
use RuntimeException;

/**
 * AES-256-GCM credential vault for target-app secrets.
 *
 *   master_key     : 32 bytes (read from SMOKE_VAULT_KEY as 64 hex chars)
 *   nonce          : 12 random bytes per record
 *   auth_tag       : 16 bytes returned by openssl_encrypt
 *   key_version    : column for forward-looking master-key rotation
 *
 * Plaintext is NEVER cached, logged, or returned anywhere outside the worker
 * decrypt endpoint. The encrypt path is reachable from the portal; the decrypt
 * path must only be hit by the worker (gated by WorkerTokenFilter).
 */
class CredentialVault
{
    private const AAD = 'smoke.aicountly.org/v1/vault';

    private string $key;
    private int $version;

    public function __construct()
    {
        $hex = (string) env('SMOKE_VAULT_KEY', '');
        if (! ctype_xdigit($hex) || strlen($hex) !== 64) {
            throw new RuntimeException('SMOKE_VAULT_KEY must be exactly 64 hex chars (32 raw bytes).');
        }
        $key = hex2bin($hex);
        if ($key === false || strlen($key) !== 32) {
            throw new RuntimeException('SMOKE_VAULT_KEY hex decoding failed.');
        }
        $this->key     = $key;
        $this->version = (int) env('SMOKE_VAULT_KEY_VERSION', 1);
    }

    /** @return array{ciphertext:string,nonce:string,auth_tag:string,key_version:int} */
    public function encrypt(string $plaintext): array
    {
        $nonce = random_bytes(12);
        $tag   = '';
        $ct = openssl_encrypt(
            $plaintext,
            'aes-256-gcm',
            $this->key,
            OPENSSL_RAW_DATA,
            $nonce,
            $tag,
            self::AAD,
            16,
        );
        if ($ct === false) {
            throw new RuntimeException('openssl_encrypt failed');
        }
        return [
            'ciphertext'  => $ct,
            'nonce'       => $nonce,
            'auth_tag'    => $tag,
            'key_version' => $this->version,
        ];
    }

    public function decrypt(string $ciphertext, string $nonce, string $authTag, int $keyVersion = 1): string
    {
        // Forward-compat: today we only have one version; reject mismatches.
        if ($keyVersion !== $this->version) {
            throw new RuntimeException("Vault key version mismatch (record={$keyVersion}, server={$this->version})");
        }
        $pt = openssl_decrypt(
            $ciphertext,
            'aes-256-gcm',
            $this->key,
            OPENSSL_RAW_DATA,
            $nonce,
            $authTag,
            self::AAD,
        );
        if ($pt === false) {
            throw new RuntimeException('openssl_decrypt failed (auth tag mismatch?)');
        }
        return $pt;
    }

    public function storeForProfile(int $targetProfileId, string $plaintext, string $kind = 'password', ?int $createdBy = null): int
    {
        $bundle = $this->encrypt($plaintext);
        $db = Database::connect();
        $existing = $db->table('smoke_credentials')->where('target_profile_id', $targetProfileId)->get()->getRow();
        $row = [
            'target_profile_id' => $targetProfileId,
            'ciphertext'        => $this->pgByteaLiteral($bundle['ciphertext']),
            'nonce'             => $this->pgByteaLiteral($bundle['nonce']),
            'auth_tag'          => $this->pgByteaLiteral($bundle['auth_tag']),
            'key_version'       => $bundle['key_version'],
            'kind'              => $kind,
            'rotated_at'        => date('Y-m-d H:i:s'),
            'created_by'        => $createdBy,
        ];
        if ($existing) {
            $db->table('smoke_credentials')->where('id', $existing->id)->update(array_merge($row, [
                'updated_at' => date('Y-m-d H:i:s'),
            ]));
            return (int) $existing->id;
        }
        $db->table('smoke_credentials')->insert($row);
        return (int) $db->insertID();
    }

    public function decryptForProfile(int $targetProfileId): ?string
    {
        $db = Database::connect();
        $row = $db->table('smoke_credentials')->where('target_profile_id', $targetProfileId)->get()->getRow();
        if (! $row) {
            return null;
        }
        return $this->decrypt(
            $this->readBinary($row->ciphertext),
            $this->readBinary($row->nonce),
            $this->readBinary($row->auth_tag),
            (int) $row->key_version,
        );
    }

    /** PostgreSQL BYTEA hex literal — CI4 pg_escape_literal rejects raw binary. */
    private function pgByteaLiteral(string $bytes): RawSql
    {
        return new RawSql("'\\x" . bin2hex($bytes) . "'");
    }

    private function readBinary(mixed $value): string
    {
        if (is_resource($value)) {
            $value = stream_get_contents($value);
        }
        $value = (string) $value;
        if (str_starts_with($value, '\\x')) {
            $decoded = hex2bin(substr($value, 2));
            if ($decoded !== false) {
                return $decoded;
            }
        }
        return $value;
    }
}
