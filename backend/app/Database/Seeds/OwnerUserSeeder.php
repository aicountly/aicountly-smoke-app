<?php

namespace App\Database\Seeds;

use CodeIgniter\Database\Seeder;

class OwnerUserSeeder extends Seeder
{
    public function run(): void
    {
        $db = \Config\Database::connect();

        $email = 'owner@aicountly.local';
        $existing = $db->table('smoke_users')->where('email', $email)->get()->getRow();

        if ($existing === null) {
            $db->table('smoke_users')->insert([
                'email'         => $email,
                'password_hash' => password_hash('ChangeMe!2026', PASSWORD_BCRYPT),
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
