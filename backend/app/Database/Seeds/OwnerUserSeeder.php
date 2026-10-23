<?php

namespace App\Database\Seeds;

use CodeIgniter\Database\Seeder;

class OwnerUserSeeder extends Seeder
{
    public static function initialPassword(): string
    {
        $fromEnv = (string) (getenv('SMOKE_OWNER_PASSWORD') ?: '');

        return strlen($fromEnv) >= 12 ? $fromEnv : bin2hex(random_bytes(24));
    }

    public function run(): void
    {
        $db = \Config\Database::connect();

        $email = 'owner@aicountly.local';
        $existing = $db->table('smoke_users')->where('email', $email)->get()->getRow();

        if ($existing === null) {
            $db->table('smoke_users')->insert([
                'email'         => $email,
                // No shared default password: SMOKE_OWNER_PASSWORD, or a random one nobody knows
                // (sign-in is through Console SSO; local login is disabled).
                'password_hash' => password_hash(self::initialPassword(), PASSWORD_BCRYPT),
                'full_name'     => 'Initial Owner',
                'status'        => 'active',
                'must_rotate_pw'=> true,
            ]);
            $userId = (int) $db->insertID();
        } else {
            $userId = (int) $existing->id;
        }

        $ownerRole = $db->table('smoke_roles')->where('code', 'owner')->get()->getRow();
        if ($ownerRole !== null) {
            $hasRole = $db->table('smoke_user_roles')
                ->where('user_id', $userId)
                ->where('role_id', $ownerRole->id)
                ->countAllResults();
            if ($hasRole === 0) {
                $db->table('smoke_user_roles')->insert([
                    'user_id' => $userId,
                    'role_id' => $ownerRole->id,
                ]);
            }
        }
    }
}
